/**
 * #116 — handleSeatOpened / sendSeatConfirmation
 * Netlify Function: sendgrid-integration
 *
 * Triggered when a Seat entity is activated (admin approves a SeatRequest).
 * Dispatches the two-email Phase 2 boarding sequence in order:
 *   1. alphaflightannouncement_v1  (d-a33174bd2e4f4682b5b1546f106fb43c)
 *   2. boarding_confirmation_v1    (d-678824bc506c432dae9eadab36c07904)
 *
 * After both sends confirm 2xx, stamps boarding_confirmation_sent_at on the
 * Seat record via the Base44 API. Idempotency guard: will not overwrite if
 * the field is already set (guards against retry double-stamps).
 *
 * All sends BCC support@thispagedoesnotexist12345.com per universal BCC rule.
 *
 * Spec references:
 *   - TUJ Alpha Launch Operational Spec (FL 032126) — Section 2.1
 *   - Manus Handoff — boarding_confirmation_sent_at Stamp (Mar 23, 2026)
 */

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const BCC_EMAIL = 'support@thispagedoesnotexist12345.com';

// Template IDs — Phase 2 boarding sequence (Section 2.1)
const TEMPLATE_ALPHA_ANNOUNCEMENT = 'd-a33174bd2e4f4682b5b1546f106fb43c';
const TEMPLATE_BOARDING_CONFIRMATION = 'd-678824bc506c432dae9eadab36c07904';

/**
 * Send a single SendGrid dynamic template email.
 * Returns true on 2xx, false otherwise.
 */
async function sendTemplate(apiKey, fromEmail, toEmail, templateId, dynamicData) {
  const payload = {
    from: { email: fromEmail },
    personalizations: [{
      to: [{ email: toEmail }],
      bcc: [{ email: BCC_EMAIL }],
      dynamic_template_data: dynamicData
    }],
    template_id: templateId
  };

  const response = await fetch(SENDGRID_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (response.ok || response.status === 202) {
    console.log(`[sendgrid-integration] Template ${templateId} sent to ${toEmail} — status ${response.status}`);
    return true;
  }

  const errorText = await response.text();
  console.error(`[sendgrid-integration] Template ${templateId} failed for ${toEmail} — status ${response.status}:`, errorText);
  return false;
}

/**
 * Write a field update back to a Seat record via the Base44 API.
 */
async function updateSeatRecord(base44SeatUrl, seatId, fields) {
  const url = `${base44SeatUrl}/${seatId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[sendgrid-integration] Base44 Seat update failed for seat ${seatId} — status ${response.status}:`, errorText);
    return false;
  }

  console.log(`[sendgrid-integration] Seat record ${seatId} updated:`, Object.keys(fields).join(', '));
  return true;
}

/**
 * sendSeatConfirmation — core boarding sequence dispatcher.
 *
 * Fires both Phase 2 templates in order. If both return 2xx, stamps
 * boarding_confirmation_sent_at on the Seat record. Idempotent: skips
 * the stamp if boarding_confirmation_sent_at is already set.
 *
 * @param {object} seat - Seat entity record from Base44
 * @param {string} seat.id - Seat record ID
 * @param {string} seat.user_email - Passenger email
 * @param {string} seat.first_name - Passenger first name
 * @param {string} seat.last_name - Passenger last name
 * @param {string|null} seat.boarding_confirmation_sent_at - Existing timestamp (idempotency check)
 */
async function sendSeatConfirmation(seat) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const base44SeatUrl = process.env.BASE44_SEAT_URL;

  if (!apiKey) {
    console.error('[sendgrid-integration] SENDGRID_API_KEY is not set — aborting');
    return { success: false, error: 'SENDGRID_API_KEY not configured' };
  }

  const { id: seatId, user_email, first_name, last_name, boarding_confirmation_sent_at } = seat;

  // Validate required fields
  if (!user_email || !first_name || !last_name) {
    console.error(`[sendgrid-integration] Seat ${seatId} missing required fields (user_email, first_name, last_name) — aborting`);
    return { success: false, error: 'Missing required seat fields' };
  }

  // Idempotency guard — do not re-send if already stamped
  if (boarding_confirmation_sent_at) {
    console.log(`[sendgrid-integration] Seat ${seatId} already has boarding_confirmation_sent_at (${boarding_confirmation_sent_at}) — skipping send`);
    return { success: true, skipped: true };
  }

  const dynamicData = {
    first_name,
    last_name,
    user_email
  };

  // ── Send 1: alphaflightannouncement_v1 ─────────────────────────────────────
  const announcementSent = await sendTemplate(
    apiKey,
    fromEmail,
    user_email,
    TEMPLATE_ALPHA_ANNOUNCEMENT,
    dynamicData
  );

  if (!announcementSent) {
    console.error(`[sendgrid-integration] alphaflightannouncement_v1 failed for seat ${seatId} — aborting sequence`);
    return { success: false, error: 'alphaflightannouncement_v1 send failed' };
  }

  // ── Send 2: boarding_confirmation_v1 ───────────────────────────────────────
  const confirmationSent = await sendTemplate(
    apiKey,
    fromEmail,
    user_email,
    TEMPLATE_BOARDING_CONFIRMATION,
    dynamicData
  );

  if (!confirmationSent) {
    console.error(`[sendgrid-integration] boarding_confirmation_v1 failed for seat ${seatId} — announcement already sent, stamp withheld`);
    return { success: false, error: 'boarding_confirmation_v1 send failed' };
  }

  // ── Both sends confirmed 2xx — stamp boarding_confirmation_sent_at ─────────
  if (base44SeatUrl && seatId) {
    await updateSeatRecord(base44SeatUrl, seatId, {
      boarding_confirmation_sent_at: new Date().toISOString()
    });
  } else {
    console.warn('[sendgrid-integration] BASE44_SEAT_URL not set — boarding_confirmation_sent_at stamp skipped');
  }

  return { success: true };
}

/**
 * handleSeatOpened — Netlify Function handler.
 *
 * Accepts a POST with the full Seat entity record in the request body.
 * Delegates to sendSeatConfirmation for the email sequence and stamp.
 */
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  let seat;
  try {
    seat = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  if (!seat || !seat.id) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Missing seat.id in request body' }) };
  }

  const result = await sendSeatConfirmation(seat);

  if (!result.success) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ ok: false, error: result.error })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, skipped: result.skipped || false })
  };
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports.sendSeatConfirmation = sendSeatConfirmation;
  module.exports.sendTemplate = sendTemplate;
  module.exports.updateSeatRecord = updateSeatRecord;
}
