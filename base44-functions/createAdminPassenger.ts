/**
 * createAdminPassenger — Admin-only passenger creation with pre-assigned seat ID.
 *
 * Creates a Passenger entity record with a Notion-pre-assigned seat ID
 * (stored as seat_id on Passenger and passport_seat_id on the user record
 * when a matching Base44 user exists). Does NOT trigger a public seat request.
 *
 * Payload:
 *   name         string   — full name (required)
 *   email        string   — email address (required)
 *   seat_id      string   — pre-assigned seat ID, e.g. TUJ-KC2222 (required)
 *   flight_id    string   — Flight.flight_code to bind the passenger to (required)
 *   first_name   string   — optional, parsed from name if omitted
 *   cabin_class  string   — "Economy" | "First" | "Sponsored" (default: "Economy")
 *   send_invite  boolean  — if true, also send the intake invite email (default: false)
 *
 * Response:
 *   { ok, passenger_id, created, seat_id, flight_id, user_updated, invite_sent, supabase_synced?, error? }
 */

import { auditRequestId, writeAuditLog } from './shared/auditLog.ts';
import { firstRequiredEnv, optionalEnv, requiredEnv, requiredIntEnv, requiredUrlEnv } from './shared/config.ts';
import { ENV_ALIASES } from './shared/platformSecrets.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const SENDGRID_API_KEY = requiredEnv('SENDGRID_API_KEY');
const FROM_EMAIL = requiredEnv('SENDGRID_FROM_EMAIL');
const APP_BASE_URL = requiredUrlEnv('APP_BASE_URL');
const INVITE_TEMPLATE_ID = firstRequiredEnv(...ENV_ALIASES.inviteTemplateId);
const ASM_GROUP_ID = requiredIntEnv('SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL');

const SEAT_ID_REGEX = /^TUJ-[A-Z2-9]{6}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CABIN_CLASSES = new Set(['Economy', 'First', 'Sponsored']);

