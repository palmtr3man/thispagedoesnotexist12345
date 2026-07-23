/**
 * /api/seat-claim — Passenger self-seat-selection binding endpoint
 *
 * Purpose:
 *   Lets a passenger select an open seat without admin assignment. The endpoint
 *   resolves the public TUJ seat token server-side, verifies flight/passenger
 *   integrity, and writes one binding: seat + flight + passenger.
 *
 * Safety posture:
 *   - Public browser never sees Base44 internal row IDs.
 *   - Seat must be open/pending/available or already claimed by same passenger.
 *   - Seat must belong to requested active flight, or be safely unbound before claim.
 *   - Passenger may not claim two seats on the same flight when a seat list source is configured.
 *   - Does not trigger SendGrid; delivery remains downstream after evidence verification.
 */

const VALID_SEAT_ID = /^TUJ-[A-Z2-9]{6}$/;
const OPEN_STATUSES = new Set(['', 'open', 'pending', 'available']);
const HELD_STATUSES = new Set(['held', 'approved']);
const OCCUPIED_STATUSES = new Set(['opened', 'occupied', 'confirmed']);

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function base44Headers() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (apiKey) headers.api_key = apiKey;
  return headers;
}

function normalizeBase44SeatUrl(raw) {
  if (!raw) return '';
  if (raw.includes('theultimatejourney.base44.app')) {
    return ((process.env.BASE44_APP_ID) ? ('https://app.base44.com/api/apps/' + process.env.BASE44_APP_ID + '/entities/Seat') : '');
  }
  return raw.replace(/\/$/, '');
}

function normalizeFlightId(value) {
  return String(value || '').trim().replace(/\s+/g, '_');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function pickArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return data ? [data] : [];
}

function seatCode(seat) {
  return seat?.tuj_code || seat?.seat_id || seat?.code || '';
}

function seatPassengerId(seat) {
  return String(seat?.assigned_passenger_id || seat?.passenger_id || seat?.user_id || '').trim();
}

function seatEmail(seat) {
  return normalizeEmail(seat?.user_email || seat?.email || seat?.passenger_email || '');
}

function seatFlight(seat) {
  return normalizeFlightId(seat?.flight_id || seat?.flight_code || seat?.active_flight_id || seat?.flight || '');
}

