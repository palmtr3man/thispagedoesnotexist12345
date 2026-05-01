/**
 * /api/admin-deny — Netlify Function (BLOCKER-03: Admin Tower Approve/Deny Flow)
 *
 * Denies a pending seat request:
 *   1. Validates ADMIN_SECRET header (constant-time compare)
 *   2. Looks up the seat request in Supabase waitlist_submissions by seat_request_id
 *   3. Checks request is still in 'pending' or 'approved' status (idempotency guard)
 *   4. Updates Supabase status: pending → denied
 *   5. Fires next_flight_waitlist_v1 email via SendGrid (graceful — non-blocking)
 *   6. Returns { ok: true, email, status: 'denied' }
 *
 * Required env vars:
 *   ADMIN_SECRET                  — Shared secret for admin authentication (header: x-admin-secret)
 *   SUPABASE_URL                  — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY     — Supabase service role key
 *   SENDGRID_API_KEY              — SendGrid API key
 *   SENDGRID_FROM_EMAIL           — Sender address
 *
 * Request body (JSON):
 *   { seat_request_id: string, reason?: string }
 *
 * Success response:
 *   { ok: true, email: string, status: 'denied', email_sent: boolean }
 *
 * Error responses:
 *   401 — Missing or invalid ADMIN_SECRET
 *   400 — Missing seat_request_id
 *   404 — Seat request not found
 *   409 — Already denied or boarded (idempotency)
 *
 * BLOCKER-03 (2026-04-12): Initial implementation.
 * Path B denial fork: Admin Tower → denied status → next_flight_waitlist_v1 email.
 *
 * F143 (2026-05-01): Three additions for BLOCKER-143 compliance:
 *   - Terminal state guard: skips waitlist email for passengers in Accepted / Paused / Withdrew / Not Seeking states.
 *   - Beehiiv 'waitlist' tag: applied after email send via subscribeToBeehiiv + applyBeehiivWaitlistTag.
 *   - Idempotency marker: writes waitlist_email_sent_at to Supabase after successful send.
 *
 * Additional required env vars (F143):
 *   BEEHIIV_API_KEY               — beehiiv API key for waitlist tag application
 *   BEEHIIV_PUB_ID                — beehiiv publication ID (default: pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf)
 */

const { TEMPLATES, assertTemplates } = require('./sendgrid-templates');

assertTemplates(['next_flight_waitlist_v1']);
const TEMPLATE_NEXT_FLIGHT_WAITLIST = TEMPLATES.next_flight_waitlist_v1;
const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const BCC_EMAIL        = 'support@thispagedoesnotexist12345.com';

// F143 — Terminal journey states: do not send waitlist email to passengers in these states.
// Aligns with Phase 5 cohort-landing gate logic.
const TERMINAL_JOURNEY_STATES = ['accepted', 'paused', 'withdrew', 'not_seeking'];

// beehiiv defaults (mirrors seat-request.js)
const BEEHIIV_PUB_ID_DEFAULT = 'pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf';

/**
 * Subscribe or re-activate an email in beehiiv and return the subscription ID.
 * Used to apply the 'waitlist' tag after denial (F143 §4).
 */
