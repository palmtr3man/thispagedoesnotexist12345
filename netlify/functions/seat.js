/**
 * /api/seat — Netlify Function
 *
 * Validates a seat_id against the Base44 Seat entity.
 * Called by resolveState() on .com before rendering Mission Control (State 2).
 *
 * Route:  GET /api/seat?id=TUJ-XXXXXX
 *
 * Success (seat found + active):
 *   HTTP 200  { valid: true,  seat_id: 'TUJ-XXXXXX', status: 'opened' }
 *
 * Not found / inactive:
 *   HTTP 200  { valid: false, seat_id: 'TUJ-XXXXXX', reason: 'not_found' | 'inactive' }
 *
 * Bad request (missing or malformed id):
 *   HTTP 400  { valid: false, reason: 'invalid_format' }
 *
 * Fail-open (BASE44_SEAT_URL not configured):
 *   HTTP 200  { valid: true,  seat_id: 'TUJ-XXXXXX', _unchecked: true }
 *   Rationale: preserves existing behaviour until Base44 is wired; never silently
 *   drops a passenger who already has a confirmed seat.
 *
 * Fail-open (Base44 unreachable / timeout):
 *   HTTP 200  { valid: true,  seat_id: 'TUJ-XXXXXX', _unchecked: true }
 *   Rationale: same as above — a transient upstream outage must not lock out
 *   confirmed passengers.
 *
 * Required env var:
 *   BASE44_SEAT_URL — Base44 Seat entity read endpoint.
 *                     If unset, the function returns valid: true (_unchecked: true).
 *
 * Status mapping (Base44 → gate):
 *   'opened'  → valid: true  (seat is live and assigned — Mission Control renders)
 *   'approved'→ valid: true  (seat is approved/reserved — allow access)
 *   'pending' → valid: false, reason: 'inactive'  (seat not yet activated)
 *   anything else → valid: false, reason: 'inactive'
 *
 * CORS: open (*) — same policy as /api/seat-status.
 */

const SEAT_ID_REGEX = /^TUJ-[A-Z2-9]{6}$/;
const VALIDATION_TIMEOUT_MS = 4000; // 4 s — fast enough for UX; generous enough for cold starts

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

/**
 * Fetch a Seat record from Base44 with a hard timeout.
 * Returns the parsed JSON body on success, or throws on error/timeout.
 */
async function fetchSeatRecord(base44SeatUrl, seatId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const res = await fetch(`${base44SeatUrl}/${seatId}`, {
      method:  'GET',
      headers: { 'Content-Type': 'application/json' },
      signal:  controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = new Error(`Base44 responded ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Map a Base44 seat status string to a gate-level validity decision.
 * 'opened'   → valid (seat is live)
 * 'approved' → valid (seat is approved/reserved)
 * anything else (including 'pending') → invalid
 */
function isSeatActive(seat) {
  const status = (seat && seat.status) ? String(seat.status).toLowerCase() : '';
  return status === 'opened' || status === 'approved';
}

exports.handler = async (event) => {
  // ── Preflight ──────────────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  // ── Method guard ──────────────────────────────────────────────────────────
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ valid: false, reason: 'method_not_allowed' }),
    };
  }

  // ── Extract + validate seat_id format ─────────────────────────────────────
  const seatId = (event.queryStringParameters || {}).id || '';
  if (!seatId || !SEAT_ID_REGEX.test(seatId)) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ valid: false, reason: 'invalid_format' }),
    };
  }

  // ── Fail-open: BASE44_SEAT_URL not configured ─────────────────────────────
  const base44SeatUrl = process.env.BASE44_SEAT_URL;
  if (!base44SeatUrl) {
    console.warn(`[seat] BASE44_SEAT_URL not set — returning valid:true (_unchecked) for ${seatId}`);
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ valid: true, seat_id: seatId, _unchecked: true }),
    };
  }

  // ── Fetch + validate against Base44 ──────────────────────────────────────
  try {
    const seat = await fetchSeatRecord(base44SeatUrl, seatId);
    const active = isSeatActive(seat);
    if (active) {
      console.log(`[seat] ${seatId} validated — status: ${seat.status}`);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ valid: true, seat_id: seatId, status: seat.status }),
      };
    } else {
      console.log(`[seat] ${seatId} inactive — status: ${seat.status || 'unknown'}`);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ valid: false, seat_id: seatId, reason: 'inactive', status: seat.status || null }),
      };
    }
  } catch (err) {
    // 404 from Base44 → seat does not exist
    if (err.status === 404) {
      console.log(`[seat] ${seatId} not found in Base44`);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ valid: false, seat_id: seatId, reason: 'not_found' }),
      };
    }

    // Timeout or other upstream error → fail open
    const isTimeout = err.name === 'AbortError';
    console.warn(`[seat] ${seatId} validation ${isTimeout ? 'timed out' : 'errored'} — failing open:`, err.message);
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ valid: true, seat_id: seatId, _unchecked: true }),
    };
  }
};
