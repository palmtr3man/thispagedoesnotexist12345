/**
 * #116 — handleSeatOpened / sendSeatConfirmation
 * Netlify Function: sendgrid-integration
 *
 * Triggered when a Seat entity is activated (admin approves a SeatRequest).
 * Dispatches the correct email sequence based on boarding_type:
 *
 *   boarding_type = "executive_pre"
 *     → exec_preboard_opentowork_v1  (single send)
 *     Requires non-empty pid and tuj_code; aborts with error if either is missing.
 *     On success, stamps exec_preboard_sent_at on the Seat record.
 *     Idempotency guard: skips send if exec_preboard_sent_at is already set.
 *
 *   boarding_type = anything else (default Phase 2 sequence)
 *     1. alphaflightannouncement_v1
 *     2. boarding_confirmation_v1
 *     After both confirm 2xx, stamps boarding_confirmation_sent_at on the Seat record.
 *
 * Idempotency guards: will not overwrite boarding_confirmation_sent_at (default path)
 * or exec_preboard_sent_at (executive_pre path) if already set.
 * All sends BCC support@thispagedoesnotexist12345.com per universal BCC rule.
 *
 * Required env vars:
 *   SENDGRID_API_KEY              — SendGrid API key
 *   SENDGRID_FROM_EMAIL           — Sender address (default: noreply@thispagedoesnotexist12345.com)
 *   BASE44_SEAT_URL               — Base44 Seat record read/update endpoint
 *   SENDGRID_DEBUG                — Set to "true" to emit structured JSON observability logs
 *
 * Spec references:
 *   - TUJ Alpha Launch Operational Spec (FL 032126) — Section 2.1
 *   - Manus Handoff — boarding_confirmation_sent_at Stamp (Mar 23, 2026)
 *   - exec_preboard_opentowork_v1 wiring fix (Apr 1, 2026)
 */

const { TEMPLATES, assertTemplates, templateKeyForId } = require('./sendgrid-templates');

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const BCC_EMAIL = 'support@thispagedoesnotexist12345.com';
const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME || 'sendgrid-integration';
const STAGE = process.env.CONTEXT || process.env.NODE_ENV || 'unknown';

