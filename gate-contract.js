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
  BEEHIIV_PUB_ID: 'pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf',

  // --- Age gate (Gate Contract §5) ---
  MIN_AGE: 21,

  // --- Seat identity (Gate Contract §3) ---
  MAX_SEATS:      5,
  SEAT_ID_PREFIX: 'TUJ-',
  SEAT_ID_REGEX:  /^TUJ-[A-Z2-9]{6}$/,
  SESSION_KEY:    'seat_id',

  // --- Intake modes ---
  INTAKE_MODES: ['SENDGRID', 'CALENDARJET', 'CONSTANTCONTACT'],

  // --- Gate status values ---
  GATE_STATUS: {
    OPEN:     'open',
    CLOSED:   'closed',
    DEPARTED: 'departed'
  },

  // --- Flight status values ---
  FLIGHT_STATUS: {
    SCHEDULED:     'SCHEDULED',
    BOARDING_SOON: 'BOARDING_SOON',
    DEPARTED:      'DEPARTED'
  }
};

/**
 * resolveState() — Two-State Machine (.com)
 *
 * Reads gate status + sessionStorage seat_id and returns the view to render.
 * Call this on DOMContentLoaded on the .com landing page.
 *
 * Returns one of: 'departed' | 'dashboard' | 'landing'
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
    const res    = await fetch(GATE.SEAT_STATUS);
    const status = await res.json();

    const departed = status.nextflightstatus === GATE.FLIGHT_STATUS.DEPARTED
                  || status.gate_status      === GATE.GATE_STATUS.DEPARTED;

    if (departed) return 'departed';

    // Check sessionStorage first, then URL param
    const seatId = sessionStorage.getItem(GATE.SESSION_KEY)
                || new URLSearchParams(location.search).get('seat_id');

    if (seatId && GATE.SEAT_ID_REGEX.test(seatId)) {
      // Persist to sessionStorage if it came from URL
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
export async function requestSeat(payload) {
  const res  = await fetch(GATE.REQUEST_SEAT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });
  const data = await res.json();

  if (data.ok && data.seat_id) {
    // Store seat_id in sessionStorage immediately
    sessionStorage.setItem(GATE.SESSION_KEY, data.seat_id);
  }

  return data;
}
