/**
 * gmailJobScanner — Gmail Pub/Sub push handler for job-search email classification.
 *
 * Watches Gmail history for new messages, classifies application / interview /
 * rejection emails, and upserts Application records.
 *
 * Auth: Google Pub/Sub push JWT (verified via tokeninfo) or SEC06_INTERNAL_TOKEN.
 * Required env: GMAIL_PUBSUB_AUDIENCE (optional but recommended), SEC06_INTERNAL_TOKEN.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { auditInvocation, requireGmailPubSubOrInternalToken } from './shared/invocationGuard.ts';

type EmailType = 'rejection' | 'interview' | 'application';

function classifyEmail(subject: string, snippet: string, labels: Array<{ name?: string }>): EmailType | null {
  const text = `${subject} ${snippet}`.toLowerCase();
  const labelNames = (labels || []).map((l) => l.name?.toLowerCase() || '');

  const isRejectionLabel = labelNames.some((l) => l.includes('rejection') || l.includes('rejected'));
  if (
    isRejectionLabel ||
    /unfortunately|not moving forward|other candidate|not selected|not be moving|regret to inform|position has been filled/i.test(text)
  ) {
    return 'rejection';
  }

  if (/interview|phone screen|technical screen|hiring manager|zoom|teams meeting|google meet|schedule a call|next step|video call/i.test(text)) {
    return 'interview';
  }

  const isApplicationLabel = labelNames.some(
    (l) =>
      l.includes('application received') ||
      l.includes('applications received') ||
      l.includes('application confirmation') ||
      l.includes('applied'),
  );
  if (
    isApplicationLabel ||
    /thank you for applying|application received|application confirmed|we received your application|successfully applied|your application for|applied to/i.test(text)
  ) {
    return 'application';
  }

  return null;
}

function extractCompany(from: string, _subject: string): string {
  const fromName = from
    .replace(/<.*>/, '')
    .trim()
    .replace(/careers at |hiring at |talent at |recruiting at /i, '')
    .trim();
  if (fromName && fromName.length < 60 && !fromName.includes('@')) return fromName;

  const emailMatch = from.match(/@([\w.-]+)/);
  if (emailMatch) {
    const domain = emailMatch[1].split('.').slice(-2, -1)[0];
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  }

  return 'Unknown Company';
}

function extractJobTitle(subject: string): string {
  const patterns = [
    /(?:application for|applied for|interview for|role of|position of|your application[:\s-]+)\s*(.+?)(?:\s+at\s+|\s*[-–|]\s*|$)/i,
    /^(.+?)\s*[-–|]\s*(?:application|interview|position)/i,
  ];
  for (const p of patterns) {
    const m = subject.match(p);
    if (m?.[1] && m[1].length < 80) return m[1].trim();
  }
  return subject.substring(0, 60);
}

function decodePubSubMessage(body: unknown): { historyId: string } | null {
  const envelope = body as { data?: { message?: { data?: string } }; message?: { data?: string } };
  const encoded = envelope?.data?.message?.data ?? envelope?.message?.data;
  if (!encoded) return null;

  try {
    const decoded = JSON.parse(atob(encoded));
    if (!decoded?.historyId) return null;
    return { historyId: String(decoded.historyId) };
  } catch (_) {
    return null;
  }
}

Deno.serve(async (req) => {
  const guard = await requireGmailPubSubOrInternalToken(req);
  if (!guard.ok) return guard.response;
  auditInvocation('gmailJobScanner', guard);

  const base44 = createClientFromRequest(req);
  const body = await req.json();
  const pubSub = decodePubSubMessage(body);
  if (!pubSub) {
    return Response.json({ status: 'invalid_pubsub_payload' }, { status: 400 });
  }
  const currentHistoryId = pubSub.historyId;

  const { accessToken } = await base44.asServiceRole.connectors.getConnection('gmail');
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  const labelsRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: authHeader });
  const labelsData = labelsRes.ok ? await labelsRes.json() : { labels: [] };
  const labelMap: Record<string, string> = {};
  for (const lbl of labelsData.labels || []) {
    labelMap[lbl.id] = lbl.name?.toLowerCase() || '';
  }

  const syncRecords = await base44.asServiceRole.entities.GmailSyncState.list();
  const syncRecord = syncRecords.length > 0 ? syncRecords[0] : null;

  if (!syncRecord) {
    await base44.asServiceRole.entities.GmailSyncState.create({
      history_id: currentHistoryId,
      last_synced_at: new Date().toISOString(),
    });
    return Response.json({ status: 'initialized' });
  }

  const prevHistoryId = syncRecord.history_id;
  const historyRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${prevHistoryId}&historyTypes=messageAdded`,
    { headers: authHeader },
  );

  if (!historyRes.ok) {
    const err = await historyRes.text();
    console.error('History fetch error:', err);

    // Gmail drops expired history IDs — reset cursor so the next push re-initializes.
    if (historyRes.status === 404 && syncRecord.id) {
      await base44.asServiceRole.entities.GmailSyncState.update(syncRecord.id, {
        history_id: currentHistoryId,
        last_synced_at: new Date().toISOString(),
      });
      return Response.json({ status: 'history_reset', history_id: currentHistoryId });
    }

    return Response.json({ status: 'history_error', error: err });
  }

  const historyData = await historyRes.json();
  const historyItems = historyData.history || [];
  let processed = 0;

  for (const item of historyItems) {
    const messages = item.messagesAdded || [];
    for (const { message } of messages) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: authHeader },
      );
      if (!msgRes.ok) continue;

      const msg = await msgRes.json();
      const headers = msg.payload?.headers || [];
      const subject = headers.find((h: { name: string }) => h.name === 'Subject')?.value || '';
      const from = headers.find((h: { name: string }) => h.name === 'From')?.value || '';
      const date = headers.find((h: { name: string }) => h.name === 'Date')?.value || '';
      const snippet = msg.snippet || '';
      const labelIds: string[] = msg.labelIds || [];
      const labelObjects = labelIds.map((id) => ({ name: labelMap[id] || id.toLowerCase() }));

      const type = classifyEmail(subject, snippet, labelObjects);
      if (!type) continue;

      const company = extractCompany(from, subject);
      const jobTitle = extractJobTitle(subject);
      const emailDate = date
        ? new Date(date).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      if (type === 'application') {
        const existing = await base44.asServiceRole.entities.Application.filter({
          company,
          job_title: jobTitle,
        });
        if (existing.length === 0) {
          await base44.asServiceRole.entities.Application.create({
            job_title: jobTitle,
            company,
            status: 'applied',
            pipeline_stage: 'Applied',
            applied_date: emailDate,
            source: 'Gmail Auto-Scan',
            notes: `Auto-detected from email: "${subject}"`,
          });
          processed++;
        }
      } else if (type === 'interview') {
        const existing = await base44.asServiceRole.entities.Application.filter({ company });
        let app = existing.length > 0 ? existing[0] : null;

        if (!app) {
          app = await base44.asServiceRole.entities.Application.create({
            job_title: jobTitle,
            company,
            status: 'interviewing',
            pipeline_stage: 'Interview Scheduled',
            applied_date: emailDate,
            source: 'Gmail Auto-Scan',
            notes: `Auto-detected interview invite: "${subject}"`,
            interviews: [],
          });
        }

        const interviewEntry = {
          date: new Date(date || Date.now()).toISOString(),
          type: 'Interview',
          notes: `Auto-detected from email: "${subject}"`,
        };
        const priorInterviews = Array.isArray(app.interviews) ? app.interviews : [];
        const alreadyLogged = priorInterviews.some(
          (row: { notes?: string }) => row?.notes === interviewEntry.notes,
        );
        if (alreadyLogged) continue;

        await base44.asServiceRole.entities.Application.update(app.id, {
          status: 'interviewing',
          pipeline_stage: 'Interview Scheduled',
          interviews: [...priorInterviews, interviewEntry],
        });
        processed++;
      } else if (type === 'rejection') {
        const existing = await base44.asServiceRole.entities.Application.filter({ company });
        if (existing.length > 0) {
          await base44.asServiceRole.entities.Application.update(existing[0].id, {
            status: 'rejected',
            pipeline_stage: 'Rejected',
            notes: `${existing[0].notes || ''}\nRejection detected from email on ${emailDate}: "${subject}"`.trim(),
          });
          processed++;
        }
      }
    }
  }

  if (syncRecord?.id) {
    try {
      await base44.asServiceRole.entities.GmailSyncState.update(syncRecord.id, {
        history_id: currentHistoryId,
        last_synced_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('Failed to update sync state:', (err as Error).message);
    }
  }

  return Response.json({ status: 'ok', processed });
});
