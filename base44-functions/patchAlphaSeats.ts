/**
 * patchAlphaSeats — Admin-only one-shot repair function (hardened)
 *
 * Fixes seat rows for the active Alpha flight only:
 *
 *   1. Seat 1 (Pilot) — removes the duplicate seat_1 record on the ACTIVE
 *      flight, keeping the most complete one. Scope is pinned to the active
 *      flight_id so no other cohort's seat_1 is ever touched.
 *
 *   2. Seats 2–N — backfills user_email / first_name / last_name / tuj_code /
 *      passenger_id where the field is EMPTY. Existing non-empty values are
 *      NEVER overwritten (prevents identity takeover via a stale manifest).
 *      Matching is strictly on (flight_id, seat_number) — email/TUJ are not
 *      used as match keys for writes.
 *
 * The PII manifest is taken from the POST body only (it must NOT live in the
 * function env per the repo PII policy). Each entry: { seat_number,
 * first_name, last_name, user_email, tuj_code }.
 *
 * Safety defaults and guards:
 *   - POST-only, admin re-verified via service-role User lookup.
 *   - Defaults to DRY RUN — nothing is written unless body.force === true.
 *   - Every query / update / delete is scoped to the active flight_id.
 *   - Seat list is refreshed after duplicate deletes so step 2 never targets
 *     a deleted row.
 *   - Response log redacts PII (records field NAMES changed, not values).
 *
 * Trigger: POST /api/patchAlphaSeats (admin token required)
 *
 * Body: { manifest: ManifestEntry[], force?: boolean }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { optionalEnv } from './shared/config.ts';
import { ENV_ALIASES } from './shared/platformSecrets.ts';

type ManifestEntry = {
  seat_number?: string;
  first_name?: string;
  last_name?: string;
  user_email?: string;
  tuj_code?: string;
};

function activeFlightFallback(): string {
  for (const name of ENV_ALIASES.activeFlightId) {
    const value = optionalEnv(name);
    if (value) return value;
  }
  return '';
}

function completenessScore(seat: Record<string, unknown>): number {
  const firstName = typeof seat.first_name === 'string' ? seat.first_name : '';
  return (
    firstName.length +
    (seat.last_name ? 10 : 0) +
    (seat.user_email ? 15 : 0) +
    (seat.passenger_id ? 5 : 0) +
    (seat.tuj_code ? 5 : 0)
  );
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return Response.json({ error: 'Method Not Allowed: POST required' }, { status: 405 });
    }

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Re-verify admin role against the User table via service role — the
    // session claim alone is not sufficient for a mutating endpoint.
    const callerRecords = await base44.asServiceRole.entities.User.filter({ id: user.id });
    const callerRecord = callerRecords?.[0];
    if (!callerRecord || callerRecord.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = await req.json();
    } catch {
      payload = {};
    }

    const manifest = Array.isArray(payload?.manifest) ? (payload.manifest as ManifestEntry[]) : null;
    const force = payload?.force === true;

    if (!manifest || manifest.length === 0) {
      return Response.json({
        error:
          'Manifest required in POST body as a JSON array of { seat_number, first_name, last_name, user_email, tuj_code }. PII must not live in function env.',
      }, { status: 400 });
    }

    // Resolve the active flight. is_active is the source of truth; env is fallback only.
    let activeFlightId = activeFlightFallback();
    const activeFlights = await base44.asServiceRole.entities.Flight.filter({ is_active: true });
    const activeFlight = activeFlights?.[0];
    if (activeFlight?.flight_code) {
      activeFlightId = activeFlight.flight_code;
    }
    if (!activeFlightId) {
      return Response.json({ error: 'No active flight found; cannot scope seat operations.' }, { status: 500 });
    }

    let flightSeats =
      (await base44.asServiceRole.entities.Seat.filter({ flight_id: activeFlightId })) || [];

    const log: Record<string, unknown>[] = [];
    const plan = { flight_id: activeFlightId, dry_run: !force, manifest_size: manifest.length };

    // Step 1 — clear duplicate seat_1 on the ACTIVE flight only.
    const seat1Records = flightSeats.filter(
      (s: Record<string, unknown>) => s.seat_number === 'seat_1' || s.seat_number === '1',
    );
    if (seat1Records.length > 1) {
      seat1Records.sort(
        (a: Record<string, unknown>, b: Record<string, unknown>) =>
          completenessScore(b) - completenessScore(a),
      );
      const kept = seat1Records[0];
      for (const dup of seat1Records.slice(1)) {
        if (force) {
          await base44.asServiceRole.entities.Seat.delete(dup.id);
        }
        log.push({
          action: force ? 'deleted_duplicate_seat_1' : 'would_delete_duplicate_seat_1',
          deleted_id: dup.id,
          kept_id: kept.id,
        });
      }

      // Refresh so step 2 never matches a deleted duplicate row.
      flightSeats =
        (await base44.asServiceRole.entities.Seat.filter({ flight_id: activeFlightId })) || [];
    } else {
      log.push({ action: 'seat_1_no_duplicate', count: seat1Records.length });
    }

    // Step 2 — backfill seats. Match ONLY on (flight_id, seat_number).
    // Email/TUJ are not match keys. Existing non-empty fields are never overwritten.
    for (const entry of manifest) {
      const seatNumber = typeof entry.seat_number === 'string' ? entry.seat_number.trim() : '';
      if (!seatNumber) {
        log.push({ action: 'skipped_missing_seat_number' });
        continue;
      }

      const match = flightSeats.find((s: Record<string, unknown>) => s.seat_number === seatNumber);
      if (!match) {
        log.push({ action: 'seat_not_found', seat_number: seatNumber });
        continue;
      }

      const patch: Record<string, string> = {};
      const changes: string[] = [];

      if (isEmpty(match.first_name) && entry.first_name) {
        patch.first_name = entry.first_name;
        changes.push('first_name');
      }
      if (isEmpty(match.last_name) && entry.last_name) {
        patch.last_name = entry.last_name;
        changes.push('last_name');
      }
      if (isEmpty(match.user_email) && entry.user_email) {
        patch.user_email = entry.user_email;
        changes.push('user_email');
      }
      if (isEmpty(match.tuj_code) && entry.tuj_code) {
        patch.tuj_code = entry.tuj_code;
        changes.push('tuj_code');
      }

      if (isEmpty(match.passenger_id) && entry.user_email) {
        const passengers = await base44.asServiceRole.entities.Passenger.filter({
          email: entry.user_email,
        });
        const passenger = passengers?.[0];
        if (passenger?.id) {
          patch.passenger_id = passenger.id;
          changes.push('passenger_id');
        } else {
          log.push({ action: 'passenger_not_found', seat_number: seatNumber });
        }
      }

      if (Object.keys(patch).length > 0) {
        if (force) {
          await base44.asServiceRole.entities.Seat.update(match.id, patch);
        }
        // Redact PII: log field names changed, not values.
        log.push({
          action: force ? 'patched' : 'would_patch',
          seat_id: match.id,
          seat_number: seatNumber,
          changes,
        });
      } else {
        log.push({ action: 'skipped_already_complete', seat_number: seatNumber });
      }
    }

    return Response.json({ ok: true, plan, log });
  } catch (error) {
    console.error('[patchAlphaSeats] Error:', error instanceof Error ? error.message : error);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
});
