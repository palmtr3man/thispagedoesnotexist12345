/**
 * notifyTaskFailure — Sends an admin alert email when a scheduled task fails.
 * Called internally by other functions; not exposed as a public endpoint.
 *
 * Expected payload: { task, error, details? }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { firstRequiredEnv } from './shared/config.ts';
import { auditInvocation, requireInternalToken } from './shared/invocationGuard.ts';
import { ENV_ALIASES } from './shared/platformSecrets.ts';

const TASK_FAILURE_EMAIL = firstRequiredEnv(...ENV_ALIASES.taskFailureAlertEmail);

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

Deno.serve(async (req) => {
  const guard = requireInternalToken(req);
  if (!guard.ok) return guard.response;
  auditInvocation('notifyTaskFailure', guard);

  const base44 = createClientFromRequest(req);

  const body = await req.json().catch(() => ({}));
  const { task = 'Unknown Task', error = 'Unknown error', details = null } = body;

  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const subject = `🚨 TUJ Task Failure: ${task}`;
  const detailsHtml = details
    ? `<pre style="background:#1a0000;color:#ff8888;padding:12px;border-radius:6px;font-size:13px;overflow:auto">${escapeHtml(JSON.stringify(details, null, 2))}</pre>`
    : '';

  const html = `
    <div style="font-family:monospace;background:#0a0a0a;color:#e2e8f0;padding:24px;border-radius:8px;max-width:600px">
      <div style="background:#3a0a0a;border:1px solid #ff537055;border-radius:8px;padding:16px;margin-bottom:20px">
        <p style="color:#ff5370;font-size:18px;font-weight:bold;margin:0 0 4px">🚨 Task Failure Alert</p>
        <p style="color:#888;font-size:12px;margin:0">${escapeHtml(ts)} ET</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr>
          <td style="color:#4a6a7a;font-size:12px;padding:6px 0;width:100px">Task</td>
          <td style="color:#64ffda;font-weight:bold">${escapeHtml(task)}</td>
        </tr>
        <tr>
          <td style="color:#4a6a7a;font-size:12px;padding:6px 0">Error</td>
          <td style="color:#ff5370">${escapeHtml(error)}</td>
        </tr>
      </table>
      ${detailsHtml}
      <p style="color:#2a4a5a;font-size:11px;margin-top:20px">
        Sent by The Ultimate Journey · automated task monitor
      </p>
    </div>
  `;

  try {
    await base44.asServiceRole.integrations.Core.SendEmail({
      to: TASK_FAILURE_EMAIL,
      subject,
      body: html,
      from_name: 'TUJ Task Monitor',
    });
  } catch (sendErr) {
    const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
    console.error('[notifyTaskFailure] SendEmail failed:', message);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }

  return Response.json({ ok: true, notified: TASK_FAILURE_EMAIL, task });
});
