/**
 * /api/seat-ready — Netlify Proxy Function
 *
 * Public Zapier-facing endpoint for the seat-open confirmation flow.
 * Accepts the full seat payload and hands it to the existing
 * sendgrid-integration handleSeatOpened path (sendSeatConfirmation).
 *
 * Step 1: Zapier handleSeatOpened action prepares the seat payload.
 * Step 2: Zapier POSTs that payload here.
 *
 * Required payload: the full Seat entity, including an id/seat_id/tuj_code
 * plus the recipient and name fields used by the boarding confirmation flow.
 */

const { sendSeatConfirmation } = require('./sendgrid-integration.js');

const ALLOWED_ORIGIN = '*';

function buildHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  const headers = buildHeaders();

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' })
    };
  }

  let seat;
  try {
    seat = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Invalid JSON body' })
    };
  }

  if (!seat || (!seat.id && !seat.seat_id && !seat.tuj_code)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Missing seat.id, seat.seat_id, or seat.tuj_code in request body' })
    };
  }

  const result = await sendSeatConfirmation(seat);

  if (!result || !result.success) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ ok: false, error: result?.error || 'Seat-ready dispatch failed' })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, skipped: Boolean(result.skipped) })
  };
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.handler = exports.handler;
}
