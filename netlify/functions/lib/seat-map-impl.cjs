/**
 * /api/seat-map — Passenger-safe seat map for self-selection
 *
 * Returns public seat tokens and passenger-facing status for a flight. Internal
 * Base44 row IDs are intentionally omitted.
 */

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function resolveBase44ApiKey() {
  const direct = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (direct) return direct;
  const raw = process.env.BASE44_AUTH_JSON;
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.apiKey || parsed?.api_key || '').trim();
  } catch {
    return '';
  }
}

function base44Headers() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = resolveBase44ApiKey();
  if (apiKey) headers.api_key = apiKey;
  return headers;
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

function normalizeBase44SeatListUrl(raw) {
  if (!raw) return '';
  if (raw.includes('theultimatejourney.base44.app')) {
    const appId = process.env.BASE44_APP_ID || '';
    return appId ? `https://app.base44.com/api/apps/${appId}/entities/Seat` : '';
  }
  return raw.replace(/\/$/, '');
}

function seatCode(seat) {
  return seat?.tuj_code || seat?.seat_id || seat?.code || '';
}

function seatFlight(seat) {
  return normalizeFlightId(seat?.flight_id || seat?.flight_code || seat?.active_flight_id || seat?.flight || '');
}

function seatPassengerId(seat) {
  return String(seat?.assigned_passenger_id || seat?.passenger_id || seat?.user_id || '').trim();
}

function seatEmail(seat) {
  return normalizeEmail(seat?.user_email || seat?.email || seat?.passenger_email || '');
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

function publicStatus(seat, passengerId, passengerEmail) {
  const status = String(seat?.status || seat?.seat_status || '').trim().toLowerCase();
  const samePassenger = Boolean(
    (passengerId && seatPassengerId(seat) && passengerId === seatPassengerId(seat)) ||
    (passengerEmail && seatEmail(seat) && passengerEmail === seatEmail(seat))
  );
  if (samePassenger) return 'you';
  if (status === 'open' || status === 'pending' || status === 'available' || !status) return 'open';
  if (status === 'held' || status === 'approved') return 'held';
  return 'occupied';
}

async function fetchSeatList(base44SeatListUrl) {
  const res = await fetch(base44SeatListUrl, { method: 'GET', headers: base44Headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Base44 seat list lookup failed: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  return pickArray(await res.json());
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });

  const qp = event.queryStringParameters || {};
  const flightId = normalizeFlightId(qp.flight_id || process.env.ACTIVE_FLIGHT_ID || process.env.ACTIVE_FLIGHT_CODE || '');
  const passengerId = String(qp.passenger_id || '').trim();
  const passengerEmail = normalizeEmail(qp.passenger_email || qp.email || '');
  const base44SeatListUrl = normalizeBase44SeatListUrl(process.env.BASE44_SEAT_LIST_URL || process.env.BASE44_SEAT_URL || '');

  if (!flightId) return json(400, { ok: false, error: 'missing_flight_id' });
  if (!base44SeatListUrl) return json(502, { ok: false, error: 'BASE44_SEAT_LIST_URL_not_configured' });

  let seats;
  try {
    seats = await fetchSeatList(base44SeatListUrl);
  } catch (err) {
    return json(502, { ok: false, error: 'seat_list_lookup_failed', detail: err.message });
  }

  const publicSeats = seats
    .filter((seat) => {
      const f = seatFlight(seat);
      return !f || f === flightId;
    })
    .map((seat) => ({
      seat_id: seatCode(seat),
      seat_number: seatNumber(seat),
      status: publicStatus(seat, passengerId, passengerEmail),
      selectable: publicStatus(seat, passengerId, passengerEmail) === 'open',
    }))
    .filter((seat) => seat.seat_id)
    .sort((a, b) => (a.seat_number || 999) - (b.seat_number || 999));

  return json(200, {
    ok: true,
    flight_id: flightId,
    seats: publicSeats,
    seats_open: publicSeats.filter((seat) => seat.status === 'open').length,
    seats_held: publicSeats.filter((seat) => seat.status === 'held').length,
    seats_occupied: publicSeats.filter((seat) => seat.status === 'occupied').length,
    has_selection: publicSeats.some((seat) => seat.status === 'you'),
  });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.handler = exports.handler;
}
