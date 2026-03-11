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
 */

const COHORT_CONFIG = {
  departure: '2026-03-21T16:34:00Z',
  seats_total: 5,
  cohort_id: '2026-03-17'
};

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

    // Seat count — in production this would query the Base44 Seat entity
    // For now, returns static config. Replace with Base44 API call when #113 lands.
    const seats_filled = 0; // TODO: query Base44 Seat entity after #113
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
