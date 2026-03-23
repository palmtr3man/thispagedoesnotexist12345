/**
 * /api/set-departure — Netlify Proxy Function
 *
 * Public-facing endpoint that validates a passenger's selected departure date
 * and forwards it to the Base44 setDeparture handler.
 *
 * Spec: Manus Handoff — FL Next Netlify/GitHub Build (Items 1 & 2)
 *       Passenger-Scheduled Departure — Spec (FL Next)
 *
 * Critical rule: This function validates and proxies ONLY.
 * It does NOT stamp scheduled_departure_date or fire departure_confirmed_v1.
 * That logic lives entirely in the Base44 setDeparture handler.
 *
 * CORS: Restricted to www.thispagedoesnotexist12345.com
 *
 * Required env vars:
 *   BASE44_SET_DEPARTURE_URL  — Base44 setDeparture handler endpoint
 *   BASE44_SEAT_URL           — Base44 Seat entity read endpoint (for window validation)
 */

const ALLOWED_ORIGIN = 'https://www.thispagedoesnotexist12345.com';

/**
 * Build CORS headers. Only allow the .com origin.
 * For preflight OPTIONS requests, the origin check is enforced here.
 */
function buildHeaders(requestOrigin) {
  const origin = requestOrigin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

/**
 * Parse a date string to a UTC midnight Date for day-level window comparison.
 * Accepts ISO 8601 date strings (YYYY-MM-DD) or full ISO timestamps.
 */
function toUTCDate(dateStr) {
  if (!dateStr) return null;
  // Normalise to YYYY-MM-DD for consistent day-level comparison
  const normalized = String(dateStr).slice(0, 10);
  const d = new Date(`${normalized}T00:00:00.000Z`);
  return isNaN(d.getTime()) ? null : d;
}

exports.handler = async (event) => {
  const requestOrigin = event.headers['origin'] || event.headers['Origin'] || '';
  const headers = buildHeaders(requestOrigin);

  // ── Preflight ──────────────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // ── Method guard ──────────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' })
    };
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Invalid JSON body' })
    };
  }

  const { seat_id, passenger_email, selected_date } = body;

  // ── Validate required fields ──────────────────────────────────────────────
  if (!seat_id || !passenger_email || !selected_date) {
    const missing = ['seat_id', 'passenger_email', 'selected_date']
      .filter(f => !body[f])
      .join(', ');
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: `Missing required fields: ${missing}` })
    };
  }

  // ── Fetch Seat record to read departure window ────────────────────────────
  const base44SeatUrl = process.env.BASE44_SEAT_URL;
  if (!base44SeatUrl) {
    console.error('[set-departure] BASE44_SEAT_URL is not set');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Server configuration error' })
    };
  }

  let seat;
  try {
    const seatResp = await fetch(`${base44SeatUrl}/${seat_id}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!seatResp.ok) {
      const errText = await seatResp.text();
      console.error(`[set-departure] Seat fetch failed for ${seat_id} — status ${seatResp.status}:`, errText);
      return {
        statusCode: seatResp.status === 404 ? 400 : 500,
        headers,
        body: JSON.stringify({ ok: false, error: seatResp.status === 404 ? 'Seat not found' : 'Failed to fetch seat record' })
      };
    }

    seat = await seatResp.json();
  } catch (err) {
    console.error('[set-departure] Unexpected error fetching seat record:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Internal server error fetching seat record' })
    };
  }

  // ── Validate selected_date is within departure window ────────────────────
  const windowStart = toUTCDate(seat.departure_window_start);
  const windowEnd = toUTCDate(seat.departure_window_end);
  const selected = toUTCDate(selected_date);

  if (!windowStart || !windowEnd) {
    console.error(`[set-departure] Seat ${seat_id} is missing departure window fields`);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Departure window not set for this seat' })
    };
  }

  if (!selected) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Invalid selected_date format — expected YYYY-MM-DD' })
    };
  }

  if (selected < windowStart || selected > windowEnd) {
    console.warn(`[set-departure] Date ${selected_date} outside window [${seat.departure_window_start}, ${seat.departure_window_end}] for seat ${seat_id}`);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Selected date is outside your departure window.' })
    };
  }

  // ── Proxy to Base44 setDeparture handler ─────────────────────────────────
  const base44SetDepartureUrl = process.env.BASE44_SET_DEPARTURE_URL;
  if (!base44SetDepartureUrl) {
    console.error('[set-departure] BASE44_SET_DEPARTURE_URL is not set');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Server configuration error' })
    };
  }

  try {
    const base44Resp = await fetch(base44SetDepartureUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_id, passenger_email, selected_date })
    });

    if (!base44Resp.ok) {
      const errText = await base44Resp.text();
      console.error(`[set-departure] Base44 setDeparture failed — status ${base44Resp.status}:`, errText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: 'Departure could not be confirmed. Please try again.' })
      };
    }

    console.log(`[set-departure] Departure confirmed for seat ${seat_id} — date: ${selected_date}`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true })
    };

  } catch (err) {
    console.error('[set-departure] Unexpected error proxying to Base44 setDeparture:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Internal server error' })
    };
  }
};
