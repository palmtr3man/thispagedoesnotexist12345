/**
 * handleSeatOpened — Boarding email sequence when a Seat is activated.
 *
 * Triggered when a Seat entity opens (admin approval, Ready-click, or seat-activate).
 * Dispatches the dual boarding sequence based on cabin / boarding path:
 *   - Economy / free:  boarding_pass_free_v1 → boarding_instructions_free_v1
 *   - First / paid:    boarding_pass_paid_v1 → boarding_instructions_paid_v1
 *   - VIP cohort:      vip_boarding_pass_v1 → vip_boarding_instructions_v1
 *   - Alpha legacy:    alphaflightannouncement_v1 → boarding_confirmation_v1
 *
 * After both sends confirm 2xx, stamps boarding_confirmation_sent_at on the Seat
 * entity. Idempotent: skips if already stamped or dispatch lease is active.
 *
 * Netlify parity: POST /api/sendgrid-integration → netlify/functions/sendgrid-integration.js
 *
 * Payload: full Seat entity record in JSON body.
 * Auth: SEC06_INTERNAL_TOKEN via x-internal-token or Authorization Bearer.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { sendSeatConfirmation } from './boardingDispatch.ts';
import { auditRequestId, writeAuditLog } from './shared/auditLog.ts';
import { auditInvocation, requireInternalToken } from './shared/invocationGuard.ts';
import {
  type SeatRecord,
  resolveSeatId,
  resolveTujCode,
} from './sendgridTemplateData.ts';

export { sendSeatConfirmation, type SendSeatConfirmationResult } from './boardingDispatch.ts';

Deno.serve(async (req) => {
  const requestId = auditRequestId(req);
  const guard = requireInternalToken(req);
  if (!guard.ok) return guard.response;
  auditInvocation('handleSeatOpened', guard);

  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let seat: SeatRecord;
  try {
    seat = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!seat || (!seat.id && !seat.seat_id && !seat.tuj_code)) {
    return Response.json({ ok: false, error: 'Missing seat.id or tuj_code in request body' }, { status: 400 });
  }

  const base44 = createClientFromRequest(req);

  try {
    const result = await sendSeatConfirmation(base44, seat);

    if (!result.success) {
      await writeAuditLog(base44, {
        eventName: 'boarding.sequence_failed',
        operationType: 'email_dispatch',
        requestId,
        targetEntity: 'Seat',
        targetId: resolveSeatId(seat),
        outcome: 'failure',
        errorMessage: result.error,
        metadata: { path: result.path, tuj_code: resolveTujCode(seat, resolveSeatId(seat)) },
      });
      return Response.json({ ok: false, error: result.error, path: result.path }, { status: 502 });
    }

    await writeAuditLog(base44, {
      eventName: result.skipped ? 'boarding.sequence_skipped' : 'boarding.sequence_sent',
      operationType: 'email_dispatch',
      requestId,
      targetEntity: 'Seat',
      targetId: resolveSeatId(seat),
      outcome: 'success',
      metadata: {
        skipped: Boolean(result.skipped),
        dry_run: Boolean(result.dryRun),
        path: result.path,
        tuj_code: resolveTujCode(seat, resolveSeatId(seat)),
      },
    });

    return Response.json({
      ok: true,
      skipped: result.skipped || false,
      dry_run: result.dryRun || false,
      path: result.path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[handleSeatOpened] Error:', message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
