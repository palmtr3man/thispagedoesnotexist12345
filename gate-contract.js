/**
 * gate-contract.js — Shared Interface Constants
 * The Ultimate Journey · .com ∓ .tech
 *
 * Single source of truth for gate state, seat identity, and API paths.
 * Both the .com landing/dashboard repo and the .tech boarding app must
 * import from this module — neither repo should hardcode these values.
 *
 * Gate Contract v1.1 · July 9, 2026
 */

export const GATE = {
  // --- API paths ---
  API_BASE:      'https://app.thispagedoesnotexist12345.com',
  SEAT_STATUS:   '/api/seat-status',
  REQUEST_SEAT:  '/api/seat-request',
  VALIDATE_SEAT: '/api/seat',

  // --- beehiiv ---
  BEEHIIV_PUB_ID: '',

  // --- Age gate ---
  MIN_AGE: 21,

  // --- Seat identity (Gate Contract §3) ---
  MAX_SEATS:      5,
  SEAT_ID_PREFIX: 'TUJ-',
  // REGEX-MIGRATE-01: Support dual-prefix seat IDs (Legacy TUJ- and Flight-bound FL-)
  SEAT_ID_REGEX:  /^(TUJ-[A-Z2-9]{6}|FL-[A-Z0-9-]{3,10})$/,
  SESSION_KEY:    'seat_id',
  TUJ_KEY:        'tuj_code',

  // --- Intake modes ---
  INTAKE_MODES: ['SENDGRID', 'CALENDARJET', 'CONSTANTCONTACT'],

  // --- Gate status values ---
  GATE_STATUS: {
    OPEN:          'open',
    CLOSED:        'closed',
    DEPARTED:      'departed',
    LEVEL_LOUNGE:  'lounge'
  },

  // --- Funnel stage values ---
  FUNNEL_STAGE: {
    REQUESTED:     'requested',
    LEVEL_LOUNGE:  'level_lounge',
    BOARDING:      'boarding',
    DEPARTED:      'departed'
  },

  // --- Flight status values ---
  FLIGHT_STATUS: {
    SCHEDULED:     'SCHEDULED',
    BOARDING_SOON: 'BOARDING_SOON',
    DEPARTED:      'DEPARTED',
    LEVEL_LOUNGE:  'LEVEL_LOUNGE'
  }
};

/** Cabin tiers written to PassengerFlight.cabin before BMAC redirect (Option A). */
export const CABIN_CLASSES = Object.freeze({
  ECONOMY:  'Economy',
  BUSINESS: 'Business',
  FIRST:    'First',
});

/** BMAC checkout surface — cabin must be stamped on PassengerFlight before redirect. */
export const BMAC_CHECKOUT = Object.freeze({
  SUPPORT_URL: 'https://buymeacoffee.com/theultimatejourney',
  PAID_CABINS: new Set(['Business', 'First']),
});

/** Maps PassengerFlight.cabin to Seat.cabin_class (boarding path enum). */
export function cabinToSeatClass(cabin) {
  const value = String(cabin || '').trim();
  if (value === CABIN_CLASSES.FIRST) return 'First';
  return CABIN_CLASSES.ECONOMY;
}

/**
 * prepareBmacCabinCheckout — Option A precondition write before BMAC redirect.
 *
 * @param {object} base44 — authenticated Base44 SDK client
 * @param {{ cabin: string, flightId?: string }} opts
 */
export async function prepareBmacCabinCheckout(base44, { cabin, flightId } = {}) {
  if (!base44?.entities?.PassengerFlight) {
    return { ok: false, error: 'base44_client_required' };
  }

  const normalizedCabin = String(cabin || '').trim();
  const validCabins = Object.values(CABIN_CLASSES);
  if (!validCabins.includes(normalizedCabin)) {
    return { ok: false, error: 'invalid_cabin', valid: validCabins };
  }

  const me = await base44.auth.me();
  if (!me?.id) {
    return { ok: false, error: 'auth_required' };
  }

  if (me.is_sponsored === true) {
    return { ok: false, error: 'sponsored_bypass' };
  }

  const filter = { passenger_id: me.id, bmac_payment_confirmed: false };
  if (flightId) filter.flight_id = String(flightId).trim();

  const rows = await base44.entities.PassengerFlight.filter(filter);
  if (!rows?.length) {
    return { ok: false, error: 'no_passenger_flight_row' };
  }

  const flight = rows.sort((a, b) => {
    const aTime = a.joined_at ? new Date(a.joined_at).getTime() : 0;
    const bTime = b.joined_at ? new Date(b.joined_at).getTime() : 0;
    return bTime - aTime;
  })[0];

  await base44.entities.PassengerFlight.update(flight.id, {
    cabin: normalizedCabin,
    bmac_payment_confirmed: false,
  });

  return {
    ok: true,
    passengerFlightId: flight.id,
    cabin: normalizedCabin,
    redirectUrl: BMAC_CHECKOUT.SUPPORT_URL,
  };
}