function normalizeEmail(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeSeatId(value: string): string {
  const trimmed = String(value || '').trim();
  if (SEAT_ID_REGEX.test(trimmed)) return trimmed.toUpperCase();
  return trimmed.replace(/\s+/g, '_');
}

function normalizeFlightId(value: string): string {
  return String(value || '').trim().replace(/\s+/g, '_');
}

function splitName(fullName: string): { firstName: string; lastName: string | null } {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

function mapCabinTier(cabinClass: string): string {
  if (cabinClass === 'Sponsored') return 'sponsored';
  return cabinClass;
}

function supabaseConfigured(): boolean {
  return Boolean(optionalEnv('SUPABASE_URL') && optionalEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

function supabaseHeaders(): Record<string, string> {
  const key = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

async function syncPassengerToSupabase(payload: {
  email: string;
  first_name: string;
  last_name: string | null;
  seat_id: string;
  flight_tag: string;
  cabin_tier: string;
  intake_status: 'pending' | 'complete';
}): Promise<boolean> {
  if (!supabaseConfigured()) return false;

  const supabaseUrl = optionalEnv('SUPABASE_URL').replace(/\/$/, '');
  const lookupUrl = `${supabaseUrl}/rest/v1/passengers?email=eq.${encodeURIComponent(payload.email)}&select=id&limit=1`;
  const lookupRes = await fetch(lookupUrl, { headers: supabaseHeaders() });
  if (!lookupRes.ok) {
    const body = await lookupRes.text();
    throw new Error(`Supabase passenger lookup failed: ${lookupRes.status} ${body}`);
  }

  const rows = await lookupRes.json();
  const body = {
    email: payload.email,
    first_name: payload.first_name,
    last_name: payload.last_name,
    seat_id: payload.seat_id,
    flight_tag: payload.flight_tag,
    cabin_tier: payload.cabin_tier,
    intake_status: payload.intake_status,
    updated_at: new Date().toISOString(),
  };

  if (Array.isArray(rows) && rows[0]?.id) {
    const patchUrl = `${supabaseUrl}/rest/v1/passengers?id=eq.${encodeURIComponent(rows[0].id)}`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    });
    if (!patchRes.ok) {
      const text = await patchRes.text();
      throw new Error(`Supabase passenger update failed: ${patchRes.status} ${text}`);
    }
    return true;
  }

  const createRes = await fetch(`${supabaseUrl}/rest/v1/passengers`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Supabase passenger create failed: ${createRes.status} ${text}`);
  }
  return true;
}

async function sendInviteEmail(to: string, firstName: string, flightLabel: string): Promise<void> {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: to }],
        dynamic_template_data: {
          first_name: firstName,
          flight_label: flightLabel || 'your upcoming flight',
          boarding_url: `${APP_BASE_URL}/BoardingPortal`,
        },
      }],
      from: { email: FROM_EMAIL },
      template_id: INVITE_TEMPLATE_ID,
      asm: { group_id: ASM_GROUP_ID, groups_to_display: [ASM_GROUP_ID] },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SendGrid ${res.status}: ${body}`);
  }
}

Deno.serve(async (req) => {
  const requestId = auditRequestId(req);
  let base44: ReturnType<typeof createClientFromRequest> | null = null;
  let caller: { id?: string; role?: string } | null = null;

  try {
    base44 = createClientFromRequest(req);

    caller = await base44.auth.me();
    if (!caller || caller.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const {
      name,
      email,
      seat_id: rawSeatId,
      flight_id: rawFlightId,
      first_name,
      cabin_class,
      send_invite,
    } = body ?? {};

    if (!name || !email || !rawSeatId || !rawFlightId) {
      return Response.json(
        { error: 'name, email, seat_id, and flight_id are required' },
        { status: 400 },
      );
    }

    const emailLower = normalizeEmail(email);
    if (!EMAIL_REGEX.test(emailLower)) {
      return Response.json({ error: 'email must be a valid address' }, { status: 400 });
    }

    const seat_id = normalizeSeatId(rawSeatId);
    if (!seat_id) {
      return Response.json({ error: 'seat_id must be non-empty' }, { status: 400 });
    }

    const flight_id = normalizeFlightId(rawFlightId);
    if (!flight_id) {
      return Response.json({ error: 'flight_id must be non-empty' }, { status: 400 });
    }

    const resolvedCabinClass = cabin_class || 'Economy';
    if (!CABIN_CLASSES.has(resolvedCabinClass)) {
      return Response.json(
        { error: 'cabin_class must be Economy, First, or Sponsored' },
        { status: 400 },
      );
    }

    const { firstName: parsedFirstName, lastName } = splitName(name);
    const resolvedFirstName = String(first_name || parsedFirstName || name).trim();
    const cabinTier = mapCabinTier(resolvedCabinClass);

    const existing = await base44.asServiceRole.entities.Passenger.filter({ email: emailLower });
    let passengerId: string;
    let wasCreated = false;

    if (existing && existing.length > 0) {
      passengerId = existing[0].id;
      const preservedIntakeStatus = existing[0].intake_status === 'not_invited'
        ? 'not_invited'
        : existing[0].intake_status;

      await base44.asServiceRole.entities.Passenger.update(passengerId, {
        name,
        first_name: resolvedFirstName,
        email: emailLower,
        seat_id,
        active_flight_id: flight_id,
        flight_id,
        cabin_class: resolvedCabinClass,
        intake_status: preservedIntakeStatus,
      });
      console.log(`[createAdminPassenger] Updated existing Passenger ${passengerId} seat_id=${seat_id}`);
    } else {
      const newPassenger = await base44.asServiceRole.entities.Passenger.create({
        name,
        first_name: resolvedFirstName,
        email: emailLower,
        seat_id,
        active_flight_id: flight_id,
        flight_id,
        cabin_class: resolvedCabinClass,
        intake_status: 'not_invited',
        journey_status: 'waitlist',
        status: 'active',
        waitlist_joined_at: new Date().toISOString(),
      });
      passengerId = newPassenger.id;
      wasCreated = true;
      console.log(`[createAdminPassenger] Created Passenger ${passengerId} seat_id=${seat_id} flight_id=${flight_id}`);
    }

    let userUpdated = false;
    try {
      const users = await base44.asServiceRole.entities.User.filter({ email: emailLower });
      if (users && users.length > 0) {
        const user = users[0];
        if (user.passport_seat_id !== seat_id) {
          await base44.asServiceRole.entities.User.update(user.id, { passport_seat_id: seat_id });
          await writeAuditLog(base44, {
            eventName: 'admin.user_passport_seat_updated',
            operationType: 'admin_action',
            actorId: caller.id,
            actorRole: caller.role,
            requestId,
            targetEntity: 'User',
            targetId: user.id,
            outcome: 'success',
            metadata: { seat_id, passenger_id: passengerId },
          });
          console.log(`[createAdminPassenger] Wrote passport_seat_id=${seat_id} to User ${user.id}`);
        }
        userUpdated = true;
      } else {
        console.log(`[createAdminPassenger] No Base44 user for ${emailLower}; passport_seat_id deferred to first login`);
      }
    } catch (userErr) {
      const message = userErr instanceof Error ? userErr.message : String(userErr);
      console.warn('[createAdminPassenger] User record update failed (non-fatal):', message);
    }

    let supabaseSynced = false;
    try {
      supabaseSynced = await syncPassengerToSupabase({
        email: emailLower,
        first_name: resolvedFirstName,
        last_name: lastName,
        seat_id,
        flight_tag: flight_id,
        cabin_tier: cabinTier,
        intake_status: 'pending',
      });
      if (supabaseSynced) {
        console.log(`[createAdminPassenger] Supabase passengers row synced for ${emailLower}`);
      }
    } catch (syncErr) {
      const message = syncErr instanceof Error ? syncErr.message : String(syncErr);
      console.warn('[createAdminPassenger] Supabase sync failed (non-fatal):', message);
    }

    let inviteSent = false;
    if (send_invite) {
      try {
        let flightLabel = flight_id;
        try {
          const flights = await base44.asServiceRole.entities.Flight.filter({ flight_code: flight_id });
          if (flights?.[0]?.flight_label) flightLabel = flights[0].flight_label;
        } catch (_) {
          // flight label lookup is best-effort
        }

        await sendInviteEmail(emailLower, resolvedFirstName, flightLabel);
        await base44.asServiceRole.entities.Passenger.update(passengerId, { intake_status: 'invited' });
        inviteSent = true;
        console.log(`[createAdminPassenger] Invite email sent to ${emailLower}`);
      } catch (emailErr) {
        const message = emailErr instanceof Error ? emailErr.message : String(emailErr);
        console.error('[createAdminPassenger] Invite email failed:', message);
      }
    }

    await writeAuditLog(base44, {
      eventName: wasCreated ? 'admin.passenger_created' : 'admin.passenger_updated',
      operationType: 'admin_action',
      actorId: caller.id,
      actorRole: caller.role,
      requestId,
      targetEntity: 'Passenger',
      targetId: passengerId,
      outcome: 'success',
      metadata: {
        seat_id,
        flight_id,
        cabin_class: resolvedCabinClass,
        invite_sent: inviteSent,
        user_updated: userUpdated,
        supabase_synced: supabaseSynced,
      },
    });

    return Response.json({
      ok: true,
      passenger_id: passengerId,
      created: wasCreated,
      seat_id,
      flight_id,
      user_updated: userUpdated,
      invite_sent: inviteSent,
      supabase_synced: supabaseSynced,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[createAdminPassenger] Error:', message);

    if (base44 && caller?.id) {
      await writeAuditLog(base44, {
        eventName: 'admin.passenger_create_failed',
        operationType: 'admin_action',
        actorId: caller.id,
        actorRole: caller.role,
        requestId,
        targetEntity: 'Passenger',
        outcome: 'failure',
        errorMessage: message,
      });
    }

    return Response.json({ error: message }, { status: 500 });
  }
});
