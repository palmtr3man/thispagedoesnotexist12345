/**
 * @fileoverview gate-contract.js — Shared Interface Constants
 * The Ultimate Journey · .com ⊓ .tech
 *
 * Single source of truth for gate state, seat identity, and API paths.
 * Both the .com landing/dashboard repo and the .tech boarding app must
 * import from this module — neither repo should hardcode these values.
 *
 * @version 1c
 * @since   2026-03-27
 * @updated 2026-04-05
 */

/**
 * @typedef {'open' | 'closed' | 'departed'} GateStatus
 * The three possible gate states returned by /api/seat-status.
 */

/**
 * @typedef {'SCHEDULED' | 'BOARDING_SOON' | 'DEPARTED'} FlightStatus
 * Admin-controlled flight display status stored in NextFlightConfig.
 */

/**
 * @typedef {'SENDGRID' | 'CALENDARJET' | 'CONSTANTCONTACT'} IntakeMode
 * Passenger intake channel. Controls which CTA steps are shown in the
 * boarding sequence (e.g. Step 05 consultation CTA is CALENDARJET-only).
 */

/**
 * @typedef {'departed' | 'dashboard' | 'landing'} ViewState
 * The three views the .com landing page can render, as resolved by resolveState().
 */

/**
 * @typedef {Object} SeatRequestPayload
 * @property {string}  name          - Passenger full name (trimmed).
 * @property {string}  email         - Passenger email address.
 * @property {boolean} age_confirmed - Must be true; enforces MIN_AGE gate.
 * @property {string}  [source]      - Optional intake source tag.
 */

/**
 * @typedef {Object} SeatRequestResponse
 * @property {boolean} ok         - True if seat was successfully reserved.
 * @property {string}  [seat_id]  - Assigned seat ID (e.g. "TUJ-AB1234") on success.
 * @property {string}  [status]   - Human-readable status message.
 * @property {string}  [error]    - Error message on failure.
 */

/**
 * GATE — Shared interface constants for The Ultimate Journey gate system.
 *
 * Import this object wherever gate state, seat identity, or API paths are
 * needed. Do not hardcode any of these values in application code.
 *
 * @namespace GATE
 */

export const GATE = {
  // --- API paths ---

  /** @type {string} Base URL for all TUJ API calls. */
  API_BASE:      'https://www.thispagedoesnotexist12345.com',

  /** @type {string} GET endpoint — returns gate status + flight metadata. */
  SEAT_STATUS:   '/api/seat-status',

  /** @type {string} POST endpoint — submits a new seat request. */
  REQUEST_SEAT:  '/api/seat-request',

  /**
   * @type {string} GET /api/seat/:id — validates a seat ID against Base44.
   * @note Pending Base44 credit restoration (Phase 5).
   */
  VALIDATE_SEAT: '/api/seat',

  // --- beehiiv ---

  /**
   * @type {string} Beehiiv publication ID for the Signal newsletter.
   * Signal always resolves to https://newsletter.thispagedoesnotexist12345.us/
   */
  BEEHIIV_PUB_ID: 'pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf',

  // --- Age gate (Gate Contract §5) ---

  /**
   * @type {number} Minimum passenger age. DOB must confirm age >= MIN_AGE.
   * Enforced on both .com and .tech surfaces.
   */
  MIN_AGE: 21,

  // --- Seat identity (Gate Contract §3) ---

  /** @type {number} Maximum seats per flight cohort. */
  MAX_SEATS:      5,

  /** @type {string} Prefix for all seat IDs (e.g. "TUJ-AB1234"). */
  SEAT_ID_PREFIX: 'TUJ-',

  /**
   * @type {RegExp} Validation regex for seat IDs.
   * Matches "TUJ-" followed by exactly 6 uppercase alphanumeric characters
   * (excluding 0, 1, O, I to avoid visual ambiguity).
   */
  SEAT_ID_REGEX:  /^TUJ-[A-Z2-9]{6}$/,

  /**
   * @type {string} sessionStorage key used to persist the seat ID across
   * page navigations within the same browser session.
   */
  SESSION_KEY:    'seat_id',

  // --- Intake modes ---

  /**
   * @type {IntakeMode[]} Supported passenger intake channels.
   * The active mode is set via the INTAKE_MODE Netlify environment variable.
   */
  INTAKE_MODES: ['SENDGRID', 'CALENDARJET', 'CONSTANTCONTACT'],

  // --- Gate status values ---

  /**
   * @type {{ OPEN: GateStatus, CLOSED: GateStatus, DEPARTED: GateStatus }}
   * Canonical gate status string constants. Use these instead of raw strings.
   */
  GATE_STATUS: {
    /** Gate is open — seat requests are accepted. */
    OPEN:     'open',
    /** Gate is closed — seat requests are blocked; landing page shows hold state. */
    CLOSED:   'closed',
    /** Flight has departed — all surfaces show the departed/waitlist view. */
    DEPARTED: 'departed'
  },

  // --- Flight status values ---

  /**
   * @type {{ SCHEDULED: FlightStatus, BOARDING_SOON: FlightStatus, DEPARTED: FlightStatus }}
   * Admin-controlled display status stored in the NextFlightConfig entity.
   * Drives countdown timer, departure badges, and boarding state UI.
   */
  FLIGHT_STATUS: {
    /** Flight is scheduled — countdown timer active. */
    SCHEDULED:     'SCHEDULED',
    /** Flight is boarding soon — boarding badges shown. */
    BOARDING_SOON: 'BOARDING_SOON',
    /** Flight has departed — triggers departed view on all surfaces. */
    DEPARTED:      'DEPARTED'
  }
};

