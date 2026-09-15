/**
 * seat-request.js — Netlify Function (Self-Contained)
 *
 * Proxies seat request submissions to the Base44 upstream service.
 * Fully self-contained with no dynamic imports from ./lib/.
 *
 * Server-side gate enforcement:
 *   - Maintenance mode (MAINTENANCE_MODE env var) is checked first and, when
 *     enabled, short-circuits every request before auth is evaluated.
 *   - A valid Supabase Bearer token is required. Missing → 401 AUTH_REQUIRED,
 *     invalid/expired → 401 INVALID_TOKEN.
 *   - The authenticated user's profile (Supabase `profiles` table, or
 *     PROFILE_TABLE override) is fetched keyed by the auth user id. The
 *     caller is verified iff profile.me_profile_status === 'verified' or
 *     profile.passport_completed_at is set. Unverified callers get a 403
 *     and the Base44 upstream is never called.
 *   - Verified requests always forward user_id as the authenticated user's
 *     id — the client-submitted request body can never set it.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function parseJson(value, label) {
  if (!value || !String(value).trim()) throw new Error(`${label} is empty`);
  try { return JSON.parse(value); } catch (_) { throw new Error(`${label} is invalid JSON`); }
}

function base44Headers() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (apiKey) {
    headers.api_key = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function isMaintenanceMode() {
  return String(process.env.MAINTENANCE_MODE || '').trim().toLowerCase() === 'true';
}

function headerValue(headers, name) {
  if (!headers) return '';
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function extractBearerToken(headers) {
  const auth = headerValue(headers, 'authorization');
  const match = String(auth || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getSupabaseUrl() {
  return process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
}

function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.APP_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
}

function getProfileTable() {
  return process.env.PROFILE_TABLE || 'profiles';
}

function pickRecord(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (Array.isArray(data?.items)) return data.items[0] || null;
  if (Array.isArray(data?.data)) return data.data[0] || null;
  return data || null;
}

/** Validates a Supabase access token against the Auth server; returns the auth user or null. */
async function fetchAuthUser(token) {
  const baseUrl = getSupabaseUrl();
  const apiKey = getSupabaseKey();
  if (!baseUrl || !apiKey) throw new Error('Supabase auth is not configured');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/v1/user`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, apikey: apiKey },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.id) return null;
  return data;
}

/** Fetches the caller's profile row from Supabase, keyed by the authenticated user id. */
async function fetchProfile(userId) {
  const baseUrl = getSupabaseUrl();
  const apiKey = getSupabaseKey();
  if (!baseUrl || !apiKey) throw new Error('Supabase configuration is missing');
  const table = getProfileTable();
  const url = `${baseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(userId)}&select=*`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Profile lookup failed: ${res.status}`);
  const data = await res.json().catch(() => null);
  return pickRecord(data);
}

function isProfileVerified(profile) {
  if (!profile) return false;
  return profile.me_profile_status === 'verified' || Boolean(profile.passport_completed_at);
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (isMaintenanceMode()) {
    return jsonResponse(503, { ok: false, error: 'Service is in maintenance mode', code: 'MAINTENANCE_MODE' });
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  const token = extractBearerToken(event.headers);
  if (!token) {
    return jsonResponse(401, { ok: false, error: 'Authorization is required', code: 'AUTH_REQUIRED' });
  }

  let authUser;
  try {
    authUser = await fetchAuthUser(token);
  } catch (err) {
    console.error('[seat-request] Auth lookup error:', err && err.message ? err.message : 'unknown');
    return jsonResponse(401, { ok: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }
  if (!authUser || !authUser.id) {
    return jsonResponse(401, { ok: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }

  let profile;
  try {
    profile = await fetchProfile(authUser.id);
  } catch (err) {
    console.error('[seat-request] Profile lookup error:', err && err.message ? err.message : 'unknown');
    return jsonResponse(502, { ok: false, error: 'Profile lookup is unavailable' });
  }

  if (!isProfileVerified(profile)) {
    return jsonResponse(403, { ok: false, error: 'Verified profile required', code: 'ME_PROFILE_NOT_VERIFIED' });
  }

  try {
    const upstreamUrl = process.env.BASE44_SEAT_REQUEST_URL;
    if (!upstreamUrl) return jsonResponse(400, { ok: false, error: 'Seat request service is not configured' });

    const clientPayload = parseJson(event.body, 'Request body');
    const payload = { ...clientPayload, user_id: authUser.id };

    let res;
    try {
      res = await fetch(upstreamUrl, {
        method: 'POST',
        headers: base44Headers(),
        body: JSON.stringify(payload),
      });
    } catch (_) {
      return jsonResponse(502, { ok: false, error: 'Seat request service is unavailable' });
    }

    let data;
    try { data = await res.json(); } catch (_) {
      return jsonResponse(502, { ok: false, error: 'Seat request service returned invalid JSON' });
    }

    return jsonResponse(res.status, { ...data, ok: res.ok });
  } catch (err) {
    if (err && (err.message === 'Request body is empty' || err.message === 'Request body is invalid JSON')) {
      return jsonResponse(400, { ok: false, error: err.message });
    }
    console.error('[seat-request] Internal error:', err && err.message ? err.message : 'unknown');
    return jsonResponse(500, { ok: false, error: 'Internal server error' });
  }
};
