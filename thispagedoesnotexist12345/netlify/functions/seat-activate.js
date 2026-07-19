/**
 * /api/seat-activate — Netlify Function
 *
 * Pilot-only operator endpoint. Writes boarding_type and cabin_class to a
 * Base44 Seat record, then triggers the handleSeatOpened email sequence by
 * calling /api/sendgrid-integration internally.
 *
 * This is the Mission Control Seat Activation Panel backend. It enforces the
 * pre-trigger field checklist (Gaps 1–3 from the Apr 20, 2026 boarding audit)
 * so the operator cannot trigger handleSeatOpened with missing required fields.
 *
 * Route:  POST /api/seat-activate
 *
 * Request body:
 *   {
 *     seat_id:       string  — TUJ-XXXXXX (required)
 *     boarding_type: string  — one of VALID_BOARDING_TYPES (required)
 *     cabin_class:   string  — one of VALID_CABIN_CLASSES (required)
 *     pilot_token:   string  — operator auth token (required)
 *   }
 *
 * Success:
 *   HTTP 200  { ok: true, seat_id, boarding_type, cabin_class, send_result }
 *
 * Validation error:
 *   HTTP 400  { ok: false, error: string }
 *
 * Auth error:
 *   HTTP 403  { ok: false, error: 'Unauthorized' }
 *
 * Upstream error:
 *   HTTP 502  { ok: false, error: string }
 *
 * Required env vars:
 *   BASE44_SEAT_URL       — Base44 Seat entity read/update endpoint
 *   PILOT_TOKEN           — Operator auth token for this endpoint
 *   SITE_URL              — Base URL (used to call /api/sendgrid-integration internally)
 *
 * boarding_type enum:
 *   executive_pre  — exec_preboard_opentowork_v1 (Pilot KC only)
 *   standard       — dual-tier boarding sequence (cabin_class drives paid vs free)
 *   vip            — vip_boarding_pass_v1 + vip_boarding_instructions_v1 (stub — template pending)
 *   beta           — dual-tier boarding sequence (cabin_class drives paid vs free)
 *   sponsored      — sponsored_approved_v1 (single send)
 *
 * cabin_class enum (Base44 canonical):
 *   First      — paid tier
 *   Sponsored  — sponsored tier
 *   Economy    — free tier
 *
 * Spec: Mission Control Seat Activation Panel — Apr 20, 2026
 */

const VALID_BOARDING_TYPES = ['executive_pre', 'standard', 'vip', 'beta', 'sponsored'];
const VALID_CABIN_CLASSES   = ['First', 'Sponsored', 'Economy'];

const HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

/**
 * Fetch the current Seat record from Base44 by tuj_code.
 */