/**
 * resolveState() — Two-State Machine (.com)
 *
 * Fetches the current gate status from GATE.SEAT_STATUS and reads the seat ID
 * from sessionStorage (or the seat_id URL parameter), then returns the
 * appropriate view for the .com landing page to render.
 *
 * Call this on DOMContentLoaded on the .com landing page.
 *
 * Resolution logic:
 * 1. If the flight has departed → 'departed'
 * 2. If a valid seat ID is present in sessionStorage or URL AND is confirmed
 *    active by /api/seat → 'dashboard'
 * 3. Otherwise → 'landing'
 *
 * Seat validation contract (GATE.VALIDATE_SEAT):
 * - valid: true  → seat confirmed; persists to sessionStorage; returns 'dashboard'.
 * - valid: false → seat invalid/inactive; clears sessionStorage; returns 'landing'.
 * - fetch error  → fail-open; persists to sessionStorage; returns 'dashboard'.
 *   Rationale: a transient upstream outage must not lock out confirmed passengers.
 * - GATE.VALIDATE_SEAT not configured → skips API call; falls back to regex-only.
 *
 * On any gate-status fetch error, defaults to 'landing' and logs the error.
 *
 * @async
 * @param {{ skipSeatValidation?: boolean }} [opts]
 *   Pass `{ skipSeatValidation: true }` to bypass the /api/seat call (e.g. for
 *   unit tests or environments where the function is not deployed).
 * @returns {Promise<ViewState>} The view to render.
 *
 * @example
 * import { resolveState } from '/gate-contract.js';
 * const view = await resolveState();
 * if (view === 'dashboard')     renderDashboard();
 * else if (view === 'departed') renderDeparted();
 * else                          renderLanding();
 */
