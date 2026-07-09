/**
 * handleBmacWebhook — Confirms BMAC payment and writes cabin_class to User.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT (Option A — cabin stored at click time)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Preconditions (set by the Cabin Selection UI before the BMAC redirect):
 *   PassengerFlight.cabin            = 'Economy' | 'Business' | 'First'
 *   PassengerFlight.bmac_payment_confirmed = false
 *
 * This handler's responsibilities:
 *   1. Verify the BMAC webhook payload is authentic (supporter_email present)
 *   2. Find the app user by email
 *   3. Skip silently if user has is_sponsored = true (sponsored bypass — item 5)
 *   4. Find the active PassengerFlight row for this user
 *   5a. If cabin IS set:
 *       - Write User.cabin_class = flight.cabin
 *       - Write PassengerFlight.bmac_payment_confirmed = true
 *       - Write PassengerFlight.bmac_payment_confirmed_at = now()
 *   5b. If cabin IS NULL:
 *       - Write PassengerFlight.bmac_payment_needs_review = true
 *       - Log error with userId for admin follow-up
 *       - Do NOT guess cabin assignment
 *   6. Update Subscription.tier to match cabin entitlement
 *   7. Sync Seat.bmac_payment_confirmed + Seat.cabin_class (seat-activate Gap 6)
 *
 * BMAC webhook events handled:
 *   - supporter.created  (one-time payment)
 *   - membership.started (recurring subscription started)
 *   - membership.updated (recurring subscription renewed/changed)
 *
 * Cabin → Subscription tier mapping:
 *   Economy → 'free'  (BMAC support acknowledged; no tier upgrade)
 *   Business → 'plus'
 *   First    → 'pro'
 *
 * Note: First Cabin sponsored users bypass this handler entirely (step 3).
 *       Their cabin_class is set by syncBmacMembers / checkBmacStatus.
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { auditInvocation, verifyHmacSha256 } from './shared/invocationGuard.ts';

/** Maps cabin class to LS-compatible subscription tier. */
function cabinToTier(cabin: string): 'free' | 'plus' | 'pro' {
  if (cabin === 'First') return 'pro';
  if (cabin === 'Business') return 'plus';
  return 'free'; // Economy — BMAC support acknowledged; no paid tier upgrade
}

/** Maps PassengerFlight cabin to Seat.cabin_class (boarding path enum). */
function cabinToSeatClass(cabin: string): 'Economy' | 'First' {
  if (cabin === 'First') return 'First';
  return 'Economy'; // Economy + Business use the free boarding path on Seat
}

const PAYMENT_EVENTS = new Set([
  'supporter.created',
  'membership.started',
  'membership.updated',
]);

type Base44Client = ReturnType<typeof createClientFromRequest>;
type AppUser = { id: string; email?: string; passport_seat_id?: string };