/**
 * resolveState() — Two-State Machine (.com)
 */
export async function resolveState() {
  try {
    const seatStatusUrl = new URL(GATE.SEAT_STATUS, location.origin);
    seatStatusUrl.searchParams.set('_ts', String(Date.now()));
    const res    = await fetch(seatStatusUrl.toString(), { cache: 'no-store' });
    const status = await res.json();

    const departed = status.nextflightstatus === GATE.FLIGHT_STATUS.DEPARTED
                  || status.gate_status      === GATE.GATE_STATUS.DEPARTED;

    const lounge = status.nextflightstatus === GATE.FLIGHT_STATUS.LEVEL_LOUNGE
                || status.next_flight_status === GATE.FLIGHT_STATUS.LEVEL_LOUNGE
                || status.gate_status === GATE.GATE_STATUS.LEVEL_LOUNGE
                || status.funnel_stage === GATE.FUNNEL_STAGE.LEVEL_LOUNGE
                || status.validation_stage === GATE.FUNNEL_STAGE.LEVEL_LOUNGE
                || status.seat_stage === GATE.FUNNEL_STAGE.LEVEL_LOUNGE
                || status.level_lounge === true;

    if (departed) return 'departed';
    if (lounge) return 'lounge';

    const params = new URLSearchParams(location.search);
    const urlSeatId = params.get('seat_id');
    const urlTujCode = params.get('tuj_code');
    const sessionSeatId = sessionStorage.getItem(GATE.SESSION_KEY);
    const sessionTujCode = sessionStorage.getItem(GATE.TUJ_KEY);

    let seatId = '';
    if (urlSeatId && GATE.SEAT_ID_REGEX.test(urlSeatId)) {
      seatId = urlSeatId;
      sessionStorage.setItem(GATE.SESSION_KEY, urlSeatId);
      if (urlTujCode) sessionStorage.setItem(GATE.TUJ_KEY, urlTujCode);
    } else if (urlTujCode) {
      sessionStorage.setItem(GATE.TUJ_KEY, urlTujCode);
      if (sessionTujCode && sessionTujCode === urlTujCode && sessionSeatId && GATE.SEAT_ID_REGEX.test(sessionSeatId)) {
        seatId = sessionSeatId;
      } else {
        sessionStorage.removeItem(GATE.SESSION_KEY);
        seatId = '';
      }
    } else if (sessionSeatId && GATE.SEAT_ID_REGEX.test(sessionSeatId)) {
      seatId = sessionSeatId;
    }

    if (seatId) {
      sessionStorage.setItem(GATE.SESSION_KEY, seatId);
      return 'dashboard';
    }

    return 'landing';
  } catch (err) {
    console.error('[gate-contract] resolveState error — defaulting to landing:', err);
    return 'landing';
  }
}

/**
 * requestSeat(payload) — Seat Request Helper
 */
async function readJsonResponse(res) {
  const text = await res.text();
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeBoardingType(boardingType) {
  const value = String(boardingType || 'first_class').trim().toLowerCase();
  return value || 'first_class';
}

export async function requestSeat(payload) {
  const tujCode = (payload && payload.tuj_code) || sessionStorage.getItem(GATE.TUJ_KEY) || new URLSearchParams(location.search).get('tuj_code') || '';
  const resolvedFlightCode = String((payload && payload.flight_code) || sessionStorage.getItem('tuj:flight_code') || '').trim();
  const resolvedCabinClass = String((payload && payload.cabin_class) || (payload && payload.cabin) || (payload && payload.boarding_type) || '').trim().toLowerCase();
  const cabinClass = resolvedCabinClass === 'first' || resolvedCabinClass === 'first_class' || resolvedCabinClass === 'paid' || resolvedCabinClass === 'vip'
    ? 'First'
    : (resolvedCabinClass === 'sponsored' ? 'Sponsored' : 'Economy');
  const requestBody = {
    ...payload,
    flight_code: resolvedFlightCode,
    cabin_class: (payload && payload.cabin_class) || cabinClass,
    seats_reserved: (payload && payload.seats_reserved) || 'F5-04',
    boarding_type: normalizeBoardingType(payload && payload.boarding_type),
    tuj_code: tujCode
  };
  const res  = await fetch(GATE.REQUEST_SEAT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(requestBody)
  });
  const data = await readJsonResponse(res);

  if (data.ok && data.seat_id) {
    sessionStorage.setItem(GATE.SESSION_KEY, data.seat_id);
    if (requestBody.tuj_code) sessionStorage.setItem(GATE.TUJ_KEY, requestBody.tuj_code);
    if (data.tuj_code) sessionStorage.setItem(GATE.TUJ_KEY, data.tuj_code);
  }

  return data;
}