export async function resolveState(opts = {}) {
  try {
    const res    = await fetch(GATE.SEAT_STATUS);
    const status = await res.json();

    const departed = status.nextflightstatus === GATE.FLIGHT_STATUS.DEPARTED
                  || status.gate_status      === GATE.GATE_STATUS.DEPARTED;

    if (departed) return 'departed';

    // Prefer URL param over sessionStorage so a fresh deep-link always wins.
    const rawId = new URLSearchParams(location.search).get('seat_id')
               || sessionStorage.getItem(GATE.SESSION_KEY);

    if (!rawId || !GATE.SEAT_ID_REGEX.test(rawId)) {
      return 'landing';
    }

    // Persist immediately so the session survives a hard refresh mid-flight.
    sessionStorage.setItem(GATE.SESSION_KEY, rawId);

    // ── Server-side seat validation ─────────────────────────────────────────
    // Skip if caller opts out (tests / non-Netlify environments).
    if (!opts.skipSeatValidation) {
      try {
        const SEAT_VALIDATION_TIMEOUT_MS = 4000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEAT_VALIDATION_TIMEOUT_MS);
        const seatRes = await fetch(
          `${GATE.VALIDATE_SEAT}?id=${encodeURIComponent(rawId)}`,
          { signal: controller.signal }
        );
        clearTimeout(timer);

        if (seatRes.status === 400) {
          // Malformed id (shouldn't happen after regex check, but be safe)
          console.warn('[gate-contract] resolveState: 400 from /api/seat for', rawId);
          sessionStorage.removeItem(GATE.SESSION_KEY);
          return 'landing';
        }

        if (seatRes.ok) {
          const seatData = await seatRes.json();
          if (seatData.valid === false) {
            console.warn('[gate-contract] resolveState: seat invalid —', rawId, 'reason:', seatData.reason || 'unknown');
            sessionStorage.removeItem(GATE.SESSION_KEY);
            return 'landing';
          }
          // valid: true (or _unchecked fail-open) — fall through to 'dashboard'
        }
        // Non-2xx other than 400 → fail open (fall through to 'dashboard')
      } catch (seatErr) {
        // Network error or AbortError (timeout) → fail open
        const isTimeout = seatErr.name === 'AbortError';
        console.warn(
          '[gate-contract] resolveState: seat validation',
          isTimeout ? 'timed out' : 'errored',
          '— failing open for', rawId
        );
        // Fall through to 'dashboard'
      }
    }

    return 'dashboard';
  } catch (err) {
    console.error('[gate-contract] resolveState error — defaulting to landing:', err);
    return 'landing';
  }
}

/**
 * requestSeat(payload) — Seat Request Helper
 *
 * POSTs a seat request to GATE.REQUEST_SEAT and returns the parsed JSON
 * response. On success, automatically persists the returned seat_id to
 * sessionStorage so subsequent calls to resolveState() render the dashboard.
 *
 * The caller is responsible for rendering success/error UI.
 *
 * @async
 * @param {SeatRequestPayload} payload - Passenger intake data.
 * @returns {Promise<SeatRequestResponse>} Parsed API response.
 *
 * @example
 * import { requestSeat } from '/gate-contract.js';
 * const result = await requestSeat({
 *   name: 'Jo Ann Smith', email: 'jo@example.com', age_confirmed: true
 * });
 * if (result.ok) console.log('Seat reserved:', result.seat_id);
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

/**
 * resolveSeatId() — Session Seat ID Reader
 *
 * Returns the seat_id stored in sessionStorage by a prior requestSeat() call,
 * or null if no seat is active in the current session.
 *
 * Use this to read the passenger's seat identifier without triggering a full
 * resolveState() round-trip (e.g., for deep-link construction or API calls
 * that require seat_id as a query parameter).
 *
 * @since   v1b (2026-03-29)
 * @returns {string|null} The seat_id string, or null if not present.
 *
 * @example
 * import { resolveSeatId } from '/gate-contract.js';
 * const id = resolveSeatId();
 * if (id) window.location.href = `/Tower?seat_id=${id}`;
 */
export function resolveSeatId() {
  return sessionStorage.getItem(GATE.SESSION_KEY) || null;
}

/**
 * verifyAgeToken() — Age Confirmation Token Validator
 *
 * Checks whether the passenger has confirmed they are 18+ by reading the
 * age_confirmed flag stored in sessionStorage during the intake flow.
 *
 * Returns true only if the flag is explicitly set to the string 'true'.
 * Any other value (missing, 'false', malformed) returns false.
 *
 * This is a client-side convenience check only. The authoritative age
 * confirmation is validated server-side in seat-request.js before any
 * seat is reserved.
 *
 * @since   v1b (2026-03-29)
 * @returns {boolean} True if age has been confirmed in this session.
 *
 * @example
 * import { verifyAgeToken } from '/gate-contract.js';
 * if (!verifyAgeToken()) showAgeGate();
 */
export function verifyAgeToken() {
  return sessionStorage.getItem('age_confirmed') === 'true';
}
