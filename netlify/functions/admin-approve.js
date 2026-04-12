/**
 * /api/admin-approve — Netlify Function (BLOCKER-03: Admin Tower Approve/Deny Flow)
 *
 * Approves a pending seat request:
 *   1. Validates ADMIN_SECRET header (constant-time compare)
 *   2. Looks up the seat request in Supabase waitlist_submissions by seat_request_id
 *   3. Checks request is still in 'pending' status (idempotency guard)
 *   4. Updates Supabase status: pending → approved
 *   5. Generates a TUJ-XXXXXX seat_id (if not already assigned)
 *   6. Fires the dual boarding email sequence via sendSeatConfirmation()
 *      (boarding_pass_free/paid_v1 + boarding_instructions_free/paid_v1)
 *   7. Updates Supabase status: approved → boarded
 *   8. Returns { ok: true, seat_id, email }
 *
 * Required env vars:
 *   ADMIN_SECRET                  — Shared secret for admin authentication (header: x-admin-secret)
 *   SUPABASE_URL                  — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY     — Supabase service role key
 *   SENDGRID_API_KEY              — SendGrid API key
 *   SENDGRID_FROM_EMAIL           — Sender address
 *   SITE_URL                      — Base URL for CTA deep-links
 *
 * Request body (JSON):
 *   { seat_request_id: string, cabin_class?: 'Economy' | 'First' | 'Sponsored', flight_id?: string }
 *
 * Success response:
 *   { ok: true, seat_id: 'TUJ-XXXXXX', email: string, status: 'boarded' }
 *
 * Error responses:
 *   401 — Missing or invalid ADMIN_SECRET
 *   400 — Missing seat_request_id
 *   404 — Seat request not found
 *   409 — Already approved/boarded (idempotency)
 *   502 — Boarding email sequence failed
 *
 * BLOCKER-03 (2026-04-12): Initial implementation.
 * Path B: Admin Tower → handleSeatOpened → Boarding Pass + Instructions emails.
 *
 * BLOCKER-09 (2026-04-12): Added SeatRequest write + cohort open_count increment.
 * - Creates a seat_requests record after approval (linked to waitlist_submissions)
 * - Atomically increments cohorts.open_count via increment_cohort_open_count() RPC
 * - Stamps boarding_emails_sent + boarding_sent_at on seat_requests after email sequence
 */

const { sendSeatConfirmation } = require('./sendgrid-integration');

const SEAT_ID_PREFIX = 'TUJ-';
const SEAT_ID_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const SEAT_ID_LENGTH = 6;

function generateSeatId() {
  let result = SEAT_ID_PREFIX;
  const array = new Uint8Array(SEAT_ID_LENGTH);
  crypto.getRandomValues(array);
  for (let i = 0; i < SEAT_ID_LENGTH; i++) {
    result += SEAT_ID_CHARS[array[i] % SEAT_ID_CHARS.length];
  }
  return result;
}

