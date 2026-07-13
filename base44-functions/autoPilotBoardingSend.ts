/**
 * autoPilotBoardingSend — Entity automation handler
 *
 * Triggered automatically when a Seat record's status changes to 'opened'.
 * Gates on NextFlightConfig.auto_pilot_enabled, then calls sendSeatConfirmation
 * in-process via boardingDispatch.ts.
 *
 * Idempotency: boarding_confirmation_sent_at on the Seat record prevents
 * duplicate sends — boardingDispatch already enforces this.
 *
 * Auth: SEC06_INTERNAL_TOKEN via x-internal-token or Authorization Bearer.
 * Deploy source of truth: career-navigator/base44/functions/autoPilotBoardingSend/
 * Git remote: https://github.com/palmtr3man/career-navigator.git
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { sendSeatConfirmation } from './boardingDispatch.ts';
import { evaluateAutoPilotBoardingSend } from './shared/autoPilotBoardingSend-logic.mjs';
import { auditInvocation, requireInternalToken } from './shared/invocationGuard.ts';
import type { SeatRecord } from './sendgridTemplateData.ts';

Deno.serve(async (req) => {
  const guard = requireInternalToken(req);
  if (!guard.ok) return guard.response;

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { event, data } = body;

    if (!event?.type || !event?.entity_id) {
      return Response.json({ error: 'invalid_automation_payload' }, { status: 400 });
    }

    auditInvocation('autoPilotBoardingSend', guard, {
      event_type: event.type,
      entity_id: event.entity_id,
    });

    const configs = await base44.asServiceRole.entities.NextFlightConfig.list('-created_date', 1);
    const config = configs?.[0];

    let seat = data as SeatRecord | undefined;
    if (!seat || body.payload_too_large) {
      const seats = await base44.asServiceRole.entities.Seat.filter({ id: event.entity_id });
      seat = seats?.[0] as SeatRecord | undefined;
    }

    const decision = evaluateAutoPilotBoardingSend({
      autoPilotEnabled: Boolean(config?.auto_pilot_enabled),
      seat,
      eventEntityId: event.entity_id,
    });

    if (decision.action === 'skip') {
      console.log('[autoPilotBoardingSend] Skipping.', decision);
      return Response.json({ ok: true, skipped: true, reason: decision.reason });
    }

    if (decision.action === 'error') {
      console.error('[autoPilotBoardingSend] Guard failed.', decision.body);
      return Response.json(decision.body, { status: decision.status });
    }

    console.log('[autoPilotBoardingSend] Delegating to sendSeatConfirmation', {
      seat_id: decision.seatPayload.id,
      email: decision.seatPayload.user_email,
      cabin_class: decision.seatPayload.cabin_class,
      boarding_type: decision.seatPayload.boarding_type,
    });

    const result = await sendSeatConfirmation(base44, decision.seatPayload as SeatRecord);

    console.log('[autoPilotBoardingSend] sendSeatConfirmation result', result);

    if (!result.success) {
      return Response.json({ ok: false, error: result.error, path: result.path }, { status: 502 });
    }

    return Response.json({
      ok: true,
      skipped: Boolean(result.skipped),
      dry_run: Boolean(result.dryRun),
      path: result.path,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[autoPilotBoardingSend] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
});
