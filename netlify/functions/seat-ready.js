/**
 * /api/seat-ready — Ready-click canonical seating transaction
 *
 * Purpose:
 *   Passenger Ready-click endpoint for confirming an existing held seat or,
 *   when a safe list source exists, assigning the next eligible open seat.
 *
 * Safety posture:
 *   - Does not silently resolve conflicting seat records.
 *   - Uses a stable idempotency key per flight + seat/passenger.
 *   - Triggers handleSeatOpened only after the Base44 write succeeds and only
 *     when READY_CLICK_SEND_ENABLED=true.
 *   - Returns the existing opened seat on duplicate Ready clicks.
 *   - Open-seat auto-assignment is disabled unless READY_CLICK_OPEN_ASSIGNMENT_ENABLED=true.
 *
 * Route: POST /api/seat-ready
 *
 * Request body:
 *   {
 *     seat_id?: string,              // TUJ-XXXXXX, preferred when deep-linked
 *     passenger_email?: string,      // optional conflict lookup / assignment key
 *     passenger_id?: string,         // optional idempotency key fallback
 *     flight_id?: string,            // defaults to ACTIVE_FLIGHT_CODE/ACTIVE_FLIGHT_ID
 *     expected_seat_number?: number, // optional QA guard for known canonical seat
 *     boarding_type?: string,        // default: standard
 *     cabin_class?: string,          // default: Economy
 *     origin?: string                // default: check-in-runway-ready
 *   }
 *
 * Success:
 *   { ok: true, status, seat_id, idempotency_key, send_result? }
 *
 * Blocked / QA required:
 *   { ok: false, error: 'qa_reconciliation_required', reason, ... }
 *
 * Legacy Zapier path:
 *   Full Base44 Seat entity payloads (internal id + tuj_code) still route to
 *   sendSeatConfirmation when x-seat-api-secret matches SEAT_API_SECRET.
 */

const crypto = require('crypto');
const { sendSeatConfirmation } = require('./sendgrid-integration.js');

const VALID_SEAT_ID = /^TUJ-[A-Z2-9]{6}$/;
const FETCH_TIMEOUT_MS = 8000;
const VALID_BOARDING_TYPES = ['executive_pre', 'standard', 'vip', 'beta', 'sponsored'];
const VALID_CABIN_CLASSES = ['First', 'Sponsored', 'Economy'];

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-seat-api-secret, x-passenger-ready-token',
  'Content-Type': 'application/json',
};

