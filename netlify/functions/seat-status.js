/**
 * #117 — /api/seat-status Netlify Function
 *
 * Returns the current seat availability and gate status for the active cohort.
 * Used by the landing page to show real-time seat count and gate state.
 *
 * Query params:
 *   ?cohort=2026-03-17  (optional — defaults to active cohort)
 *
 * Response:
 *   {
 *     gate: "OPEN" | "CLOSED" | "STANDBY",
 *     seats_total: 5,
 *     seats_filled: 2,
 *     seats_remaining: 3,
 *     cohort_departure: "2026-03-21T16:34:00Z",
 *     alpha_mode: true | false
 *   }
 *
 * Required env vars:
 *   BASE44APIKEY  — Base44 API key for querying the Seat entity
 */

const COHORT_CONFIG = {
  departure: '2026-03-21T13:34:00Z', // FL 032126 — 8:34 AM ET
  seats_total: 5,
  cohort_id: '032126'
};

// Base44 entity name for seats — adjust if the entity is named differently in your schema
const BASE44_ENTITY = 'Seat';
const BASE44_API_URL = 'https://api.base44.com/api/apps/67912f60b0c40c4f1a48d1c7/entities';

/**
 * Query the Base44 Seat entity and count records with status === 'occupied'.
 * Returns the count of occupied seats, or throws on API failure.
 */
async function fetchOccupiedSeatCount(apiKey) {
  const url = `${BASE44_API_URL}/${BASE44_ENTITY}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'ApiKey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Base44 API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  // data is expected to be an array of seat records
  const seats = Array.isArray(data) ? data : (data.records || data.items || data.data || []);
  const occupied = seats.filter(
    (seat) => seat.status && seat.status.toLowerCase() === 'occupied'
  );

  return occupied.length;
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
    const departureTime = new Date(COHORT_CONFIG.departure);
    const openTime = new Date(departureTime.getTime() - 60 * 60 * 1000); // 1hr before departure
    const closeTime = departureTime;

    // Determine gate state
    let gate;
    if (now >= closeTime) {
      gate = 'CLOSED';
    } else if (now >= openTime) {
      gate = 'OPEN';
    } else {
      gate = 'STANDBY';
    }

    // Alpha mode flag — controls whether the seat request form is live
    const alphaMode = process.env.ALPHA_MODE === 'true';

    // --- Live seat count from Base44 ---
    const apiKey = process.env.BASE44APIKEY;
    let seats_filled = 0;

    if (!apiKey) {
      console.warn('[seat-status] BASE44APIKEY is not set — defaulting seats_filled to 0');
    } else {
      try {
        seats_filled = await fetchOccupiedSeatCount(apiKey);
        console.log(`[seat-status] Base44 occupied seats: ${seats_filled}`);
      } catch (queryErr) {
        // Non-fatal: log the error but still return a response so the UI doesn't break
        console.error('[seat-status] Failed to query Base44 seat count:', queryErr.message);
      }
    }

    const seats_remaining = Math.max(0, COHORT_CONFIG.seats_total - seats_filled);

    const payload = {
      gate,
      seats_total: COHORT_CONFIG.seats_total,
      seats_filled,
      seats_remaining,
      cohort_departure: COHORT_CONFIG.departure,
      cohort_id: COHORT_CONFIG.cohort_id,
      alpha_mode: alphaMode,
      timestamp: now.toISOString()
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload)
    };
  } catch (err) {
    console.error('[seat-status] Error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
