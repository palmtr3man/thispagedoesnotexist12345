/**
 * Beehiiv Issue 2 — canonical flight identity validation.
 * See docs/beehiiv-issue-2-canon-migration.md
 */

const FLIGHT_KEY_RE = /^[A-Z0-9_]+$/;
const FLIGHT_ID_RE = /^[A-Z0-9 ]+$/;

function collapseWhitespace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function deriveFlightKey(flightId) {
  return collapseWhitespace(flightId).replace(/\s+/g, '_');
}

function normalizeFlightKey(raw) {
  const normalized = String(raw || '').trim().replace(/\s+/g, '_').toUpperCase();
  if (!FLIGHT_KEY_RE.test(normalized)) return null;
  return normalized;
}

function normalizeFlightId(raw) {
  const normalized = collapseWhitespace(raw).toUpperCase();
  if (!normalized || normalized.includes('_')) return null;
  if (!FLIGHT_ID_RE.test(normalized)) return null;
  return normalized;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: object } | { ok: false, error: string, details?: object }}
 */
function validateBeehiivSyncIdentity(input = {}) {
  const flightKeyRaw = input.flight_key;
  const flightIdRaw = input.flight_id;
  const cohortIdRaw = input.cohort_id;

  if (flightKeyRaw == null || flightIdRaw == null || cohortIdRaw == null) {
    return {
      ok: false,
      error: 'validation_error',
      details: { message: 'flight_key, flight_id, and cohort_id are required' },
    };
  }

  const flight_id = normalizeFlightId(flightIdRaw);
  if (!flight_id) {
    return {
      ok: false,
      error: 'validation_error',
      details: { message: 'flight_id must be uppercase, space-delimited, and must not contain underscores' },
    };
  }

  const flight_key = normalizeFlightKey(flightKeyRaw);
  if (!flight_key) {
    return {
      ok: false,
      error: 'validation_error',
      details: { message: 'flight_key must match ^[A-Z0-9_]+$ after normalization' },
    };
  }

  const derived = deriveFlightKey(flight_id);
  if (derived !== flight_key) {
    return {
      ok: false,
      error: 'validation_error',
      details: {
        message: 'flight_key does not match normalized flight_id',
        flight_key,
        expected_flight_key: derived,
        flight_id,
      },
    };
  }

  const cohort_id = String(cohortIdRaw || '').trim();
  if (!cohort_id) {
    return {
      ok: false,
      error: 'validation_error',
      details: { message: 'cohort_id must be a non-empty string' },
    };
  }

  const dry_run = input.dry_run === undefined ? true : Boolean(input.dry_run);
  const segment_key = input.segment_key == null ? null : String(input.segment_key).trim() || null;
  const boarding_opened_at = input.boarding_opened_at || null;
  const boarding_closed_at = input.boarding_closed_at || null;

  return {
    ok: true,
    value: {
      flight_key,
      flight_id,
      cohort_id,
      dry_run,
      segment_key,
      boarding_opened_at,
      boarding_closed_at,
    },
  };
}

module.exports = {
  validateBeehiivSyncIdentity,
  deriveFlightKey,
  normalizeFlightKey,
  normalizeFlightId,
};
