/**
 * /api/waitlist-manifest — Netlify Function (BLOCKER-03: Admin Tower Approve/Deny Flow)
 *
 * Returns all waitlist_submissions rows and the current cohort state for the
 * Admin Tower WaitlistTab component. Secured by x-admin-secret header.
 *
 * Query params:
 *   status  — optional filter: 'pending' | 'boarded' | 'denied' | 'waitlisted'
 *             If omitted, returns all rows (most recent 100).
 *   flight_id — optional cohort filter (default: FL032126)
 *
 * Response:
 *   {
 *     submissions: [{ id, email, first_name, seat_id, source, status,
 *                     age_verified, created_at, updated_at,
 *                     approved_at, boarded_at, denied_at }],
 *     cohort: { flight_id, flight_label, status, open_count, max_seats }
 *   }
 *
 * Required env vars:
 *   ADMIN_SECRET                  — Shared secret (header: x-admin-secret)
 *   SUPABASE_URL                  — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY     — Supabase service role key
 *
 * BLOCKER-03 (2026-04-15): Initial implementation.
 */

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  process.env.ADMIN_ORIGIN || 'https://thispagedoesnotexist12345.net',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  // --- Auth ---
  const adminSecret    = process.env.ADMIN_SECRET;
  const providedSecret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || '';
  if (!adminSecret || !safeCompare(providedSecret, adminSecret)) {
    console.warn('[waitlist-manifest] Unauthorized attempt');
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Server configuration error' }) };
  }

  const sbHeaders = {
    apikey:         supabaseKey,
    Authorization:  `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  const qs         = event.queryStringParameters || {};
  const statusFilter = qs.status;
  const flightId   = qs.flight_id || 'FL032126';

  // --- Fetch waitlist_submissions ---
  let submissions = [];
  try {
    let url = `${supabaseUrl}/rest/v1/waitlist_submissions?order=created_at.desc&limit=100`;
    if (statusFilter) {
      url += `&status=eq.${encodeURIComponent(statusFilter)}`;
    }
    const res  = await fetch(url, { headers: sbHeaders });
    submissions = await res.json();
    if (!Array.isArray(submissions)) {
      console.error('[waitlist-manifest] Unexpected Supabase response:', submissions);
      submissions = [];
    }
  } catch (err) {
    console.error('[waitlist-manifest] Supabase submissions fetch failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Database fetch failed' }) };
  }

  // --- Fetch cohort state ---
  let cohort = {};
  try {
    const res  = await fetch(
      `${supabaseUrl}/rest/v1/cohorts?flight_id=eq.${encodeURIComponent(flightId)}&limit=1`,
      { headers: sbHeaders }
    );
    const rows = await res.json();
    cohort = Array.isArray(rows) && rows[0] ? rows[0] : {};
  } catch (err) {
    console.warn('[waitlist-manifest] Cohort fetch failed (non-fatal):', err.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ submissions, cohort }),
  };
};
