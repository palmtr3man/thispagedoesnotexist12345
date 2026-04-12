/**
 * F-190 — handleSeatOpened / sendSeatConfirmation
 * Netlify Function: sendgrid-integration
 *
 * Triggered when a Seat entity is activated (admin opens a Seat record in Base44).
 * Dispatches the correct email sequence based on boarding_type and cabin_class:
 *
 *   boarding_type = "executive_pre"
 *     → exec_preboard_opentowork_v1  (single send; SendGrid only; no boarding_confirmation stamp)
 *
 *   boarding_type = anything else (F-190 dual-tier boarding sequence)
 *     1. boarding_pass_paid_v1   (if cabin_class === 'First')
 *        boarding_pass_free_v1   (all other cabin_class values)
 *     2. boarding_instructions_paid_v1   (if cabin_class === 'First')
 *        boarding_instructions_free_v1   (all other cabin_class values)
 *     After both confirm 2xx, stamps boarding_confirmation_sent_at on the Seat record.
 *
 * Provider routing (F-190):
 *   Primary:  AutoSend  (AUTOSEND_API_KEY + AUTOSEND_TEMPLATE_* env vars)
 *   Fallback: SendGrid  (SENDGRID_API_KEY + SENDGRID_TEMPLATE_* env vars)
 *   Override: Set EMAIL_PRIMARY_PROVIDER=sendgrid to bypass AutoSend entirely.
 *
 * Idempotency guard: will not overwrite boarding_confirmation_sent_at if already set.
 * All sends BCC support@thispagedoesnotexist12345.com per universal BCC rule.
 *
 * Required env vars:
 *   SENDGRID_API_KEY              — SendGrid API key (fallback path)
 *   AUTOSEND_API_KEY              — AutoSend Bearer token (primary path)
 *   SENDGRID_FROM_EMAIL           — Sender address (default: noreply@thispagedoesnotexist12345.com)
 *   BASE44_SEAT_URL               — Base44 Seat record read/update endpoint
 *   SITE_URL                      — Base URL for CTA deep-links (default: https://thispagedoesnotexist12345.com)
 *   EMAIL_PRIMARY_PROVIDER        — Set to "sendgrid" to force SendGrid; default is AutoSend
 *   SENDGRID_DEBUG                — Set to "true" to emit structured JSON observability logs
 *
 * AutoSend template env vars (deployed to Netlify Apr 4, 2026):
 *   AUTOSEND_TEMPLATE_BOARDING_PASS_FREE
 *   AUTOSEND_TEMPLATE_BOARDING_PASS_PAID
 *   AUTOSEND_TEMPLATE_BOARDING_INSTRUCTIONS_FREE
 *   AUTOSEND_TEMPLATE_BOARDING_INSTRUCTIONS_PAID
 *
 * Spec references:
 *   - F-190 — AutoSend / SendGrid Parallel Alignment
 *   - Feature 101 — Fix 1: passport_url with ?seat_id= appended
 *   - Feature 144 — Fix 2: first_task_url / secondary_url with ?seat_id= appended
 *   - Base44 Seat entity: cabin_class enum ('First' | 'Sponsored' | 'Economy')
 */

const { TEMPLATES, assertTemplates, templateKeyForId } = require('./sendgrid-templates');

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const AUTOSEND_API_URL = 'https://api.autosend.io/v1/transactional/send';
const BCC_EMAIL        = 'support@thispagedoesnotexist12345.com';
const FUNCTION_NAME    = process.env.AWS_LAMBDA_FUNCTION_NAME || 'sendgrid-integration';
const STAGE            = process.env.CONTEXT || process.env.NODE_ENV || 'unknown';