function seatStatus(seat) {
  return String(seat?.status || seat?.seat_status || '').trim().toLowerCase();
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

function samePassenger(seat, passengerId, passengerEmail) {
  const existingPassengerId = seatPassengerId(seat);
  const existingEmail = seatEmail(seat);
  return Boolean(
    (passengerId && existingPassengerId && passengerId === existingPassengerId) ||
    (passengerEmail && existingEmail && passengerEmail === existingEmail)
  );
}

function buildIdempotencyKey({ flightId, passengerId, passengerEmail, seatId }) {
  const subject = passengerId || passengerEmail || 'unknown_passenger';
  return `seat_claim:${flightId || 'unknown_flight'}:${subject}:${seatId || 'unknown_seat'}`;
}

async function fetchSeatByCode(base44SeatUrl, seatId) {
  const res = await fetch(`${base44SeatUrl}?tuj_code=${encodeURIComponent(seatId)}`, {
    method: 'GET',
    headers: base44Headers(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Base44 seat lookup failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return pickArray(await res.json())[0] || null;
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
  const internalId = seat?.id || seat?._id;
  if (!internalId) throw new Error('Seat record is missing internal Base44 id/_id');
  const res = await fetch(`${base44SeatUrl}/${encodeURIComponent(internalId)}`, {
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

function findPassengerConflict({ seats, targetSeat, flightId, passengerId, passengerEmail }) {
  if (!seats.length || (!passengerId && !passengerEmail)) return null;
  const targetCode = seatCode(targetSeat);
  return seats.find((seat) => {
    if (seatCode(seat) === targetCode) return false;
    const f = seatFlight(seat);
    if (f && flightId && f !== flightId) return false;
    if (!samePassenger(seat, passengerId, passengerEmail)) return false;
    const status = seatStatus(seat);
    return HELD_STATUSES.has(status) || OCCUPIED_STATUSES.has(status);
  }) || null;
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

  const seatId = String(payload.seat_id || payload.tuj_code || '').trim().replace(/\s+/g, '_');
  const flightId = normalizeFlightId(payload.flight_id || process.env.ACTIVE_FLIGHT_ID || process.env.ACTIVE_FLIGHT_CODE || '');
  const passengerId = String(payload.passenger_id || payload.assigned_passenger_id || '').trim();
  const passengerEmail = normalizeEmail(payload.passenger_email || payload.email || '');
  const expectedSeatNumber = payload.expected_seat_number === undefined ? null : Number(payload.expected_seat_number);
  const origin = payload.origin || 'passenger-seat-selection';

  if (!seatId || !VALID_SEAT_ID.test(seatId)) return json(400, { ok: false, error: 'invalid_seat_id', detail: 'seat_id must match TUJ-XXXXXX' });
  if (!flightId) return json(400, { ok: false, error: 'missing_flight_id' });
  if (!passengerId && !passengerEmail) return json(400, { ok: false, error: 'missing_passenger_identity', detail: 'passenger_id or passenger_email is required' });
  if (payload.expected_seat_number !== undefined && !Number.isFinite(expectedSeatNumber)) return json(400, { ok: false, error: 'invalid_expected_seat_number' });

  const base44SeatUrl = normalizeBase44SeatUrl(process.env.BASE44_SEAT_URL);
  const base44SeatListUrl = process.env.BASE44_SEAT_LIST_URL || '';
  if (!base44SeatUrl) return json(502, { ok: false, error: 'BASE44_SEAT_URL_not_configured' });

  let seat;
  try {
    seat = await fetchSeatByCode(base44SeatUrl, seatId);
  } catch (err) {
    return json(err.status === 404 ? 404 : 502, { ok: false, error: 'seat_lookup_failed', detail: err.message });
  }
  if (!seat) return json(404, { ok: false, error: 'seat_not_found', seat_id: seatId });

  const currentFlight = seatFlight(seat);
  const currentStatus = seatStatus(seat);
  const currentSeatNumber = seatNumber(seat);
  const idempotencyKey = buildIdempotencyKey({ flightId, passengerId, passengerEmail, seatId });

  if (Number.isFinite(expectedSeatNumber) && currentSeatNumber !== null && currentSeatNumber !== expectedSeatNumber) {
    return json(409, { ok: false, error: 'seat_number_mismatch', seat_id: seatId, expected_seat_number: expectedSeatNumber, actual_seat_number: currentSeatNumber });
  }

  if (currentFlight && currentFlight !== flightId) {
    return json(409, { ok: false, error: 'seat_not_in_flight', seat_id: seatId, expected_flight_id: flightId, actual_flight_id: currentFlight });
  }

  if (samePassenger(seat, passengerId, passengerEmail) && (seat.seat_claim_idempotency_key === idempotencyKey || HELD_STATUSES.has(currentStatus) || OCCUPIED_STATUSES.has(currentStatus))) {
    return json(200, { ok: true, status: currentStatus || 'held', duplicate: true, seat_id: seatId, flight_id: flightId, passenger_id: passengerId || seatPassengerId(seat) || null, idempotency_key: idempotencyKey });
  }

  if (!OPEN_STATUSES.has(currentStatus)) {
    return json(409, { ok: false, error: 'seat_already_taken', seat_id: seatId, prior_status: currentStatus || 'unknown' });
  }

  let seats = [];
  if (base44SeatListUrl) {
    try {
      seats = await fetchSeatList(base44SeatListUrl);
    } catch (err) {
      return json(502, { ok: false, error: 'seat_list_lookup_failed', detail: err.message });
    }
  }

  const conflict = findPassengerConflict({ seats, targetSeat: seat, flightId, passengerId, passengerEmail });
  if (conflict) {
    return json(409, {
      ok: false,
      error: 'passenger_already_has_seat',
      flight_id: flightId,
      requested_seat_id: seatId,
      existing_seat_id: seatCode(conflict),
      existing_status: seatStatus(conflict),
    });
  }

  const now = new Date().toISOString();
  const fields = {
    status: 'approved',
    flight_id: flightId,
    assigned_passenger_id: passengerId || seatPassengerId(seat) || null,
    passenger_id: passengerId || seatPassengerId(seat) || null,
    user_email: passengerEmail || seatEmail(seat) || null,
    seat_claimed_at: now,
    seat_claim_origin: origin,
    seat_claim_idempotency_key: idempotencyKey,
  };

  let updatedSeat;
  try {
    updatedSeat = await patchSeat(base44SeatUrl, seat, fields);
  } catch (err) {
    return json(502, { ok: false, error: 'seat_update_failed', detail: err.message });
  }

  return json(200, {
    ok: true,
    status: 'held',
    seat_id: seatId,
    flight_id: flightId,
    passenger_id: fields.passenger_id,
    passenger_email: fields.user_email,
    seat_number: seatNumber({ ...seat, ...updatedSeat, ...fields }),
    idempotency_key: idempotencyKey,
  });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.handler = exports.handler;
}
