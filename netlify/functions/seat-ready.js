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
 */

const VALID_SEAT_ID = /^TUJ-[A-Z2-9]{6}$/;
const VALID_BOARDING_TYPES = ['executive_pre', 'standard', 'vip', 'beta', 'sponsored'];
const VALID_CABIN_CLASSES = ['First', 'Sponsored', 'Economy'];

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

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

function seatFlight(seat) {
  return normalizeFlightId(seat?.flight_id || seat?.flight_code || seat?.active_flight_id || seat?.flight || '');
}

function seatNumber(seat) {
  const raw = seat?.seat_number ?? seat?.seat ?? seat?.seat_index;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
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
  const res = await fetch(url, { method: 'GET', headers: base44Headers() });
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
  const res = await fetch(base44SeatListUrl, { method: 'GET', headers: base44Headers() });
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
  const res = await fetch(`${base44SeatUrl}/${internalId}`, {
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
  const res = await fetch(`${siteUrl}/.netlify/functions/sendgrid-integration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seat),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

  const rawSeatId = String(payload.seat_id || payload.tuj_code || '').trim().replace(/\s+/g, '_');
  const passengerEmail = String(payload.passenger_email || '').trim().toLowerCase();
  const passengerId = String(payload.passenger_id || '').trim();
  const flightId = normalizeFlightId(payload.flight_id || process.env.ACTIVE_FLIGHT_ID || process.env.ACTIVE_FLIGHT_CODE || '');
  const expectedSeatNumber = payload.expected_seat_number === undefined ? null : Number(payload.expected_seat_number);
  const boardingType = payload.boarding_type || 'standard';
  const cabinClass = payload.cabin_class || 'Economy';
  const origin = payload.origin || 'check-in-runway-ready';

  if (rawSeatId && !VALID_SEAT_ID.test(rawSeatId)) {
    return json(400, { ok: false, error: 'invalid_seat_id', detail: 'seat_id must match TUJ-XXXXXX' });
  }
  if (!rawSeatId && !passengerEmail && !passengerId) {
    return json(400, { ok: false, error: 'missing_subject', detail: 'seat_id, passenger_email, or passenger_id is required' });
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

  if (!base44SeatUrl) return json(502, { ok: false, error: 'BASE44_SEAT_URL_not_configured' });

  let seats = [];
  if (base44SeatListUrl) {
    try {
      seats = await fetchSeatList(base44SeatListUrl);
    } catch (err) {
      return json(502, { ok: false, error: 'seat_list_lookup_failed', detail: err.message });
    }
  }

  let seat = null;
  if (rawSeatId) {
    try {
      seat = await fetchSeat(base44SeatUrl, rawSeatId);
    } catch (err) {
      return json(err.status === 404 ? 404 : 502, { ok: false, error: 'seat_lookup_failed', detail: err.message });
    }
    if (!seat) return json(404, { ok: false, error: 'seat_not_found', seat_id: rawSeatId });
  } else {
    seat = chooseOpenSeat({ seats, flightId });
    if (!seat) return json(409, { ok: false, error: 'waitlist_required', reason: 'no_open_seat_available', flight_id: flightId });
  }

  const targetSeatId = seatCode(seat) || rawSeatId;
  const targetSeatNumber = seatNumber(seat);
  const targetStatus = String(seat.status || seat.seat_status || '').toLowerCase();
  const idempotencyKey = buildIdempotencyKey({ flightId, seatId: targetSeatId, passengerId, passengerEmail });

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
  const fields = {
    status: 'opened',
    boarding_type: boardingType,
    cabin_class: cabinClass,
    ready_clicked_at: now,
    ready_origin: origin,
    ready_idempotency_key: idempotencyKey,
  };
  if (flightId) fields.flight_id = flightId;
  if (passengerEmail && !seatEmail(seat)) fields.user_email = passengerEmail;

  let updatedSeat;
  try {
    updatedSeat = await patchSeat(base44SeatUrl, seat, fields);
  } catch (err) {
    return json(502, { ok: false, error: 'seat_update_failed', detail: err.message });
  }

  const seatForSend = { ...seat, ...updatedSeat, ...fields, tuj_code: targetSeatId };
  let sendResult = null;
  if (sendEnabled) {
    try {
      sendResult = await triggerSend(siteUrl, seatForSend);
    } catch (err) {
      return json(502, { ok: false, error: 'sendgrid_trigger_failed', detail: err.message, seat_id: targetSeatId, idempotency_key: idempotencyKey });
    }
    if (sendResult.status !== 200) {
      return json(502, { ok: false, error: 'handleSeatOpened_failed', seat_id: targetSeatId, idempotency_key: idempotencyKey, send_result: sendResult.body });
    }
  }

  return json(200, {
    ok: true,
    status: 'opened',
    seat_id: targetSeatId,
    idempotency_key: idempotencyKey,
    send_enabled: sendEnabled,
    send_result: sendResult ? sendResult.body : null,
  });
};
