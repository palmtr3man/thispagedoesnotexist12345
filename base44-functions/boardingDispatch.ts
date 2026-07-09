/**
 * boardingDispatch — Shared boarding email sequence (no HTTP entrypoint).
 *
 * Used by handleSeatOpened (HTTP) and autoPilotBoardingSend (entity automation).
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { optionalEnv, requiredEnv } from './shared/config.ts';
import {
  BCC_EMAIL,
  type BoardingPath,
  type SeatRecord,
  boardingTemplateSequence,
  buildBoardingDynamicData,
  isDispatchLeaseActive,
  resolveBoardingPath,
  resolveBoardingType,
  resolveFirstName,
  resolveLastName,
  resolveRecipient,
  resolveSeatId,
  resolveTemplateId,
  resolveTujCode,
  validateBoardingPayload,
} from './sendgridTemplateData.ts';

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const DRY_RUN = optionalEnv('BOARDING_DRY_RUN') === 'true';

async function sendTemplate(
  apiKey: string,
  fromEmail: string,
  toEmail: string,
  templateId: string,
  dynamicData: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const payload = {
    from: { email: fromEmail },
    personalizations: [{
      to: [{ email: toEmail }],
      bcc: [{ email: BCC_EMAIL }],
      dynamic_template_data: dynamicData,
    }],
    template_id: templateId,
  };

  try {
    const response = await fetch(SENDGRID_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok || response.status === 202) {
      console.log(`[handleSeatOpened] Template ${templateId} sent to ${toEmail} — status ${response.status}`);
      return { ok: true };
    }

    const errorText = await response.text();
    console.error(`[handleSeatOpened] Template ${templateId} failed for ${toEmail} — status ${response.status}:`, errorText);
    return { ok: false, error: errorText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[handleSeatOpened] Template ${templateId} fetch failed for ${toEmail}:`, message);
    return { ok: false, error: message };
  }
}

export interface SendSeatConfirmationResult {
  success: boolean;
  skipped?: boolean;
  dryRun?: boolean;
  error?: string;
  path?: BoardingPath;
}

export async function sendSeatConfirmation(
  base44: ReturnType<typeof createClientFromRequest>,
  seat: SeatRecord,
): Promise<SendSeatConfirmationResult> {
  const apiKey = requiredEnv('SENDGRID_API_KEY');
  const fromEmail = optionalEnv('SENDGRID_FROM_EMAIL') || 'support@thispagedoesnotexist12345.com';

  const seatId = resolveSeatId(seat);
  const tujCode = resolveTujCode(seat, seatId);
  const recipientEmail = resolveRecipient(seat);
  const firstName = resolveFirstName(seat);
  const lastName = resolveLastName(seat);
  const boardingType = resolveBoardingType(seat);
  const boardingPath = resolveBoardingPath(seat);

  const boardingConfirmationSentAt = String(
    seat.boarding_confirmation_sent_at || seat.boardingconfirmationsentat || '',
  ).trim();
  const dispatchStartedAt = String(
    seat.boarding_confirmation_dispatch_started_at || seat.boardingconfirmationdispatchstartedat || '',
  ).trim();

  if (!seatId || !tujCode || !recipientEmail || !firstName || !lastName) {
    console.error(
      `[handleSeatOpened] Seat ${seatId || tujCode || 'unknown'} missing required fields — aborting`,
    );
    return { success: false, error: 'Missing required seat fields', path: boardingPath };
  }

  if (boardingConfirmationSentAt) {
    console.log(
      `[handleSeatOpened] Seat ${seatId} already has boarding_confirmation_sent_at (${boardingConfirmationSentAt}) — skipping`,
    );
    return { success: true, skipped: true, path: boardingPath };
  }

  if (isDispatchLeaseActive(dispatchStartedAt)) {
    console.log(
      `[handleSeatOpened] Seat ${seatId} dispatch lease active (${dispatchStartedAt}) — skipping`,
    );
    return { success: true, skipped: true, path: boardingPath };
  }

  const sequence = boardingTemplateSequence(boardingPath);
  const missingTemplates: string[] = [];
  const resolvedSequence = sequence.map((step) => {
    const templateId = resolveTemplateId(step.key);
    if (!templateId) missingTemplates.push(step.key);
    return { ...step, templateId };
  });

  if (missingTemplates.length) {
    console.error(`[handleSeatOpened] Missing template IDs for keys: ${missingTemplates.join(', ')}`);
    return {
      success: false,
      error: `Missing template env vars: ${missingTemplates.join(', ')}`,
      path: boardingPath,
    };
  }

  const dynamicData = buildBoardingDynamicData(seat, boardingPath);
  const validationErrors = validateBoardingPayload(dynamicData, `seat ${seatId}`);
  if (validationErrors.length) {
    console.error('[handleSeatOpened] Payload validation failed — aborting send:', validationErrors);
    return {
      success: false,
      error: `Payload validation failed: ${validationErrors.join('; ')}`,
      path: boardingPath,
    };
  }

  if (DRY_RUN) {
    console.log('[handleSeatOpened] DRY RUN — payload validated, no email sent:', JSON.stringify({
      seatId,
      tujCode,
      recipientEmail,
      boardingType,
      boardingPath,
      resolvedSequence,
      dynamicData,
    }, null, 2));
    return { success: true, dryRun: true, path: boardingPath };
  }

  const leaseStartedAt = dispatchStartedAt || new Date().toISOString();

  for (const step of resolvedSequence) {
    const result = await sendTemplate(apiKey, fromEmail, recipientEmail, step.templateId, dynamicData);
    if (!result.ok) {
      console.error(`[handleSeatOpened] ${step.label} failed for seat ${seatId} — aborting sequence`);
      return {
        success: false,
        error: `${step.label} send failed${result.error ? `: ${result.error}` : ''}`,
        path: boardingPath,
      };
    }
  }

  const sentAt = new Date().toISOString();
  const recordId = String(seat.id || seat.record_id || seat.seat_record_id || seatId).trim();

  try {
    await base44.asServiceRole.entities.Seat.update(recordId, {
      boarding_confirmation_sent_at: sentAt,
      boardingconfirmationsentat: sentAt,
      boarding_confirmation_dispatch_started_at: leaseStartedAt,
      boardingconfirmationdispatchstartedat: leaseStartedAt,
      boarding_confirmation_dispatch_state: 'sent',
      boardingconfirmationdispatchstate: 'sent',
      tuj_code: tujCode,
      boarding_type: boardingType,
      boardingtype: boardingType,
      seats_reserved: 'F5-04',
    });
    console.log(`[handleSeatOpened] Seat ${recordId} stamped boarding_confirmation_sent_at`);
  } catch (updateErr) {
    const message = updateErr instanceof Error ? updateErr.message : String(updateErr);
    console.warn('[handleSeatOpened] Seat stamp failed (non-fatal):', message);
  }

  return { success: true, path: boardingPath };
}