// AutoSend template IDs — canonical values from Template Registry (Apr 4, 2026)
const AUTOSEND_TEMPLATES = {
  boarding_pass_free_v1:           process.env.AUTOSEND_TEMPLATE_BOARDING_PASS_FREE         || '69d1d387f27358a37673e394',
  boarding_pass_paid_v1:           process.env.AUTOSEND_TEMPLATE_BOARDING_PASS_PAID         || '69d1d388f27358a37673e399',
  boarding_instructions_free_v1:   process.env.AUTOSEND_TEMPLATE_BOARDING_INSTRUCTIONS_FREE || '69d1d38af27358a37673e39e',
  boarding_instructions_paid_v1:   process.env.AUTOSEND_TEMPLATE_BOARDING_INSTRUCTIONS_PAID || '69d1d38cf27358a37673e3a3',
};

// SendGrid template IDs — sourced from sendgrid-templates.js (do not hardcode d-... here)
assertTemplates([
  'boarding_pass_free_v1',
  'boarding_pass_paid_v1',
  'boarding_instructions_free_v1',
  'boarding_instructions_paid_v1',
  'exec_preboard_opentowork_v1'
]);

const TEMPLATE_BOARDING_PASS_FREE           = TEMPLATES.boarding_pass_free_v1;
const TEMPLATE_BOARDING_PASS_PAID           = TEMPLATES.boarding_pass_paid_v1;
const TEMPLATE_BOARDING_INSTRUCTIONS_FREE   = TEMPLATES.boarding_instructions_free_v1;
const TEMPLATE_BOARDING_INSTRUCTIONS_PAID   = TEMPLATES.boarding_instructions_paid_v1;
const TEMPLATE_EXEC_PREBOARD                = TEMPLATES.exec_preboard_opentowork_v1;

/**
 * Emit a structured observability log line (gated by SENDGRID_DEBUG=true).
 * Never logs request body, personalizations, or API key.
 */
function sgLog(fields) {
  if (process.env.SENDGRID_DEBUG !== 'true') return;
  console.log(JSON.stringify({ event: 'tuj_email_send', function: FUNCTION_NAME, stage: STAGE, ...fields }));
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
 */
async function sendViaSendGrid(apiKey, fromEmail, toEmail, templateId, dynamicData, logCtx = {}) {
  const templateKey = templateKeyForId(templateId);
  // F152 — ASM unsubscribe group wiring
  const asmGroupId          = parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL || '33047', 10);
  const asmMarketingGroupId = process.env.SENDGRID_UNSUBSCRIBE_GROUP_MARKETING
    ? parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_MARKETING, 10)
    : null;
  const asmGroupsToDisplay  = asmMarketingGroupId
    ? [asmGroupId, asmMarketingGroupId]
    : [asmGroupId];
  const payload = {
    from: { email: fromEmail },
    personalizations: [{
      to:  [{ email: toEmail }],
      bcc: [{ email: BCC_EMAIL }],
      dynamic_template_data: dynamicData
    }],
    template_id: templateId,
    asm: { group_id: asmGroupId, groups_to_display: asmGroupsToDisplay }
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
      provider:             'sendgrid',
      template_key:         templateKey,
      sendgrid_template_id: templateId,
      status:               sgStatus,
      elapsed_ms,
      ok,
    });
    if (ok) {
      console.log(`[sendgrid-integration] SendGrid: ${templateKey} sent to ${toEmail} — status ${sgStatus}`);
      return true;
    }
    const errorText = await response.text();
    console.error(`[sendgrid-integration] SendGrid: ${templateKey} failed for ${toEmail} — status ${sgStatus}:`, errorText);
    return false;
  } catch (err) {
    const elapsed_ms = Date.now() - t0;
    sgLog({
      ...logCtx,
      provider:      'sendgrid',
      template_key:  templateKey,
      ok:            false,
      elapsed_ms,
      error_name:    err?.name,
      error_message: err?.message,
    });
    console.error(`[sendgrid-integration] SendGrid: ${templateKey} unexpected error for ${toEmail}:`, err);
    return false;
  }
}

/**
 * Send a single AutoSend transactional template email.
 * Returns true on 2xx, false otherwise.
 */