async function subscribeToBeehiiv(email, firstName, apiKey, pubId) {
  const url = `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        reactivate_existing: false,
        send_welcome_email: false,
        utm_source: 'admin-deny',
        utm_medium: 'netlify-function',
        utm_campaign: 'f143-denial',
        custom_fields: [{ name: 'first_name', value: firstName }]
      })
    });
    if (res.ok || res.status === 201 || res.status === 200) {
      const data = await res.json().catch(() => ({}));
      return data?.data?.id || null;
    }
    const errText = await res.text();
    console.error(`[admin-deny] beehiiv subscribe error ${res.status}:`, errText);
    return null;
  } catch (err) {
    console.error('[admin-deny] beehiiv subscribe unexpected error:', err.message);
    return null;
  }
}

/**
 * Apply the 'waitlist' tag to a beehiiv subscriber (F143 §4).
 */
async function applyBeehiivWaitlistTag(subId, apiKey, pubId) {
  if (!subId) return;
  const url = `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions/${subId}/tags`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['waitlist'] })
    });
    if (res.ok || res.status === 200 || res.status === 201) {
      console.log(`[admin-deny] beehiiv 'waitlist' tag applied to ${subId}`);
    } else {
      const errText = await res.text();
      console.error(`[admin-deny] beehiiv tag apply error ${res.status}:`, errText);
    }
  } catch (err) {
    console.error('[admin-deny] beehiiv tag apply unexpected error:', err.message);
  }
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

async function sendDenialEmail({ email, firstName, apiKey, fromEmail }) {
  const dynamicData = {
    first_name:   firstName || email.split('@')[0],
    platform_url: 'https://www.thispagedoesnotexist12345.com',
    signal_url:   process.env.SIGNAL_URL || 'https://newsletter.thispagedoesnotexist12345.us'
  };

  try {
    const res = await fetch(SENDGRID_API_URL, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from:             { email: fromEmail },
        personalizations: [{
          to:  [{ email }],
          bcc: [{ email: BCC_EMAIL }],
          dynamic_template_data: dynamicData
        }],
        template_id: TEMPLATE_NEXT_FLIGHT_WAITLIST
      })
    });

    if (res.ok || res.status === 202) {
      console.log(`[admin-deny] next_flight_waitlist_v1 sent to ${email}`);
      return true;
    } else {
      const errText = await res.text();
      console.error(`[admin-deny] SendGrid denial email error ${res.status}: ${errText}`);
      return false;
    }
  } catch (err) {
    console.error('[admin-deny] SendGrid denial email unexpected error:', err.message);
    return false;
  }
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
    console.warn('[admin-deny] Unauthorized attempt — invalid or missing x-admin-secret');
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  }

  // --- Parse body ---
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { seat_request_id, reason } = body;
  if (!seat_request_id || typeof seat_request_id !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'seat_request_id is required' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('[admin-deny] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
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
    console.error('[admin-deny] Supabase lookup failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Database lookup failed' }) };
  }

  // --- F143: Terminal state guard — do not fire waitlist email for terminal journey states ---
  const journeyStatus = (seatRequest.journey_status || '').toLowerCase();
  if (TERMINAL_JOURNEY_STATES.includes(journeyStatus)) {
    console.log(`[admin-deny] Skipping waitlist email for ${seatRequest.email} — terminal journey state: ${journeyStatus}`);
    // Still update status to denied, but skip the email.
    try {
      await fetch(
        `${supabaseUrl}/rest/v1/waitlist_submissions?id=eq.${encodeURIComponent(seat_request_id)}`,
        {
          method:  'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body:    JSON.stringify({
            status:    'denied',
            denied_at: new Date().toISOString(),
            ...(reason ? { denial_reason: reason } : {})
          })
        }
      );
    } catch (err) {
      console.error('[admin-deny] Supabase terminal-state deny update failed:', err.message);
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, email: seatRequest.email, status: 'denied', email_sent: false, skipped_reason: 'terminal_journey_state' })
    };
  }

  // --- Idempotency guard ---
  if (seatRequest.status === 'denied') {
    console.log(`[admin-deny] Already denied: ${seatRequest.email}`);
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        ok:     false,
        duplicate: true,
        error:  'This seat request has already been denied.',
        email:  seatRequest.email
      })
    };
  }
  if (seatRequest.status === 'boarded') {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        ok:    false,
        error: 'Cannot deny — passenger has already been boarded.',
        email: seatRequest.email
      })
    };
  }

  const email     = seatRequest.email;
  const firstName = seatRequest.first_name || email.split('@')[0];

  // --- Update Supabase: pending → denied ---
  try {
    await fetch(
      `${supabaseUrl}/rest/v1/waitlist_submissions?id=eq.${encodeURIComponent(seat_request_id)}`,
      {
        method:  'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body:    JSON.stringify({
          status:    'denied',
          denied_at: new Date().toISOString(),
          ...(reason ? { denial_reason: reason } : {})
        })
      }
    );
    console.log(`[admin-deny] Supabase status → denied for ${email}`);
  } catch (err) {
    console.error('[admin-deny] Supabase deny update failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Failed to update seat request status' }) };
  }

   // --- Fire next_flight_waitlist_v1 email (graceful — non-blocking) ---
  const apiKey   = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  let emailSent = false;
  if (apiKey) {
    emailSent = await sendDenialEmail({ email, firstName, apiKey, fromEmail });
  } else {
    console.warn('[admin-deny] SENDGRID_API_KEY not set — skipping denial email');
  }

  // --- F143 §4 — Apply Beehiiv 'waitlist' tag on manual denial path ---
  const beehiivKey = process.env.BEEHIIV_API_KEY;
  const beehiivPub = process.env.BEEHIIV_PUB_ID || BEEHIIV_PUB_ID_DEFAULT;
  if (beehiivKey && emailSent) {
    const denialSubId = await subscribeToBeehiiv(email, firstName, beehiivKey, beehiivPub);
    await applyBeehiivWaitlistTag(denialSubId, beehiivKey, beehiivPub);
  }

  // --- F143 §5 — Idempotency marker: write waitlist_email_sent_at to Supabase ---
  if (emailSent) {
    try {
      await fetch(
        `${supabaseUrl}/rest/v1/waitlist_submissions?id=eq.${encodeURIComponent(seat_request_id)}`,
        {
          method:  'PATCH',
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
          body:    JSON.stringify({ waitlist_email_sent_at: new Date().toISOString() })
        }
      );
      console.log(`[admin-deny] F143 idempotency marker written for ${email}`);
    } catch (markerErr) {
      console.error('[admin-deny] F143 idempotency marker write failed (non-blocking):', markerErr.message);
    }
  }

  console.log(`[admin-deny] ✅ Denied: ${email} email_sent=${emailSent}`);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok:         true,
      email,
      status:     'denied',
      email_sent: emailSent
    })
  };
};