// Template IDs — sourced from sendgrid-templates.js (do not hardcode d-... here)
assertTemplates(['alphaflightannouncement_v1', 'boarding_confirmation_v1', 'exec_preboard_opentowork_v1']);
const TEMPLATE_ALPHA_ANNOUNCEMENT    = TEMPLATES.alphaflightannouncement_v1;
const TEMPLATE_BOARDING_CONFIRMATION = TEMPLATES.boarding_confirmation_v1;
const TEMPLATE_EXEC_PREBOARD         = TEMPLATES.exec_preboard_opentowork_v1;

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
  const templateKey = templateKeyForId(templateId);
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
 * Routes to the correct email sequence based on seat.boarding_type:
 *   - "executive_pre" → exec_preboard_opentowork_v1 (single send)
 *   - default         → alphaflightannouncement_v1 + boarding_confirmation_v1
 *
 * For the default sequence: if both sends return 2xx, stamps
 * boarding_confirmation_sent_at on the Seat record. Idempotent: skips
 * the stamp if boarding_confirmation_sent_at is already set.
 *
 * @param {object} seat - Seat entity record from Base44
 * @param {string} seat.id                          - Seat record ID
 * @param {string} seat.user_email                  - Passenger email
 * @param {string} seat.first_name                  - Passenger first name
 * @param {string} seat.last_name                   - Passenger last name
 * @param {string} [seat.boarding_type]             - "executive_pre" routes to exec_preboard template
 * @param {string} [seat.pid]                       - Passenger ID string (used in exec_preboard template)
 * @param {string} [seat.tuj_code]                  - TUJ code (used in exec_preboard template)
 * @param {string} [seat.flight_id]                 - Flight ID (for correlation)
 * @param {string} [seat.passenger_id]              - Passenger ID (for correlation)
 * @param {string} [seat.request_id]                - Request ID (for correlation)
 * @param {string|null} seat.boarding_confirmation_sent_at - Idempotency check (default path)
 * @param {string|null} seat.exec_preboard_sent_at           - Idempotency check (executive_pre path)
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
    boarding_type,
    pid,
    tuj_code,
    flight_id,
    passenger_id,
    request_id,
    boarding_confirmation_sent_at,
    exec_preboard_sent_at
  } = seat;

  // Validate required fields
  if (!user_email || !first_name || !last_name) {
    console.error(`[sendgrid-integration] Seat ${seatId} missing required fields (user_email, first_name, last_name) — aborting`);
    return { success: false, error: 'Missing required seat fields' };
  }

  // Idempotency guard — executive_pre path: skip if already stamped
  if (boarding_type === 'executive_pre' && exec_preboard_sent_at) {
    console.log(`[sendgrid-integration] Seat ${seatId} already has exec_preboard_sent_at (${exec_preboard_sent_at}) — skipping send`);
    return { success: true, skipped: true };
  }

  // Idempotency guard — default path: skip if already stamped
  if (boarding_confirmation_sent_at && boarding_type !== 'executive_pre') {
    console.log(`[sendgrid-integration] Seat ${seatId} already has boarding_confirmation_sent_at (${boarding_confirmation_sent_at}) — skipping send`);
    return { success: true, skipped: true };
  }

  const correlation_id = buildCorrelationId({ flightId: flight_id, passengerId: passenger_id, requestId: request_id });
  const logCtx = {
    correlation_id,
    boarding_type: boarding_type || 'default',
    flight_id:    flight_id    || undefined,
    passenger_id: passenger_id || undefined,
    request_id:   request_id   || undefined
  };

  // ── Executive Pre-Board path ───────────────────────────────────────────────
  if (boarding_type === 'executive_pre') {
    console.log(`[sendgrid-integration] Seat ${seatId} — boarding_type=executive_pre, routing to exec_preboard_opentowork_v1`);

    // Validate pid and tuj_code — both are required template variables.
    // Whitespace-only values are treated as missing to prevent blank placeholder renders.
    const pidTrim    = pid      && pid.trim();
    const tujTrim    = tuj_code && tuj_code.trim();
    if (!pidTrim || !tujTrim) {
      const missing = [!pidTrim && 'pid', !tujTrim && 'tuj_code'].filter(Boolean).join(', ');
      console.error(`[sendgrid-integration] Seat ${seatId} — exec_preboard_opentowork_v1 aborted: missing required fields: ${missing}`);
      return { success: false, error: `exec_preboard_opentowork_v1 requires non-empty: ${missing}` };
    }

    const execDynamicData = { first_name, last_name, user_email, pid: pidTrim, tuj_code: tujTrim };
    const execSent = await sendTemplate(apiKey, fromEmail, user_email, TEMPLATE_EXEC_PREBOARD, execDynamicData, logCtx);

    if (!execSent) {
      console.error(`[sendgrid-integration] exec_preboard_opentowork_v1 failed for seat ${seatId}`);
      return { success: false, error: 'exec_preboard_opentowork_v1 send failed' };
    }

    // Send confirmed 2xx — stamp exec_preboard_sent_at for idempotency.
    // A failed stamp write is treated as a hard failure: returning success here
    // would allow a duplicate trigger to re-send the template (no guard to stop it).
    if (base44SeatUrl && seatId) {
      const stamped = await updateSeatRecord(base44SeatUrl, seatId, {
        exec_preboard_sent_at: new Date().toISOString()
      });
      if (!stamped) {
        console.error(`[sendgrid-integration] Seat ${seatId} — exec_preboard_sent_at stamp failed; returning error to prevent duplicate sends`);
        return { success: false, error: 'exec_preboard_sent_at stamp write failed' };
      }
    } else {
      console.warn('[sendgrid-integration] BASE44_SEAT_URL not set — exec_preboard_sent_at stamp skipped');
    }

    return { success: true };
  }

  // ── Default Phase 2 boarding sequence ─────────────────────────────────────
  const dynamicData = { first_name, last_name, user_email };

  // Send 1: alphaflightannouncement_v1
  const announcementSent = await sendTemplate(apiKey, fromEmail, user_email, TEMPLATE_ALPHA_ANNOUNCEMENT, dynamicData, logCtx);

  if (!announcementSent) {
    console.error(`[sendgrid-integration] alphaflightannouncement_v1 failed for seat ${seatId} — aborting sequence`);
    return { success: false, error: 'alphaflightannouncement_v1 send failed' };
  }

  // Send 2: boarding_confirmation_v1
  const confirmationSent = await sendTemplate(apiKey, fromEmail, user_email, TEMPLATE_BOARDING_CONFIRMATION, dynamicData, logCtx);

  if (!confirmationSent) {
    console.error(`[sendgrid-integration] boarding_confirmation_v1 failed for seat ${seatId} — announcement already sent, stamp withheld`);
    return { success: false, error: 'boarding_confirmation_v1 send failed' };
  }

  // Both sends confirmed 2xx — stamp boarding_confirmation_sent_at
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