async function syncSeatBmacConfirmation(
  base44: Base44Client,
  user: AppUser,
  cabin: string,
  now: string,
): Promise<{ synced: boolean; seatId?: string }> {
  const email = String(user.email ?? '').toLowerCase().trim();
  let seats: Array<Record<string, unknown>> = [];

  if (email) {
    seats = await base44.asServiceRole.entities.Seat.filter({ user_email: email }) || [];
  }

  if (seats.length === 0 && user.passport_seat_id) {
    const byCode = await base44.asServiceRole.entities.Seat.filter({ tuj_code: user.passport_seat_id });
    if (byCode?.length) seats = byCode;
  }

  if (seats.length === 0) {
    const byPassenger = await base44.asServiceRole.entities.Seat.filter({ passenger_id: user.id });
    if (byPassenger?.length) seats = byPassenger;
  }

  if (seats.length === 0) {
    const byAssigned = await base44.asServiceRole.entities.Seat.filter({ assigned_passenger_id: user.id });
    if (byAssigned?.length) seats = byAssigned;
  }

  if (!seats.length) {
    console.warn('[handleBmacWebhook] No Seat row to sync for user:', user.id);
    return { synced: false };
  }

  const seat = seats[0];
  const seatCabin = cabinToSeatClass(cabin);

  await base44.asServiceRole.entities.Seat.update(seat.id, {
    cabin_class: seatCabin,
    bmac_payment_confirmed: true,
    bmac_payment_confirmed_at: now,
  });

  const seatId = String(seat.tuj_code || seat.seat_id || seat.id || '');
  console.log('[handleBmacWebhook] Seat payment flags synced:', { userId: user.id, seatId, seatCabin });
  return { synced: true, seatId: seatId || undefined };
}

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();
    const guard = await verifyHmacSha256(rawBody, req, {
      secretEnv: 'BMAC_WEBHOOK_SECRET',
      signatureHeader: 'x-bmac-signature',
      prefix: 'sha256',
    });
    if (!guard.ok) return guard.response;
    auditInvocation('handleBmacWebhook', guard);

    const base44 = createClientFromRequest(req);
    const now = new Date().toISOString();

    // ── 1. Parse BMAC webhook payload ────────────────────────────────────────
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    // BMAC sends supporter_email at the top level for all event types.
    const supporterEmail = String(payload.supporter_email ?? '').toLowerCase().trim();
    if (!supporterEmail) {
      console.error('[handleBmacWebhook] No supporter_email in payload:', JSON.stringify(payload));
      return Response.json({ error: 'Missing supporter_email' }, { status: 400 });
    }

    const eventType = String(payload.type ?? 'unknown');
    console.log('[handleBmacWebhook] Event received:', { eventType, supporterEmail });

    if (!PAYMENT_EVENTS.has(eventType)) {
      return Response.json({ received: true, action: 'ignored', eventType });
    }

    // ── 2. Find the app user by email ────────────────────────────────────────
    const users = await base44.asServiceRole.entities.User.filter({ email: supporterEmail });
    if (!users || users.length === 0) {
      // Not a registered TUJ user — log and return 200 so BMAC doesn't retry.
      console.warn('[handleBmacWebhook] No TUJ user found for email:', supporterEmail);
      return Response.json({ received: true, action: 'no_user_found' });
    }
    const user = users[0];

    // ── 3. Sponsored bypass (item 5) ─────────────────────────────────────────
    // Sponsored users (Veterans, Retirees, Unhoused) receive First Cabin access
    // without payment. If a sponsored user somehow triggers a BMAC payment event,
    // skip all cabin/tier writes — their access is managed by syncBmacMembers.
    if (user.is_sponsored === true) {
      console.log('[handleBmacWebhook] Sponsored user — skipping cabin write:', user.id);
      return Response.json({ received: true, action: 'sponsored_bypass', userId: user.id });
    }

    // ── 4. Find the active PassengerFlight row ────────────────────────────────
    // If a user is on multiple flights, target the most recently joined unconfirmed row.
    const flightRows = await base44.asServiceRole.entities.PassengerFlight.filter({
      passenger_id: user.id,
      bmac_payment_confirmed: false,
    });

    if (!flightRows || flightRows.length === 0) {
      // Payment arrived but no unconfirmed flight row exists.
      // Could be a duplicate webhook or a payment for a non-flight product.
      console.warn('[handleBmacWebhook] No unconfirmed PassengerFlight row for user:', user.id);
      return Response.json({ received: true, action: 'no_flight_row', userId: user.id });
    }

    // Sort by joined_at descending to target the most recent flight.
    const flight = flightRows.sort((a, b) => {
      const aTime = a.joined_at ? new Date(a.joined_at).getTime() : 0;
      const bTime = b.joined_at ? new Date(b.joined_at).getTime() : 0;
      return bTime - aTime;
    })[0];

    // ── 5a. Cabin IS set — confirm payment and propagate ──────────────────────
    if (flight.cabin) {
      const tier = cabinToTier(flight.cabin);

      // Write cabin_class to User record (mirrors hasFirstClassAccess.js logic)
      await base44.asServiceRole.entities.User.update(user.id, {
        cabin_class: flight.cabin,
      });

      // Confirm payment on the PassengerFlight row
      await base44.asServiceRole.entities.PassengerFlight.update(flight.id, {
        cabin: flight.cabin,
        bmac_payment_confirmed: true,
        bmac_payment_confirmed_at: now,
      });

      // Sync Subscription tier to match cabin entitlement
      const existingSubs = await base44.asServiceRole.entities.Subscription.filter({ user_id: user.id });
      if (existingSubs.length > 0) {
        await base44.asServiceRole.entities.Subscription.update(existingSubs[0].id, {
          tier,
          status: 'active',
        });
      } else {
        await base44.asServiceRole.entities.Subscription.create({
          user_id: user.id,
          tier,
          status: 'active',
        });
      }

      const seatSync = await syncSeatBmacConfirmation(base44, user, flight.cabin, now);

      console.log('[handleBmacWebhook] Payment confirmed:', {
        userId: user.id,
        flightId: flight.flight_id,
        cabin: flight.cabin,
        tier,
        seatSynced: seatSync.synced,
        seatId: seatSync.seatId,
      });

      return Response.json({
        received: true,
        action: 'payment_confirmed',
        userId: user.id,
        flightId: flight.flight_id,
        cabin: flight.cabin,
        tier,
        seatSynced: seatSync.synced,
        seatId: seatSync.seatId,
      });
    }

    // ── 5b. Cabin IS NULL — flag for review, do not guess ────────────────────
    console.error('[handleBmacWebhook] Payment arrived but cabin is null — flagging for review:', {
      userId: user.id,
      flightRowId: flight.id,
      supporterEmail,
    });

    await base44.asServiceRole.entities.PassengerFlight.update(flight.id, {
      bmac_payment_needs_review: true,
    });

    return Response.json({
      received: true,
      action: 'needs_review',
      userId: user.id,
      flightRowId: flight.id,
      reason: 'cabin_null_at_payment_time',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[handleBmacWebhook] Fatal error:', error);
    return Response.json({ error: message }, { status: 500 });
  }
});