function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function headerValue(headers, name) {
  if (!headers) return '';
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function requireServerSecret(event) {
  const secret = process.env.SEAT_API_SECRET || process.env.ADMIN_SECRET || '';
  if (!secret) return true;
  const supplied = headerValue(event.headers, 'x-seat-api-secret');
  return safeCompare(supplied, secret);
}

function extractBearerToken(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function verifyPassengerAuth(event) {
  const token = extractBearerToken(headerValue(event.headers, 'authorization')) || headerValue(event.headers, 'x-passenger-ready-token');
  const expected = process.env.READY_CLICK_PASSENGER_TOKEN || process.env.PASSENGER_READY_TOKEN || process.env.PASSENGER_AUTH_TOKEN || '';
  return Boolean(expected && token && safeCompare(token, expected));
}

function isLegacySeatOpenedPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if ('passenger_email' in payload || 'expected_seat_number' in payload) return false;
  const origin = String(payload.origin || '');
  if (/ready|studio-b06/i.test(origin)) return false;
  return Boolean((payload.id || payload._id) && (payload.seat_id || payload.tuj_code));
}

async function handleLegacySeatOpened(event, payload) {
  if (!requireServerSecret(event)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  if (!payload.id && !payload.seat_id && !payload.tuj_code) {
    return json(400, { ok: false, error: 'missing_seat_identity' });
  }
  const result = await sendSeatConfirmation(payload);
  if (!result || !result.success) {
    return json(502, { ok: false, error: result?.error || 'seat_opened_dispatch_failed' });
  }
  return json(200, { ok: true, skipped: Boolean(result.skipped) });
}

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function normalizeFlightId(value) {
  return String(value || '').trim().replace(/\s+/g, '_');
}

function base44Headers() {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (apiKey) headers.api_key = apiKey;
  return headers;
}

function normalizeBase44SeatUrl(raw) {
  if (!raw) return '';
  if (raw.includes('theultimatejourney.base44.app')) {
    return 'https://app.base44.com/api/apps/697140e628131a06045ebd18/entities/Seat';
  }
  return raw.replace(/\/$/, '');
}

function pickArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return data ? [data] : [];
}

function seatCode(seat) {
  return seat?.tuj_code || seat?.seat_id || seat?.id || seat?.code || '';
}

function seatEmail(seat) {
  return String(seat?.user_email || seat?.email || seat?.passenger_email || '').trim().toLowerCase();
}

function seatPassengerId(seat) {
  return String(seat?.passenger_id || seat?.user_id || seat?.passenger || '').trim();
}

function seatFlight(seat) {
  return normalizeFlightId(seat?.flight_id || seat?.flight_code || seat?.active_flight_id || seat?.flight || '');
}

function seatNumber(seat) {
  const raw = seat?.seat_number ?? seat?.seat ?? seat?.seat_index;
  if (raw === null || raw === undefined || raw === '') return null;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const match = String(raw).trim().match(/(?:^|[^0-9])([0-9]+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOpenLike(status) {
  const st = String(status || '').toLowerCase();
  return st === 'pending' || st === 'open' || st === 'available';
}

function isHeldLike(status) {
  const st = String(status || '').toLowerCase();
  return st === 'approved' || st === 'held';
}

function isOpenedLike(status) {
  const st = String(status || '').toLowerCase();
  return st === 'opened' || st === 'occupied' || st === 'confirmed';
}

function buildIdempotencyKey({ flightId, seatId, passengerId, passengerEmail }) {
  const subject = seatId || passengerId || String(passengerEmail || '').trim().toLowerCase();
  return `ready_click:${flightId || 'unknown_flight'}:${subject || 'unknown_subject'}`;
}

async function fetchSeat(base44SeatUrl, seatId) {
  const url = `${base44SeatUrl}?tuj_code=${encodeURIComponent(seatId)}`;
  const res = await timedFetch(url, { method: 'GET', headers: base44Headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Base44 seat lookup failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return pickArray(data)[0] || null;
}

async function fetchSeatList(base44SeatListUrl) {
  if (!base44SeatListUrl) return [];
  const res = await timedFetch(base44SeatListUrl, { method: 'GET', headers: base44Headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Base44 seat list lookup failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return pickArray(await res.json());
}

async function patchSeat(base44SeatUrl, seat, fields) {
  const internalId = seat.id || seat._id;
  if (!internalId) throw new Error('Seat record is missing internal Base44 id/_id');
  const res = await timedFetch(`${base44SeatUrl}/${internalId}`, {
    method: 'PUT',
    headers: base44Headers(),
    body: JSON.stringify({ ...seat, ...fields }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Base44 seat update failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function triggerSend(siteUrl, seat) {
  const res = await timedFetch(`${siteUrl}/.netlify/functions/sendgrid-integration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seat),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function acquireIdempotencyGuard({ idempotencyKey, targetSeatId, flightId, passengerEmail }) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  const table = process.env.READY_CLICK_IDEMPOTENCY_TABLE || 'ready_click_idempotency';

  if (!supabaseUrl || !serviceRoleKey) {
    return { ok: false, unavailable: true, reason: 'idempotency_store_not_configured' };
  }

  const now = new Date().toISOString();
  const res = await timedFetch(`${supabaseUrl}/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      seat_id: targetSeatId,
      flight_id: flightId || null,
      passenger_email: passengerEmail || null,
      status: 'started',
      created_at: now,
      updated_at: now,
    }),
  });

  if (res.status === 409) return { ok: false, duplicate: true };
  if (!res.ok) return { ok: false, unavailable: true, reason: 'idempotency_store_write_failed' };

  const body = await res.json().catch(() => []);
  if (Array.isArray(body) && body.length === 0) return { ok: false, duplicate: true };
  return { ok: true };
}

async function completeIdempotencyGuard({ idempotencyKey, status }) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  const table = process.env.READY_CLICK_IDEMPOTENCY_TABLE || 'ready_click_idempotency';
  if (!supabaseUrl || !serviceRoleKey || !idempotencyKey) return;

  await timedFetch(`${supabaseUrl}/rest/v1/${encodeURIComponent(table)}?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  }).catch(() => null);
}

function findPassengerConflicts({ seats, targetSeat, passengerEmail, flightId }) {
  const email = String(passengerEmail || seatEmail(targetSeat) || '').toLowerCase();
  if (!email) return [];
  const targetCode = seatCode(targetSeat);
  return seats.filter((seat) => {
    if (seat === targetSeat) return false;
    if (seatCode(seat) === targetCode) return false;
    if (seatEmail(seat) !== email) return false;
    const f = seatFlight(seat);
    return !f || !flightId || f === flightId;
  });
}

function chooseOpenSeat({ seats, flightId }) {
  const candidates = seats
    .filter((seat) => isOpenLike(seat.status || seat.seat_status))
    .filter((seat) => {
      const f = seatFlight(seat);
      return !f || !flightId || f === flightId;
    })
    .sort((a, b) => (seatNumber(a) || 999) - (seatNumber(b) || 999));
  return candidates[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'invalid_json_body' });
  }

  if (isLegacySeatOpenedPayload(payload)) {
    return handleLegacySeatOpened(event, payload);
  }

  const rawSeatId = String(payload.seat_id || payload.tuj_code || '').trim().replace(/\s+/g, '_');
  const passengerEmail = String(payload.passenger_email || '').trim().toLowerCase();
  const passengerId = String(payload.passenger_id || '').trim();

  if (!requireServerSecret(event) && !verifyPassengerAuth(event)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const flightId = normalizeFlightId(payload.flight_id || process.env.ACTIVE_FLIGHT_ID || process.env.ACTIVE_FLIGHT_CODE || '');
  const expectedSeatNumber = payload.expected_seat_number === undefined ? null : Number(payload.expected_seat_number);
  const boardingType = payload.boarding_type || 'standard';
  const cabinClass = payload.cabin_class || 'Economy';
  const origin = payload.origin || 'check-in-runway-ready';

  if (rawSeatId && !VALID_SEAT_ID.test(rawSeatId)) {
    return json(400, { ok: false, error: 'invalid_seat_id' });
  }
  if (!rawSeatId && !passengerEmail && !passengerId) {
    return json(400, { ok: false, error: 'missing_subject' });
  }
  if (!VALID_BOARDING_TYPES.includes(boardingType)) {
    return json(400, { ok: false, error: 'invalid_boarding_type', valid: VALID_BOARDING_TYPES });
  }
  if (!VALID_CABIN_CLASSES.includes(cabinClass)) {
    return json(400, { ok: false, error: 'invalid_cabin_class', valid: VALID_CABIN_CLASSES });
  }

  const base44SeatUrl = normalizeBase44SeatUrl(process.env.BASE44_SEAT_URL);
  const base44SeatListUrl = process.env.BASE44_SEAT_LIST_URL || '';
  const siteUrl = (process.env.SITE_URL || 'https://thispagedoesnotexist12345.com').replace(/\/$/, '');
  const sendEnabled = process.env.READY_CLICK_SEND_ENABLED === 'true';
  const openAssignmentEnabled = process.env.READY_CLICK_OPEN_ASSIGNMENT_ENABLED === 'true';

  if (!base44SeatUrl) return json(502, { ok: false, error: 'BASE44_SEAT_URL_not_configured' });

  let seats = [];
  if (base44SeatListUrl) {
    try {
      seats = await fetchSeatList(base44SeatListUrl);
    } catch (err) {
      return json(502, { ok: false, error: 'seat_list_lookup_failed' });
    }
  }

  let seat = null;
  if (rawSeatId) {
    try {
      seat = await fetchSeat(base44SeatUrl, rawSeatId);
    } catch (err) {
      return json(err.status === 404 ? 404 : 502, { ok: false, error: 'seat_lookup_failed' });
    }
    if (!seat) return json(404, { ok: false, error: 'seat_not_found', seat_id: rawSeatId });
  } else {
    if (!openAssignmentEnabled) {
      return json(409, {
        ok: false,
        error: 'qa_reconciliation_required',
        reason: 'open_seat_assignment_disabled',
      });
    }
    seat = chooseOpenSeat({ seats, flightId });
    if (!seat) return json(409, { ok: false, error: 'waitlist_required', reason: 'no_open_seat_available', flight_id: flightId });
  }

  const targetSeatId = seatCode(seat) || rawSeatId;
  const targetSeatNumber = seatNumber(seat);
  const targetStatus = String(seat.status || seat.seat_status || '').toLowerCase();
  const targetEmail = seatEmail(seat);
  const targetPassengerId = seatPassengerId(seat);
  const explicitHeldSeat = Boolean(rawSeatId && (targetEmail || targetPassengerId));
  const idempotencyKey = buildIdempotencyKey({ flightId, seatId: targetSeatId, passengerId, passengerEmail });

  if (targetEmail && passengerEmail && targetEmail !== passengerEmail) {
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: 'passenger_email_mismatch',
      seat_id: targetSeatId,
      expected_email: targetEmail.replace(/^(.).+(@.+)$/, '$1***$2'),
      supplied_email: passengerEmail.replace(/^(.).+(@.+)$/, '$1***$2'),
    });
  }

  if (targetPassengerId && passengerId && targetPassengerId !== passengerId) {
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: 'passenger_id_mismatch',
      seat_id: targetSeatId,
    });
  }

  if (rawSeatId && explicitHeldSeat && !passengerEmail && !passengerId) {
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: 'passenger_identity_required_for_assigned_seat',
      seat_id: targetSeatId,
    });
  }

  if (Number.isFinite(expectedSeatNumber) && targetSeatNumber !== null && targetSeatNumber !== expectedSeatNumber) {
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: 'seat_number_mismatch',
      expected_seat_number: expectedSeatNumber,
      actual_seat_number: targetSeatNumber,
      seat_id: targetSeatId,
    });
  }

  const conflicts = findPassengerConflicts({ seats, targetSeat: seat, passengerEmail, flightId });
  if (conflicts.length > 0) {
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: 'multiple_seat_records_for_passenger',
      seat_id: targetSeatId,
      conflicting_seats: conflicts.map((s) => ({ seat_id: seatCode(s), seat_number: seatNumber(s), status: s.status || s.seat_status })),
    });
  }

  if (seat.ready_idempotency_key === idempotencyKey || isOpenedLike(targetStatus)) {
    return json(200, {
      ok: true,
      status: 'already_opened',
      duplicate: true,
      seat_id: targetSeatId,
      idempotency_key: idempotencyKey,
    });
  }

  if (!(isHeldLike(targetStatus) || isOpenLike(targetStatus) || !targetStatus)) {
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: 'unsupported_prior_seat_status',
      seat_id: targetSeatId,
      prior_status: targetStatus || 'unknown',
    });
  }

  const now = new Date().toISOString();
  const guard = await acquireIdempotencyGuard({ idempotencyKey, targetSeatId, flightId, passengerEmail });
  if (guard.duplicate) {
    return json(200, {
      ok: true,
      status: 'already_opened',
      duplicate: true,
      seat_id: targetSeatId,
      idempotency_key: idempotencyKey,
    });
  }
  const guardOptional = process.env.READY_CLICK_IDEMPOTENCY_GUARD_OPTIONAL === 'true';
  if (guard.unavailable && !guardOptional) {
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: guard.reason || 'idempotency_guard_unavailable',
      seat_id: targetSeatId,
      idempotency_key: idempotencyKey,
    });
  }

  const fields = {
    status: 'opened',
    boarding_type: boardingType,
    cabin_class: cabinClass,
    ready_clicked_at: now,
    ready_origin: origin,
    ready_idempotency_key: idempotencyKey,
  };
  if (flightId) fields.flight_id = flightId;
  if (passengerEmail && !targetEmail) fields.user_email = passengerEmail;
  if (passengerId && !targetPassengerId) fields.passenger_id = passengerId;

  let updatedSeat;
  try {
    updatedSeat = await patchSeat(base44SeatUrl, seat, fields);
  } catch (err) {
    await completeIdempotencyGuard({ idempotencyKey, status: 'seat_update_failed' });
    return json(502, { ok: false, error: 'seat_update_failed' });
  }

  const updatedStatus = String(updatedSeat?.status || updatedSeat?.seat_status || fields.status || '').toLowerCase();
  const updatedIdempotencyKey = updatedSeat?.ready_idempotency_key || fields.ready_idempotency_key;
  if (!isOpenedLike(updatedStatus) || updatedIdempotencyKey !== idempotencyKey) {
    await completeIdempotencyGuard({ idempotencyKey, status: 'post_update_state_mismatch' });
    return json(409, {
      ok: false,
      error: 'qa_reconciliation_required',
      reason: 'post_update_state_mismatch',
      seat_id: targetSeatId,
      idempotency_key: idempotencyKey,
    });
  }

  const seatForSend = { ...seat, ...updatedSeat, ...fields, tuj_code: targetSeatId };
  let sendResult = null;
  if (sendEnabled) {
    try {
      sendResult = await triggerSend(siteUrl, seatForSend);
    } catch (err) {
      await completeIdempotencyGuard({ idempotencyKey, status: 'sendgrid_trigger_failed' });
      return json(502, { ok: false, error: 'sendgrid_trigger_failed', seat_id: targetSeatId, idempotency_key: idempotencyKey });
    }
    if (sendResult.status !== 200) {
      await completeIdempotencyGuard({ idempotencyKey, status: 'handleSeatOpened_failed' });
      return json(502, { ok: false, error: 'handleSeatOpened_failed', seat_id: targetSeatId, idempotency_key: idempotencyKey });
    }
  }

  await completeIdempotencyGuard({ idempotencyKey, status: sendEnabled ? 'sent' : 'opened_no_send' });

  return json(200, {
    ok: true,
    status: 'opened',
    seat_id: targetSeatId,
    idempotency_key: idempotencyKey,
    send_enabled: sendEnabled,
    send_result: sendResult ? sendResult.body : null,
  });
};