async function sendViaAutoSend(autosendKey, fromEmail, toEmail, templateId, dynamicData, logCtx = {}) {
  const payload = {
    template_id: templateId,
    to:          toEmail,
    from:        fromEmail,
    bcc:         BCC_EMAIL,
    variables:   dynamicData
  };
  const t0 = Date.now();
  let asStatus;
  try {
    const response = await fetch(AUTOSEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${autosendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    asStatus = response.status;
    const ok = response.ok;
    const elapsed_ms = Date.now() - t0;
    sgLog({
      ...logCtx,
      provider:             'autosend',
      autosend_template_id: templateId,
      status:               asStatus,
      elapsed_ms,
      ok,
    });
    if (ok) {
      console.log(`[sendgrid-integration] AutoSend: template ${templateId} sent to ${toEmail} — status ${asStatus}`);
      return true;
    }
    const errorText = await response.text();
    console.error(`[sendgrid-integration] AutoSend: template ${templateId} failed for ${toEmail} — status ${asStatus}:`, errorText);
    return false;
  } catch (err) {
    const elapsed_ms = Date.now() - t0;
    sgLog({
      ...logCtx,
      provider:      'autosend',
      ok:            false,
      elapsed_ms,
      error_name:    err?.name,
      error_message: err?.message,
    });
    console.error(`[sendgrid-integration] AutoSend: template ${templateId} unexpected error for ${toEmail}:`, err);
    return false;
  }
}

/**
 * sendTemplate — provider-aware dispatcher.
 *
 * Tries AutoSend first (unless EMAIL_PRIMARY_PROVIDER=sendgrid).
 * Falls back to SendGrid on AutoSend failure.
 * Logs provider_attempted, provider_result, and fallback_triggered on every send.
 *
 * @param {object} keys         - { sendgridKey, autosendKey }
 * @param {string} fromEmail    - Sender address
 * @param {string} toEmail      - Recipient address
 * @param {object} templatePair - { autosend: '<autosend-id>', sendgrid: '<d-...>' }
 * @param {object} dynamicData  - Template variables
 * @param {object} logCtx       - Correlation context
 * @returns {Promise<{ ok: boolean, provider: string, fallback: boolean }>}
 */
async function sendTemplate(keys, fromEmail, toEmail, templatePair, dynamicData, logCtx = {}) {
  const { sendgridKey, autosendKey } = keys;
  const forcesSendGrid = process.env.EMAIL_PRIMARY_PROVIDER === 'sendgrid';

  // ── AutoSend primary path ──────────────────────────────────────────────────
  if (!forcesSendGrid && autosendKey && templatePair.autosend) {
    const ok = await sendViaAutoSend(autosendKey, fromEmail, toEmail, templatePair.autosend, dynamicData, logCtx);
    if (ok) {
      console.log(`[sendgrid-integration] provider_attempted=autosend provider_result=success fallback_triggered=false`);
      return { ok: true, provider: 'autosend', fallback: false };
    }
    console.warn(`[sendgrid-integration] AutoSend failed — falling back to SendGrid`);
  }

  // ── SendGrid fallback (or primary if forced) ───────────────────────────────
  if (sendgridKey && templatePair.sendgrid) {
    const ok = await sendViaSendGrid(sendgridKey, fromEmail, toEmail, templatePair.sendgrid, dynamicData, logCtx);
    const fallback = !forcesSendGrid;
    console.log(`[sendgrid-integration] provider_attempted=sendgrid provider_result=${ok ? 'success' : 'failure'} fallback_triggered=${fallback}`);
    return { ok, provider: 'sendgrid', fallback };
  }

  console.error(`[sendgrid-integration] No valid provider available for ${toEmail} — both AutoSend and SendGrid unconfigured`);
  return { ok: false, provider: 'none', fallback: false };
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
 * Routes to the correct email sequence based on seat.boarding_type and seat.cabin_class:
 *   - "executive_pre" → exec_preboard_opentowork_v1 (single send, SendGrid only)
 *   - default         → boarding_pass + boarding_instructions (dual-tier, AutoSend primary)
 *
 * Tier determination uses seat.cabin_class (Base44 canonical field):
 *   cabin_class === 'First' → paid templates
 *   all other values        → free templates
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
 * @param {string} [seat.cabin_class]               - 'First' | 'Sponsored' | 'Economy' (tier field)
 * @param {string} [seat.boarding_type]             - "executive_pre" routes to exec_preboard template
 * @param {string} [seat.pid]                       - Passenger ID string (exec_preboard template)
 * @param {string} [seat.tuj_code]                  - TUJ code (exec_preboard template)
 * @param {string} [seat.flight_id]                 - Flight ID (for correlation)
 * @param {string} [seat.passenger_id]              - Passenger ID (for correlation)
 * @param {string} [seat.request_id]                - Request ID (for correlation)
 * @param {string|null} seat.boarding_confirmation_sent_at - Idempotency check
 */
async function sendSeatConfirmation(seat) {
  const sendgridKey   = process.env.SENDGRID_API_KEY;
  const autosendKey   = process.env.AUTOSEND_API_KEY;
  const fromEmail     = process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const base44SeatUrl = process.env.BASE44_SEAT_URL;
  const siteUrl       = (process.env.SITE_URL || 'https://thispagedoesnotexist12345.com').replace(/\/$/, '');

  if (!sendgridKey && !autosendKey) {
    console.error('[sendgrid-integration] Neither SENDGRID_API_KEY nor AUTOSEND_API_KEY is set — aborting');
    return { success: false, error: 'No email provider API key configured' };
  }

  const keys = { sendgridKey, autosendKey };

  const {
    id: seatId,
    user_email,
    first_name,
    last_name,
    cabin_class,
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
    seat_id:       seatId,
    cabin_class:   cabin_class || 'unknown',
    boarding_type: boarding_type || 'default',
    flight_id:     flight_id    || undefined,
    passenger_id:  passenger_id || undefined,
    request_id:    request_id   || undefined
  };

  // ── Executive Pre-Board path ───────────────────────────────────────────────
  // exec_preboard uses SendGrid only (no AutoSend template for this path)
  if (boarding_type === 'executive_pre') {
    console.log(`[sendgrid-integration] Seat ${seatId} — boarding_type=executive_pre, routing to exec_preboard_opentowork_v1`);
    if (!sendgridKey) {
      console.error(`[sendgrid-integration] exec_preboard path requires SENDGRID_API_KEY — not set`);
      return { success: false, error: 'SENDGRID_API_KEY not configured for exec_preboard path' };
    }
    // Validate pid and tuj_code — both are required template variables.
    // Whitespace-only values are treated as missing to prevent blank placeholder renders.
    const pidTrim  = pid      && pid.trim();
    const tujTrim  = tuj_code && tuj_code.trim();
    if (!pidTrim || !tujTrim) {
      const missing = [!pidTrim && 'pid', !tujTrim && 'tuj_code'].filter(Boolean).join(', ');
      console.error(`[sendgrid-integration] Seat ${seatId} — exec_preboard_opentowork_v1 aborted: missing required fields: ${missing}`);
      return { success: false, error: `exec_preboard_opentowork_v1 requires non-empty: ${missing}` };
    }
    const execDynamicData = { first_name, last_name, user_email, pid: pidTrim, tuj_code: tujTrim };
    const execSent = await sendViaSendGrid(sendgridKey, fromEmail, user_email, TEMPLATE_EXEC_PREBOARD, execDynamicData, logCtx);
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

  // ── F-190 Dual-Tier Boarding Sequence ─────────────────────────────────────
  // Tier determination: cabin_class === 'First' → paid; all other values → free
  // (Base44 canonical field is cabin_class, NOT tier or cabin_tier)
  const isPaid = cabin_class === 'First';
  console.log(`[sendgrid-integration] Seat ${seatId} — cabin_class=${cabin_class || 'undefined'} → ${isPaid ? 'PAID' : 'FREE'} boarding sequence`);

  // Construct full payload (Fix 1 + Fix 2: all CTAs include ?seat_id=)
  // Fix 4 (Apr 5, 2026): platform_url added — resolves {{platform_url}} Main Site footer link in
  //   boarding_pass_free_v1, boarding_pass_paid_v1, boarding_instructions_free_v1,
  //   boarding_instructions_paid_v1. Was previously unmapped -> rendered as base44.app URL.
  // Fix 3b (Apr 5, 2026): passport_url corrected to /?seat_id= (was /Studio?seat_id=).
  //   seat_id chars (A-Z, 2-9, hyphen) are URL-safe — encodeURIComponent removed per canonical spec.
  //   firstTaskUrl retains /Studio path (boarding instructions CTA — ResumeFitCheck deep-link).
  const passportUrl   = `${siteUrl}/?seat_id=${seatId || ''}`;
  const firstTaskUrl  = `${siteUrl}/Studio?seat_id=${seatId || ''}`;
  const secondaryUrl  = `${siteUrl}?seat_id=${seatId || ''}`;
  const mainSiteUrl   = 'https://www.thispagedoesnotexist12345.com';

  const dynamicData = {
    first_name,
    last_name,
    user_email,
    seat_id:        seatId || '',
    seatreference:  seatId || '',
    cabin_class:    cabin_class || 'Economy',
    passport_url:   passportUrl,
    first_task_url: firstTaskUrl,
    secondary_url:  secondaryUrl,
    platform_url:   mainSiteUrl        // Fix 4: resolves {{platform_url}} Main Site footer link
  };

  // Template pairs: { autosend: '<autosend-id>', sendgrid: '<d-...>' }
  const boardingPassTemplate = isPaid
    ? { autosend: AUTOSEND_TEMPLATES.boarding_pass_paid_v1,         sendgrid: TEMPLATE_BOARDING_PASS_PAID }
    : { autosend: AUTOSEND_TEMPLATES.boarding_pass_free_v1,         sendgrid: TEMPLATE_BOARDING_PASS_FREE };

  const boardingInstructionsTemplate = isPaid
    ? { autosend: AUTOSEND_TEMPLATES.boarding_instructions_paid_v1, sendgrid: TEMPLATE_BOARDING_INSTRUCTIONS_PAID }
    : { autosend: AUTOSEND_TEMPLATES.boarding_instructions_free_v1, sendgrid: TEMPLATE_BOARDING_INSTRUCTIONS_FREE };

  // Send 1: boarding_pass (paid or free)
  const passResult = await sendTemplate(keys, fromEmail, user_email, boardingPassTemplate, dynamicData, { ...logCtx, template_key: `boarding_pass_${isPaid ? 'paid' : 'free'}_v1` });
  if (!passResult.ok) {
    console.error(`[sendgrid-integration] boarding_pass send failed for seat ${seatId} — aborting sequence`);
    return { success: false, error: `boarding_pass_${isPaid ? 'paid' : 'free'}_v1 send failed` };
  }

  // Send 2: boarding_instructions (paid or free)
  const instructionsResult = await sendTemplate(keys, fromEmail, user_email, boardingInstructionsTemplate, dynamicData, { ...logCtx, template_key: `boarding_instructions_${isPaid ? 'paid' : 'free'}_v1` });
  if (!instructionsResult.ok) {
    console.error(`[sendgrid-integration] boarding_instructions send failed for seat ${seatId} — boarding_pass already sent, stamp withheld`);
    return { success: false, error: `boarding_instructions_${isPaid ? 'paid' : 'free'}_v1 send failed` };
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
  module.exports.sendViaSendGrid      = sendViaSendGrid;
  module.exports.sendViaAutoSend      = sendViaAutoSend;
  module.exports.updateSeatRecord     = updateSeatRecord;
  module.exports.buildCorrelationId   = buildCorrelationId;
}
