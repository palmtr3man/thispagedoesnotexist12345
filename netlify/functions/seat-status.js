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
 *   Sourced from two places in priority order:
 *     1. data.flight_code     — Base44 NextFlightConfig field (upstream API)
 *     2. data.flight_id       — legacy operational ID from getCohortStatus
 *   The resolved value is always normalised: spaces → underscores, trimmed.
 *   Exposed as data.flight_code in the public payload.
 */

// REGEX-MIGRATE-01: Support dual-prefix seat IDs (Legacy TUJ- and Flight-bound FL-)
const SEAT_ID_REGEX = /^(TUJ-[A-Z2-9]{6}|FL-[A-Z0-9-]{3,10})$/;
const LOOKUP_TIMEOUT_MS = 4000;
const BASE44_APP_ID = '697140e628131a06045ebd18';

/**
 * Fetch a single Base44 entity record by ID with a hard timeout.
 * Returns parsed JSON on success, null on any error (timeout, 4xx, 5xx, network).
 */
function base44Headers() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (apiKey) headers.api_key = apiKey;
  return headers;
}

function normalizeBase44EntityUrl(rawUrl, entityName) {
  const value = String(rawUrl || '').trim().replace(/\/$/, '');
  if (!value) return value;
  if (value.includes('api.base44.com/api/apps/')) return value;
  if (value.includes('.base44.app/api/') || value.includes('app.base44.com/api/')) {
    console.warn(`[seat-status] Normalizing app-domain Base44 ${entityName} URL to canonical entity API`);
    return `https://api.base44.com/api/apps/${BASE44_APP_ID}/entities/${entityName}`;
  }
  return value;
}

function pickEntityRecord(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (Array.isArray(data?.items)) return data.items[0] || null;
  if (Array.isArray(data?.data)) return data.data[0] || null;
  if (Array.isArray(data?.results)) return data.results[0] || null;
  return data || null;
}

async function fetchBase44Record(baseUrl, id, lookupField = 'id') {
  if (!baseUrl || !id) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const url = lookupField === 'id'
      ? `${baseUrl}/${encodeURIComponent(id)}`
      : `${baseUrl}?${encodeURIComponent(lookupField)}=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: base44Headers(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return pickEntityRecord(await res.json());
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Derive resume_fit_check_status from a User record.
 */
function deriveResumeFitCheckStatus(user) {
  if (!user) return 'unknown';
  if (user.passport_completed_at) return 'complete';
  if (user.highest_ats_score && user.highest_ats_score > 0) return 'in_progress';
  return 'not_started';
}

/**
 * resolveFlightCode(data) — F-HIER-01
 */
function resolveFlightCode(data) {
  const raw =
    (data.flight_code && String(data.flight_code).trim()) ||
    (data.flight_id && String(data.flight_id).trim()) ||
    null;
  if (!raw) return null;
  return raw.replace(/ /g, '_');
}

function resolveProgramMode(rawMode) {
  const normalized = String(rawMode || '').trim();
  return normalized
    ? normalized.toUpperCase().replace(/[\s-]+/g, '_')
    : 'AWAITING_CLEARANCE';
}

function getProgramModeMeta(programMode) {
  return {
    label: programMode.replace(/_/g, ' '),
    variant: programMode === 'AWAITING_CLEARANCE' ? 'neutral' : 'active',
  };
}

function ensureStableModeFields(data) {
  const programMode = resolveProgramMode(data.program_mode || data.programMode);
  const modeMeta = getProgramModeMeta(programMode);

  data.program_mode = data.program_mode || programMode;
  data.mode = data.mode || modeMeta.label;
  data.mode_variant = data.mode_variant || modeMeta.variant;
}

exports.handler = async function handler(event) {
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
    const res = await fetch(process.env.BASE44_COHORT_STATUS_URL);
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();

    const alphaModeEnv = String(process.env.ALPHA_MODE || '').toLowerCase();
    if (alphaModeEnv === 'false') {
      data.alpha_mode = false;
    }

    const publicGateState = (process.env.PUBLIC_GATE_STATE || '').trim().toLowerCase();
    if (publicGateState && ['open', 'hold', 'closed', 'boarding'].includes(publicGateState)) {
      data.gate_status = publicGateState;
    }

    data.flight_code = resolveFlightCode(data);
    ensureStableModeFields(data);

    const qp = event.queryStringParameters || {};
    let rawSeatId = (qp.seat_id || qp.id || '').replace(/ /g, '_').trim();

    let resume_fit_check_status = 'unknown';
    let seat_status = 'unknown';

    if (rawSeatId && SEAT_ID_REGEX.test(rawSeatId)) {
      const base44SeatUrl = normalizeBase44EntityUrl(process.env.BASE44_SEAT_URL, 'Seat');
      const base44UserUrl = normalizeBase44EntityUrl(process.env.BASE44_USER_URL, 'User');

      if (base44SeatUrl && base44UserUrl) {
        const seat = await fetchBase44Record(base44SeatUrl, rawSeatId, 'tuj_code');
        if (seat) {
          const normalizedSeatStatus = (seat.status && String(seat.status).toLowerCase()) || 'unknown';
          seat_status = ['opened', 'approved', 'pending'].includes(normalizedSeatStatus)
            ? normalizedSeatStatus
            : 'unknown';

          const seatEmail = String(seat.user_email || seat.email || seat.passenger_email || '').trim().toLowerCase();
          if (seatEmail) data.passenger_email = seatEmail;

          if (seat.user_id) {
            const user = await fetchBase44Record(base44UserUrl, seat.user_id);
            resume_fit_check_status = deriveResumeFitCheckStatus(user);
          } else {
            resume_fit_check_status = 'not_started';
          }
        }
      }
    }

    data.resume_fit_check_status = resume_fit_check_status;
    data.seat_status = seat_status;

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
