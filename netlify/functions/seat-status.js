/**
 * seat-status.js — Netlify Function (Option 1: Proxy)
 *
 * Proxies the Base44 getCohortStatus function and returns live seat
 * availability and gate state to the landing page and Studio Boarding
 * Readiness Panel.
 *
 * Required env vars:
 *   BASE44_COHORT_STATUS_URL — the public URL of the Base44 getCohortStatus function
 *                              (Base44 Dashboard → Code → Functions → getCohortStatus)
 *
 * Optional env vars (required for resume_fit_check_status enrichment):
 *   BASE44_SEAT_URL          — Base44 Seat record read endpoint (e.g. .../Seat)
 *                              Used to look up user_id from seat_id.
 *   BASE44_USER_URL          — Base44 User record read endpoint (e.g. .../User)
 *                              Used to read passport_completed_at + highest_ats_score.
 *
 * F-HIER-01: flight_code field
 *   Sourced from three places in priority order:
 *     1. data.flight_code     — Base44 NextFlightConfig field (add to schema; see below)
 *     2. ACTIVE_FLIGHT_CODE   — Netlify env var (already in use for email tokens)
 *     3. data.flight_id       — legacy operational ID from getCohortStatus
 *   The resolved value is always normalised: spaces → underscores, trimmed.
 *   Exposed as data.flight_code in the public payload.
 *
 *   Base44 NextFlightConfig schema addition (long-term):
 *     Field name:  flight_code
 *     Type:        Text (short string)
 *     Description: Operational flight code shown as secondary metadata on the
 *                  public window (e.g. "FL032126"). Separate from flight_label
 *                  (the passenger-facing display name). Returned by getCohortStatus.
 *
 * BLOCKER-05-FU: When seat_id is provided as a query param (?seat_id=TUJ-XXXXXX),
 * this function enriches the response with resume_fit_check_status for the Studio
 * Boarding Readiness Panel. The field is derived from the User record:
 *   'complete'    → passport_completed_at is set (OnboardingPassport done)
 *   'in_progress' → highest_ats_score > 0 (ATS run but passport not yet done)
 *   'not_started' → neither condition met
 *   'unknown'     → BASE44_SEAT_URL / BASE44_USER_URL not configured, or lookup failed (fail-open)
 *
 * CORS headers are already set on the Base44 side; this proxy passes the
 * response through cleanly. Falls back to gate_status: 'closed' on any error.
 */

const SEAT_ID_REGEX = /^TUJ-[A-Z2-9]{6}$/;
const LOOKUP_TIMEOUT_MS = 4000;

/**
 * Fetch a single Base44 entity record by ID with a hard timeout.
 * Returns parsed JSON on success, null on any error (timeout, 4xx, 5xx, network).
 */
async function fetchBase44Record(baseUrl, id) {
  if (!baseUrl || !id) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/${id}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Derive resume_fit_check_status from a User record.
 *   'complete'    → passport_completed_at is set
 *   'in_progress' → highest_ats_score > 0 (ATS run, passport not yet done)
 *   'not_started' → no signal
 *   'unknown'     → user record unavailable
 */
function deriveResumeFitCheckStatus(user) {
  if (!user) return 'unknown';
  if (user.passport_completed_at) return 'complete';
  if (user.highest_ats_score && user.highest_ats_score > 0) return 'in_progress';
  return 'not_started';
}

/**
 * resolveFlightCode(data) — F-HIER-01
 *
 * Returns the canonical operational flight code for the active flight.
 * Priority:
 *   1. data.flight_code     — Base44 NextFlightConfig field (future: add to schema)
 *   2. ACTIVE_FLIGHT_CODE   — Netlify env var (already used for email tokens)
 *   3. data.flight_id       — legacy operational ID from getCohortStatus
 *   4. null                 — no code available; UI hides the secondary badge
 *
 * Normalisation: spaces replaced with underscores, trimmed.
 * This matches the existing ACTIVE_FLIGHT_CODE convention ("FL 041926" → "FL_041926")
 * but the raw value is also preserved for display — callers may choose to display
 * the raw string or the normalised form. The normalised form is what is returned.
 */
function resolveFlightCode(data) {
  const raw =
    (data.flight_code && String(data.flight_code).trim()) ||
    (process.env.ACTIVE_FLIGHT_CODE && String(process.env.ACTIVE_FLIGHT_CODE).trim()) ||
    (data.flight_id && String(data.flight_id).trim()) ||
    null;
  if (!raw) return null;
  // Normalise: replace spaces with underscores (matches ACTIVE_FLIGHT_CODE convention)
  return raw.replace(/ /g, '_');
}

exports.handler = async function handler(event) {
  // ── Preflight ──────────────────────────────────────────────────────────────
  if ((event.httpMethod || '').toUpperCase() === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  try {
    // ── 1. Proxy getCohortStatus ───────────────────────────────────────────
    const res = await fetch(process.env.BASE44_COHORT_STATUS_URL);
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();

    // ── 2. ALPHA_MODE override ─────────────────────────────────────────────
    const alphaModeEnv = String(process.env.ALPHA_MODE || '').toLowerCase();
    if (alphaModeEnv === 'false') {
      data.alpha_mode = false;
      if (typeof data.flight_label === 'string' && /alpha/i.test(data.flight_label)) {
        data.flight_label = data.flight_label.replace(/alpha/i, 'Beta');
      } else {
        data.flight_label = 'Beta Flight';
      }
    }

    // ── 3. PUBLIC_GATE_STATE operator override ─────────────────────────────
    const publicGateState = (process.env.PUBLIC_GATE_STATE || '').trim().toLowerCase();
    if (publicGateState && ['open', 'hold', 'closed', 'boarding'].includes(publicGateState)) {
      data.gate_status = publicGateState;
    }

    // ── 4. F-HIER-01: flight_code resolution ──────────────────────────────
    // Resolves the operational flight code from Base44, env var, or flight_id fallback.
    // Always overwrites data.flight_code so the public payload has a single canonical field.
    // Returns null if no code is available — UI hides the secondary badge in that case.
    data.flight_code = resolveFlightCode(data);

    // ── 5. BLOCKER-05-FU: resume_fit_check_status enrichment ──────────────
    // Attempted only when seat_id is present and Base44 endpoints are configured.
    // Fails open to 'unknown' on any error — never blocks the primary response.
    const qp = event.queryStringParameters || {};
    let rawSeatId = (qp.seat_id || qp.id || '').replace(/ /g, '_').trim();

    let resume_fit_check_status = 'unknown';

    if (rawSeatId && SEAT_ID_REGEX.test(rawSeatId)) {
      const base44SeatUrl = process.env.BASE44_SEAT_URL;
      const base44UserUrl = process.env.BASE44_USER_URL;

      if (base44SeatUrl && base44UserUrl) {
        // Step A: fetch Seat record to get user_id
        const seat = await fetchBase44Record(base44SeatUrl, rawSeatId);
        if (seat && seat.user_id) {
          // Step B: fetch User record to read passport_completed_at + highest_ats_score
          const user = await fetchBase44Record(base44UserUrl, seat.user_id);
          resume_fit_check_status = deriveResumeFitCheckStatus(user);
        } else if (seat) {
          // Seat found but user_id not present — treat as not_started
          resume_fit_check_status = 'not_started';
        }
        // Seat lookup failed entirely → stays 'unknown' (fail-open)
      }
      // Env vars not configured → stays 'unknown' (fail-open, graceful stub)
    }

    data.resume_fit_check_status = resume_fit_check_status;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gate_status: 'closed', error: err.message }),
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.handler = exports.handler;
}