/**
 * Constant-time string comparison to prevent timing attacks on the admin secret.
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type':                 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  // --- Auth: validate ADMIN_SECRET header ---
  const adminSecret = process.env.ADMIN_SECRET;
  const providedSecret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || '';
  if (!adminSecret || !safeCompare(providedSecret, adminSecret)) {
    console.warn('[admin-approve] Unauthorized attempt — invalid or missing x-admin-secret');
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  }

  // --- Parse body ---
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { seat_request_id, cabin_class = 'Economy', flight_id = 'FL032126' } = body;
  if (!seat_request_id || typeof seat_request_id !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'seat_request_id is required' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('[admin-approve] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Server configuration error' }) };
  }

  const sbHeaders = {
    apikey:         supabaseKey,
    Authorization:  `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    Prefer:         'return=representation'
  };

  // --- Fetch seat request from Supabase ---
  let seatRequest;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/waitlist_submissions?id=eq.${encodeURIComponent(seat_request_id)}&limit=1`,
      { headers: sbHeaders }
    );
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Seat request not found' }) };
    }
    seatRequest = rows[0];
  } catch (err) {
    console.error('[admin-approve] Supabase lookup failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Database lookup failed' }) };
  }

  // --- Idempotency guard ---
  if (seatRequest.status === 'boarded') {
    console.log(`[admin-approve] Already boarded: ${seatRequest.email} seat_id ${seatRequest.seat_id}`);
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        ok: false,
        duplicate: true,
        error: 'This seat request has already been approved and boarded.',
        seat_id: seatRequest.seat_id,
        email:   seatRequest.email
      })
    };
  }
  if (seatRequest.status !== 'pending') {
    console.log(`[admin-approve] Non-pending status '${seatRequest.status}' for ${seatRequest.email}`);
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        ok: false,
        error: `Cannot approve — current status is '${seatRequest.status}'.`,
        status: seatRequest.status
      })
    };
  }

  // --- Determine seat_id (use existing or generate new) ---
  const seatId = seatRequest.seat_id || generateSeatId();
  const email  = seatRequest.email;
  const firstName = seatRequest.first_name || email.split('@')[0];

  // --- Update Supabase: pending → approved ---
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/waitlist_submissions?id=eq.${encodeURIComponent(seat_request_id)}`,
      {
        method:  'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body:    JSON.stringify({ status: 'approved', seat_id: seatId, approved_at: new Date().toISOString() })
      }
    );
    console.log(`[admin-approve] Supabase status → approved for ${email} seat_id ${seatId}`);
  } catch (err) {
    console.error('[admin-approve] Supabase approve update failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Failed to update seat request status' }) };
  }

  // --- BLOCKER-09: Create seat_requests record (SeatRequest entity) ---
  let seatRequestRowId = null;
  try {
    const srRes = await fetch(
      `${supabaseUrl}/rest/v1/seat_requests`,
      {
        method:  'POST',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body:    JSON.stringify({
          waitlist_submission_id: seat_request_id,
          seat_id:                seatId,
          email,
          first_name:             firstName,
          last_name:              seatRequest.last_name || null,
          cabin_class:            cabin_class,
          flight_id:              flight_id,
          status:                 'opened',
          requested_at:           seatRequest.created_at || new Date().toISOString(),
          approved_at:            new Date().toISOString()
        })
      }
    );
    const srRows = await srRes.json();
    seatRequestRowId = Array.isArray(srRows) && srRows[0]?.id ? srRows[0].id : null;
    console.log(`[admin-approve] seat_requests row created: ${seatRequestRowId} for ${email}`);
  } catch (err) {
    // Non-fatal — log for reconciliation, do not block boarding
    console.error('[admin-approve] seat_requests insert failed (non-fatal):', err.message);
  }

  // --- BLOCKER-09: Increment cohort open_count (atomic, capped at max_seats) ---
  try {
    const cohortRes = await fetch(
      `${supabaseUrl}/rest/v1/rpc/increment_cohort_open_count`,
      {
        method:  'POST',
        headers: { ...sbHeaders, Prefer: 'return=representation' },
        body:    JSON.stringify({ p_flight_id: flight_id })
      }
    );
    const newCount = await cohortRes.json();
    if (newCount === -1) {
      console.warn(`[admin-approve] Cohort '${flight_id}' not found or not active — open_count not incremented`);
    } else {
      console.log(`[admin-approve] Cohort '${flight_id}' open_count → ${newCount}`);
    }
  } catch (err) {
    // Non-fatal — log for reconciliation, do not block boarding
    console.error('[admin-approve] Cohort open_count increment failed (non-fatal):', err.message);
  }

  // --- Fire boarding email sequence via sendSeatConfirmation ---
  // Construct a seat-like object matching sendgrid-integration.js expectations
  const seatRecord = {
    id:                 seat_request_id,
    tuj_code:           seatId,
    first_name:         firstName,
    last_name:          seatRequest.last_name || '',
    user_email:         email,
    cabin_class:        cabin_class,
    flight_id:          flight_id,
    flight_display_name: `TUJ ${flight_id}`,
    boarding_type:      'standard'
  };

  let boardingResult;
  try {
    boardingResult = await sendSeatConfirmation(seatRecord);
  } catch (err) {
    console.error('[admin-approve] sendSeatConfirmation threw:', err.message);
    boardingResult = { success: false, error: err.message };
  }

  if (!boardingResult.success) {
    // Roll back to approved (not boarded) — emails did not send
    console.error(`[admin-approve] Boarding email sequence failed for ${email}: ${boardingResult.error}`);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        ok:     false,
        error:  `Boarding email sequence failed: ${boardingResult.error}`,
        status: 'approved' // status in Supabase — not yet boarded
      })
    };
  }

  // --- Update Supabase: approved → boarded (waitlist_submissions) ---
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/waitlist_submissions?id=eq.${encodeURIComponent(seat_request_id)}`,
      {
        method:  'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body:    JSON.stringify({ status: 'boarded', boarded_at: new Date().toISOString() })
      }
    );
    console.log(`[admin-approve] Supabase status → boarded for ${email} seat_id ${seatId}`);
  } catch (err) {
    // Non-fatal — emails already sent, log for reconciliation
    console.error('[admin-approve] Supabase boarded stamp failed (non-fatal):', err.message);
  }

  // --- BLOCKER-09: Stamp seat_requests: boarding_emails_sent + boarding_sent_at ---
  if (seatRequestRowId) {
    try {
      await fetch(
        `${supabaseUrl}/rest/v1/seat_requests?id=eq.${encodeURIComponent(seatRequestRowId)}`,
        {
          method:  'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body:    JSON.stringify({
            status:               'boarded',
            boarding_emails_sent: true,
            boarding_sent_at:     new Date().toISOString()
          })
        }
      );
      console.log(`[admin-approve] seat_requests stamped: boarding_emails_sent=true for ${email}`);
    } catch (err) {
      console.error('[admin-approve] seat_requests boarding stamp failed (non-fatal):', err.message);
    }
  }

  console.log(`[admin-approve] ✅ Approved and boarded: ${email} seat_id ${seatId}`);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok:      true,
      seat_id: seatId,
      email,
      status:  'boarded'
    })
  };
};
