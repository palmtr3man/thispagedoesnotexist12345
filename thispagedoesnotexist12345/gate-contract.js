/**
 * gate-contract.js — Shared Interface Constants
 * The Ultimate Journey · .com ∓ .tech
 *
 * Single source of truth for gate state, seat identity, and API paths.
 * Both the .com landing/dashboard repo and the .tech boarding app must
 * import from this module — neither repo should hardcode these values.
 *
 * Gate Contract v1.0 · March 27, 2026
 */

export const GATE = {
  // --- API paths ---
  API_BASE:      'https://www.thispagedoesnotexist12345.com',
  SEAT_STATUS:   '/api/seat-status',
  REQUEST_SEAT:  '/api/seat-request',
  VALIDATE_SEAT: '/api/seat',          // GET /api/seat/:id (Base44 — pending credits)

  // --- beehiiv ---

  /**
   * @type {string} Beehiiv publication ID — set via Netlify BEEHIIV_PUB_ID (not hardcoded).
   * Signal resolves to https://newsletter.thispagedoesnotexist12345.us/
   */
  BEEHIIV_PUB_ID: '',

  // --- Age gate (Gate Contract §5) ---
  MIN_AGE: 21,

  // --- Seat identity (Gate Contract §3) ---
  MAX_SEATS:      5,
  SEAT_ID_PREFIX: 'TUJ-',
  SEAT_ID_REGEX:  /^TUJ-[A-Z2-9]{6}$/,
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

/**
 * resolveState() — Two-State Machine (.com)
 *
 * Reads gate status + sessionStorage seat_id and returns the view to render.
 * Call this on DOMContentLoaded on the .com landing page.
 *
 * Returns one of: 'departed' | 'lounge' | 'dashboard' | 'landing'
 *
 * Usage:
 *   import { resolveState } from '/gate-contract.js';
 *   const view = await resolveState();
 *   if (view === 'dashboard') renderDashboard();
 *   else if (view === 'departed') renderDeparted();
 *   else renderLanding();
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
 *
 * POSTs to /api/seat-request and returns the parsed response.
 * Caller is responsible for rendering success/error UI.
 *
 * @param {{ name: string, email: string, age_confirmed: boolean, source?: string }} payload
 * @returns {Promise<{ ok: boolean, seat_id?: string, status?: string, error?: string }>}
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
  // Future cabin-selection flows (for example, a BMAC checkout callback)
  // should pass the chosen cabin tier here; alpha cohorts default to first_class.
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
    // Store seat_id and any returned tuj_code in sessionStorage immediately
    sessionStorage.setItem(GATE.SESSION_KEY, data.seat_id);
    if (requestBody.tuj_code) sessionStorage.setItem(GATE.TUJ_KEY, requestBody.tuj_code);
    if (data.tuj_code) sessionStorage.setItem(GATE.TUJ_KEY, data.tuj_code);
  }

  return data;
}
