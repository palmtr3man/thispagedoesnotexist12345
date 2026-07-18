/**
 * migrateSeatIds — One-Time Migration Function
 *
 * Updates all 5 alpha cohort Seat records from the legacy TUJ-XX0001 format
 * to the spec-compliant TUJ-XX2222 format (excludes ambiguous chars 0, 1, O, I).
 *
 * Auth:    Admin only (service role write)
 * Trigger: Manual — call once from Admin panel, then this function can be deleted.
 * Safe:    Idempotent — if a seat already has the new ID it is skipped.
 *
 * Input:  {} (no args required)
 * Output: { ok: boolean, updated: string[], skipped: string[], errors: string[] }
 *
 * Date:   2026-04-05
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { firstOptionalEnv } from './shared/config.ts';
import { ENV_ALIASES } from './shared/platformSecrets.ts';

function loadSeatIdMap(): Record<string, string> {
  const raw = firstOptionalEnv(...ENV_ALIASES.migrationSeatIdsMap);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Auth: admin only
    const caller = await base44.auth.me();
    if (!caller || caller.role !== 'admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const updated: string[] = [];
    const skipped: string[] = [];
    const errors: string[]  = [];

    // Fetch all seats
    const allSeats = await base44.asServiceRole.entities.Seat.list();

    const SEAT_ID_MAP = loadSeatIdMap();

    for (const seat of allSeats) {
      const oldId = seat.seat_id;
      const newId = SEAT_ID_MAP[oldId];

      if (!newId) {
        // Not in migration map — skip silently
        continue;
      }

      if (oldId === newId) {
        skipped.push(`${oldId} (already correct)`);
        continue;
      }

      // Check if new ID is already taken by another record
      const conflict = allSeats.find(s => s.seat_id === newId && s.id !== seat.id);
      if (conflict) {
        errors.push(`${oldId} → ${newId}: conflict — ${newId} already exists on seat record ${conflict.id}`);
        continue;
      }

      try {
        await base44.asServiceRole.entities.Seat.update(seat.id, { seat_id: newId });
        updated.push(`${oldId} → ${newId} (seat record ${seat.id})`);
        console.log(`[migrateSeatIds] Updated: ${oldId} → ${newId}`);
      } catch (e) {
        errors.push(`${oldId} → ${newId}: ${e.message}`);
      }
    }

    const ok = errors.length === 0;

    console.log(`[migrateSeatIds] Done. Updated: ${updated.length}, Skipped: ${skipped.length}, Errors: ${errors.length}`);

    return Response.json({
      ok,
      updated,
      skipped,
      errors,
      summary: `${updated.length} updated, ${skipped.length} skipped, ${errors.length} errors`,
    });
  } catch (error) {
    console.error('[migrateSeatIds] Fatal error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});