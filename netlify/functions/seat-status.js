/**
 * #117 — /api/seat-status Netlify Function
 *
 * Returns the current seat availability and gate status for the active flight.
 * Used by the landing page to show real-time seat count and gate state.
 *
 * Active flight resolution:
 *   1. Fetch all Flight records from Base44
 *   2. Prefer the first record with status "boarding" or "open"
 *   3. Fall back to the most recently created record if none match
 *
 * Flight.status → gate mapping:
 *   "open"      → OPEN
 *   "boarding"  → OPEN
 *   "departed"  → CLOSED
 *   "closed"    → CLOSED
 *   (anything else) → STANDBY
 *
 * Response:
 *   {
 *     gate: "OPEN" | "CLOSED" | "STANDBY",
 *     seats_total: 5,
 *     seats_filled: 2,
 *     seats_remaining: 3,
 *     cohort_departure: "2026-03-21T13:34:00Z",
 *     cohort_id: "032126",
 *     flight_label: "FL 032126",
 *     alpha_mode: true | false,
 *     timestamp: "2026-03-19T..."
 *   }
 *
 * Required env vars:
 *   BASE44APIKEY  — Base44 API key for querying Flight and Seat entities
 */

const BASE44_API_URL = 'https://api.base44.com/api/apps/67912f60b0c40c4f1a48d1c7/entities';

// Fallback values used only if the Base44 Flight query fails entirely
const FALLBACK_CONFIG = {
  departure: '2026-03-21T13:34:00Z',
  seats_total: 5,
  cohort_id: 'FL032126',
  flight_id_display: 'FL 032126'
};

/**
 * Build the shared auth headers for all Base44 requests.
 */
function base44Headers(apiKey) {
  return {
    'ApiKey': apiKey,
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Fetch all Flight records from Base44 and return the active one.
 * Active = first record with status "boarding" or "open";
 * falls back to the most recent record by created_date / _id order.
 *
 * Returns an object with: { gate, seats_total, cohort_id, flight_label, departure }
 * or throws on API failure.
 */
async function fetchActiveFlight(apiKey) {
  const url = `${BASE44_API_URL}/Flight`;
  const response = await fetch(url, {
    method: 'GET',
    headers: base44Headers(apiKey)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Base44 Flight API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const flights = Array.isArray(data) ? data : (data.records || data.items || data.data || []);

  if (flights.length === 0) {
    throw new Error('Base44 returned no Flight records');
  }

  // Prefer the first actively open/boarding flight
  const ACTIVE_STATUSES = ['boarding', 'open'];
  let flight = flights.find(
    (f) => f.status && ACTIVE_STATUSES.includes(f.status.toLowerCase())
  );

  // Fall back to most recent record (last in array, or sort by created_date descending)
  if (!flight) {
    const sorted = [...flights].sort((a, b) => {
      const aDate = a.created_date || a.createdAt || a._id || '';
      const bDate = b.created_date || b.createdAt || b._id || '';
      return bDate > aDate ? 1 : -1;
    });
    flight = sorted[0];
  }

  // Map Flight.status → canonical gate value
  const statusLower = (flight.status || '').toLowerCase();
  let gate;
  if (statusLower === 'open' || statusLower === 'boarding') {
    gate = 'OPEN';
  } else if (statusLower === 'departed' || statusLower === 'closed') {
    gate = 'CLOSED';
  } else {
    gate = 'STANDBY';
  }

  return {
    gate,
    seats_total: typeof flight.max_seats === 'number' ? flight.max_seats : 5,
    cohort_id: flight.flight_code || flight._id || FALLBACK_CONFIG.cohort_id,
    flight_id_display: flight.flight_id_display || FALLBACK_CONFIG.flight_id_display,
    departure: flight.departure_date || FALLBACK_CONFIG.departure
  };
}

/**
 * Query the Base44 Seat entity and count records with status === 'occupied'.
 * Returns the count of occupied seats, or throws on API failure.
 */
async function fetchOccupiedSeatCount(apiKey) {
  const url = `${BASE44_API_URL}/Seat`;
  const response = await fetch(url, {
    method: 'GET',
    headers: base44Headers(apiKey)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Base44 Seat API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const seats = Array.isArray(data) ? data : (data.records || data.items || data.data || []);

  // Count any seat that is actively claimed — 'occupied' (legacy) or 'open' (triggered)
  const FILLED_STATUSES = ['occupied', 'open'];
  const filled = seats.filter(
    (seat) => seat.status && FILLED_STATUSES.includes(seat.status.toLowerCase())
  );

  return filled.length;
}

exports.handler = async function (event, context) {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const now = new Date();
    const alphaMode = process.env.ALPHA_MODE === 'true';
    const apiKey = process.env.BASE44APIKEY;

    // --- Defaults (used if Base44 is unreachable) ---
    let gate = 'STANDBY';
    let seats_total = FALLBACK_CONFIG.seats_total;
    let cohort_id = FALLBACK_CONFIG.cohort_id;
    let flight_id_display = FALLBACK_CONFIG.flight_id_display;
    let cohort_departure = FALLBACK_CONFIG.departure;
    let seats_filled = 0;

    if (!apiKey) {
      console.warn('[seat-status] BASE44APIKEY is not set — using fallback values');
    } else {
      // Run both queries in parallel for speed
      const [flightResult, seatResult] = await Promise.allSettled([
        fetchActiveFlight(apiKey),
        fetchOccupiedSeatCount(apiKey)
      ]);

      if (flightResult.status === 'fulfilled') {
        ({ gate, seats_total, cohort_id, flight_id_display, departure: cohort_departure } = flightResult.value);
        console.log(`[seat-status] Active flight: ${flight_id_display} (${cohort_id}), gate: ${gate}, max_seats: ${seats_total}`);
      } else {
        console.error('[seat-status] Failed to query Flight entity:', flightResult.reason?.message);
      }

      if (seatResult.status === 'fulfilled') {
        seats_filled = seatResult.value;
        console.log(`[seat-status] Occupied seats: ${seats_filled}`);
      } else {
        console.error('[seat-status] Failed to query Seat entity:', seatResult.reason?.message);
      }
    }

    const seats_remaining = Math.max(0, seats_total - seats_filled);

    const payload = {
      gate,
      seats_total,
      seats_filled,
      seats_remaining,
      cohort_departure,
      cohort_id,
      flight_id_display,
      alpha_mode: alphaMode,
      timestamp: now.toISOString()
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload)
    };
  } catch (err) {
    console.error('[seat-status] Unexpected error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