async function fetchSeat(base44SeatUrl, seatId) {
  const apiKey = process.env.BASE44APIKEY || '';
  // Query by tuj_code field
  const url = `${base44SeatUrl}?tuj_code=${encodeURIComponent(seatId)}`;
  const res = await fetch(url, {
    method:  'GET',
    headers: { 'Content-Type': 'application/json', 'api_key': apiKey },
  });
  if (!res.ok) {
    const err = new Error(`Base44 GET failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // Base44 returns an array when filtering
  const seat = Array.isArray(data) ? data[0] : data;
  if (!seat) {
    const err = new Error(`Seat ${seatId} not found in Base44`);
    err.status = 404;
    throw err;
  }
  return seat;
}

/**
 * Write boarding_type and cabin_class to the Seat record in Base44.
 * Uses the internal _id from the fetched seat record.
 */
async function patchSeat(base44SeatUrl, seat, fields) {
  const apiKey = process.env.BASE44APIKEY || '';
  const internalId = seat.id || seat._id;
  const res = await fetch(`${base44SeatUrl}/${internalId}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', 'api_key': apiKey },
    body:    JSON.stringify({ ...seat, ...fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Base44 PUT failed: ${res.status} — ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Trigger the handleSeatOpened email sequence by calling /api/sendgrid-integration
 * with the full updated seat record.
 */
async function triggerSend(siteUrl, seat) {
  const url = `${siteUrl}/.netlify/functions/sendgrid-integration`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(seat),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

exports.handler = async (event) => {
  // ── Preflight ──────────────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }),
    };
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }),
    };
  }

  const { seat_id, boarding_type, cabin_class, pilot_token } = payload;

  // ── Auth guard ─────────────────────────────────────────────────────────────
  const expectedToken = process.env.PILOT_TOKEN;
  if (!expectedToken || pilot_token !== expectedToken) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, error: 'Unauthorized' }),
    };
  }

  // ── Input validation ───────────────────────────────────────────────────────
  if (!seat_id || !/^TUJ-[A-Z2-9]{6}$/.test(seat_id)) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, error: 'seat_id is required and must match TUJ-XXXXXX format' }),
    };
  }

  if (!boarding_type || !VALID_BOARDING_TYPES.includes(boarding_type)) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({
        ok: false,
        error: `boarding_type is required. Valid values: ${VALID_BOARDING_TYPES.join(', ')}`,
      }),
    };
  }

  if (!cabin_class || !VALID_CABIN_CLASSES.includes(cabin_class)) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({
        ok: false,
        error: `cabin_class is required. Valid values: ${VALID_CABIN_CLASSES.join(', ')}`,
      }),
    };
  }

  // ── Env var checks ─────────────────────────────────────────────────────────
  let base44SeatUrl = process.env.BASE44_SEAT_URL;
  const siteUrl     = (process.env.SITE_URL || 'https://thispagedoesnotexist12345.com').replace(/\/$/, '');

  if (!base44SeatUrl) {
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, error: 'BASE44_SEAT_URL is not configured' }),
    };
  }

  // Correct legacy SPA URL to the Base44 REST API URL
  if (base44SeatUrl.includes('theultimatejourney.base44.app')) {
    base44SeatUrl = 'https://app.base44.com/api/apps/697140e628131a06045ebd18/entities/Seat';
  }

  // ── Fetch current seat record ──────────────────────────────────────────────
  let seat;
  try {
    seat = await fetchSeat(base44SeatUrl, seat_id);
  } catch (err) {
    const notFound = err.status === 404;
    return {
      statusCode: notFound ? 404 : 502,
      headers: HEADERS,
      body: JSON.stringify({
        ok: false,
        error: notFound ? `Seat ${seat_id} not found in Base44` : `Base44 fetch error: ${err.message}`,
      }),
    };
  }

  // ── Pre-trigger field checklist (Gap 3 — exec_pre path) ───────────────────
  if (boarding_type === 'executive_pre') {
    const pidTrim  = seat.pid      && String(seat.pid).trim();
    const tujTrim  = seat.tuj_code && String(seat.tuj_code).trim();
    const missing  = [!pidTrim && 'pid', !tujTrim && 'tuj_code'].filter(Boolean);
    if (missing.length) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({
          ok: false,
          error: `executive_pre requires non-empty fields on the Seat record: ${missing.join(', ')}. Set these in Base44 before activating.`,
        }),
      };
    }
  }

  // ── BMAC flag check (Gap 6) ────────────────────────────────────────────────
  if (seat.bmac_payment_confirmed === false && cabin_class === 'First') {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({
        ok: false,
        error: 'cabin_class is First but bmac_payment_confirmed is false on this Seat record. Resolve the BMAC payment flag before activating.',
      }),
    };
  }

  // ── Write boarding_type + cabin_class to Base44 ────────────────────────────
  let updatedSeat;
  try {
    updatedSeat = await patchSeat(base44SeatUrl, seat, { boarding_type, cabin_class });
  } catch (err) {
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, error: `Base44 PATCH error: ${err.message}` }),
    };
  }

  // Merge the patched fields into the full seat record for the send trigger
  const seatForSend = { ...seat, ...updatedSeat, boarding_type, cabin_class };

  // ── Trigger handleSeatOpened (sendgrid-integration) ────────────────────────
  let sendResult;
  try {
    sendResult = await triggerSend(siteUrl, seatForSend);
  } catch (err) {
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, error: `sendgrid-integration trigger error: ${err.message}` }),
    };
  }

  if (sendResult.status !== 200) {
    return {
      statusCode: 502,
      headers: HEADERS,
      body: JSON.stringify({
        ok: false,
        error: `handleSeatOpened failed: ${sendResult.body.error || 'unknown error'}`,
        send_result: sendResult.body,
      }),
    };
  }

  console.log(`[seat-activate] Seat ${seat_id} activated — boarding_type=${boarding_type}, cabin_class=${cabin_class}`);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      ok:           true,
      seat_id,
      boarding_type,
      cabin_class,
      send_result:  sendResult.body,
    }),
  };
};
