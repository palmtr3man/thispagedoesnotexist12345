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
 * Required env vars:
 *   SENDGRID_API_KEY    — SendGrid API key
 *   SENDGRID_FROM_EMAIL — Sender address (default: noreply@thispagedoesnotexist12345.com)
 *   BASE44_SEAT_URL     — Base44 Seat record read/update endpoint
 *   SENDGRID_DEBUG      — Set to "true" to emit structured JSON observability logs
 *
 * Spec references:
 *   - TUJ Alpha Launch Operational Spec (FL 032126) — Section 2.1
 *   - Manus Handoff — boarding_confirmation_sent_at Stamp (Mar 23, 2026)
 */

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const BCC_EMAIL = 'support@thispagedoesnotexist12345.com';
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME || 'sendgrid-integration';
const STAGE = process.env.CONTEXT || process.env.NODE_ENV || 'unknown';

// Template IDs — Phase 2 boarding sequence (Section 2.1)
const TEMPLATE_ALPHA_ANNOUNCEMENT = 'd-a33174bd2e4f4682b5b1546f106fb43c';
const TEMPLATE_BOARDING_CONFIRMATION = 'd-678824bc506c432dae9eadab36c07904';

// Template key map for readable log labels
const TEMPLATE_KEYS = {
  [TEMPLATE_ALPHA_ANNOUNCEMENT]:   'alphaflightannouncement_v1',
  [TEMPLATE_BOARDING_CONFIRMATION]: 'boarding_confirmation_v1'
};

/**
 * Emit a structured observability log line (gated by SENDGRID_DEBUG=true).
 * Never logs request body, personalizations, or API key.
 */
function sgLog(fields) {
  if (process.env.SENDGRID_DEBUG !== 'true') return;
  console.log(JSON.stringify({ event: 'tuj_sendgrid_send', function: FUNCTION_NAME, stage: STAGE, ...fields }));
}

/**
 * Build a correlation_id from available identifiers.
 * Omits any segment that is null/undefined rather than inventing data.
 */
function buildCorrelationId({ flightId, passengerId, requestId } = {}) {
  const parts = [];
  if (flightId)    parts.push(`fl_${flightId}`);
  if (passengerId) parts.push(`psg_${passengerId}`);
  if (requestId)   parts.push(`req_${requestId}`);
  return parts.length ? parts.join('__') : undefined;
}

/**
 * Send a single SendGrid dynamic template email.
 * Returns true on 2xx, false otherwise.
 * Emits a structured log line after each attempt.
 */
async function sendTemplate(apiKey, fromEmail, toEmail, templateId, dynamicData, logCtx = {}) {
  const templateKey = TEMPLATE_KEYS[templateId] || templateId;
  const payload = {
    from: { email: fromEmail },
    personalizations: [{
      to:  [{ email: toEmail }],
      bcc: [{ email: BCC_EMAIL }],
      dynamic_template_data: dynamicData
    }],
    template_id: templateId
  };

  const t0 = Date.now();
  let sgStatus;
  try {
    const response = await fetch(SENDGRID_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    sgStatus = response.status;
    const ok = response.ok || response.status === 202;
    const elapsed_ms = Date.now() - t0;

    sgLog({
      ...logCtx,
      template_key:         templateKey,
      sendgrid_template_id: templateId,
      status:               sgStatus,
      elapsed_ms,
      ok,
      attempt:              1
    });

    if (ok) {
      console.log(`[sendgrid-integration] Template ${templateKey} sent to ${toEmail} — status ${sgStatus}`);
      return true;
    }

    const errorText = await response.text();
    console.error(`[sendgrid-integration] Template ${templateKey} failed for ${toEmail} — status ${sgStatus}:`, errorText);
    return false;

  } catch (err) {
    const elapsed_ms = Date.now() - t0;
    sgLog({
      ...logCtx,
      template_key:         templateKey,
      sendgrid_template_id: templateId,
      ok:                   false,
      elapsed_ms,
      error_name:           err?.name,
      error_message:        err?.message,
      status:               err?.code || err?.response?.statusCode
    });
    console.error(`[sendgrid-integration] Template ${templateKey} unexpected error for ${toEmail}:`, err);
    return false;
  }
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
 * @param {string} seat.id                          - Seat record ID
 * @param {string} seat.user_email                  - Passenger email
 * @param {string} seat.first_name                  - Passenger first name
 * @param {string} seat.last_name                   - Passenger last name
 * @param {string} [seat.flight_id]                 - Flight ID (for correlation)
 * @param {string} [seat.passenger_id]              - Passenger ID (for correlation)
 * @param {string} [seat.request_id]                - Request ID (for correlation)
 * @param {string|null} seat.boarding_confirmation_sent_at - Idempotency check
 */
async function sendSeatConfirmation(seat) {
  const apiKey    = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const base44SeatUrl = process.env.BASE44_SEAT_URL;

  if (!apiKey) {
    console.error('[sendgrid-integration] SENDGRID_API_KEY is not set — aborting');
    return { success: false, error: 'SENDGRID_API_KEY not configured' };
  }

  const {
    id: seatId,
    user_email,
    first_name,
    last_name,
    flight_id,
    passenger_id,
    request_id,
    boarding_confirmation_sent_at
  } = seat;

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

  const correlation_id = buildCorrelationId({ flightId: flight_id, passengerId: passenger_id, requestId: request_id });
  const logCtx = {
    correlation_id,
    flight_id:    flight_id    || undefined,
    passenger_id: passenger_id || undefined,
    request_id:   request_id   || undefined
  };

  const dynamicData = { first_name, last_name, user_email };

  // ── Send 1: alphaflightannouncement_v1 ─────────────────────────────────────
  const announcementSent = await sendTemplate(apiKey, fromEmail, user_email, TEMPLATE_ALPHA_ANNOUNCEMENT, dynamicData, logCtx);

  if (!announcementSent) {
    console.error(`[sendgrid-integration] alphaflightannouncement_v1 failed for seat ${seatId} — aborting sequence`);
    return { success: false, error: 'alphaflightannouncement_v1 send failed' };
  }

  // ── Send 2: boarding_confirmation_v1 ───────────────────────────────────────
  const confirmationSent = await sendTemplate(apiKey, fromEmail, user_email, TEMPLATE_BOARDING_CONFIRMATION, dynamicData, logCtx);

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
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json'
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
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: result.error }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: result.skipped || false }) };
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports.sendSeatConfirmation = sendSeatConfirmation;
  module.exports.sendTemplate         = sendTemplate;
  module.exports.updateSeatRecord     = updateSeatRecord;
  module.exports.buildCorrelationId   = buildCorrelationId;
}
