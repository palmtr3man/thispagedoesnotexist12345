/**
 * F-190 — handleSeatOpened / sendSeatConfirmation
 * Netlify Function: sendgrid-integration
 *
 * Triggered when a Seat entity is activated (admin opens a Seat record in Base44).
 * Dispatches the correct email sequence based on boarding_type and cabin_class:
 *
 *   boarding_type = "executive_pre"
 *     → exec_preboard_opentowork_v1  (single send; no boarding_confirmation stamp)
 *
 *   boarding_type = anything else (F-190 dual-tier boarding sequence)
 *     1. boarding_pass_paid_v1   (if cabin_class === 'First')
 *        boarding_pass_free_v1   (all other cabin_class values)
 *     2. boarding_instructions_paid_v1   (if cabin_class === 'First')
 *        boarding_instructions_free_v1   (all other cabin_class values)
 *     After both confirm 2xx, stamps boarding_confirmation_sent_at on the Seat record.
 *
 * Provider: SendGrid only (AutoSend retired Apr 12, 2026 — F-190 Phase 2).
 *
 * Idempotency guard: will not overwrite boarding_confirmation_sent_at if already set.
 * All sends BCC support@thispagedoesnotexist12345.com per universal BCC rule.
 *
 * Required env vars:
 *   SENDGRID_API_KEY              — SendGrid API key
 *   SENDGRID_FROM_EMAIL           — Sender address (default: noreply@thispagedoesnotexist12345.com)
 *   BASE44_SEAT_URL               — Base44 Seat record read/update endpoint
 *   SITE_URL                      — Base URL for CTA deep-links (default: https://thispagedoesnotexist12345.com)
 *   SENDGRID_DEBUG                — Set to "true" to emit structured JSON observability logs
 *   SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL — ASM group ID (default: 33047)
 *   SENDGRID_UNSUBSCRIBE_GROUP_MARKETING     — ASM marketing group ID (optional)
 *
 * Spec references:
 *   - F-190 — AutoSend / SendGrid Parallel Alignment (Phase 2: AutoSend retired Apr 12, 2026)
 *   - F152  — SendGrid Unsubscribe Group Wiring + Preference Center
 *   - Feature 101 — Fix 1: passport_url with ?seat_id= appended
 *   - Feature 144 — Fix 2: first_task_url / secondary_url with ?seat_id= appended
 *   - Base44 Seat entity: cabin_class enum ('First' | 'Sponsored' | 'Economy')
 */

const { TEMPLATES, assertTemplates, templateKeyForId } = require('./sendgrid-templates');

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const BCC_EMAIL        = 'support@thispagedoesnotexist12345.com';
const FUNCTION_NAME    = process.env.AWS_LAMBDA_FUNCTION_NAME || 'sendgrid-integration';
const STAGE            = process.env.CONTEXT || process.env.NODE_ENV || 'unknown';

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
 * Uses a 10s timeout to prevent indefinite hangs.
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
      signal: AbortSignal.timeout(10000), // 10s — prevent indefinite hang
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
 *   - "executive_pre" → exec_preboard_opentowork_v1 (single send)
 *   - default         → boarding_pass + boarding_instructions (dual-tier)
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
 * @param {string} [seat.tuj_code]                  - TUJ code — canonical seat ID for CTA URLs (e.g. TUJ-KC2222)
 * @param {string} [seat.flight_id]                 - Flight ID (for correlation)
 * @param {string} [seat.passenger_id]              - Passenger ID (for correlation)
 * @param {string} [seat.request_id]                - Request ID (for correlation)
 * @param {string|null} seat.boarding_confirmation_sent_at - Idempotency check
 */
async function sendSeatConfirmation(seat) {
  const sendgridKey   = process.env.SENDGRID_API_KEY;
  const fromEmail     = process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const base44SeatUrl = process.env.BASE44_SEAT_URL;
  const siteUrl       = (process.env.SITE_URL || 'https://thispagedoesnotexist12345.com').replace(/\/$/, '');

  if (!sendgridKey) {
    console.error('[sendgrid-integration] SENDGRID_API_KEY is not set — aborting');
    return { success: false, error: 'SENDGRID_API_KEY not configured' };
  }

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
    exec_preboard_sent_at,
    flight_display_name
  } = seat;

  // Validate required fields
  if (!user_email || !first_name || !last_name) {
    console.error(`[sendgrid-integration] Seat ${seatId} missing required fields (user_email, first_name, last_name) — aborting`);
    return { success: false, error: 'Missing required seat fields' };
  }

  // F-190 Post-Apr-12 Hardening (86agrt0g5): boarding_type is required.
  // If absent, abort immediately — do NOT silently fall through to the default boarding sequence.
  // An exec_pre seat missing boarding_type would otherwise receive the standard boarding emails,
  // which is a silent misroute with no error logged. Operator must set boarding_type via Tower
  // before triggering handleSeatOpened.
  if (!boarding_type) {
    const msg = `Seat ${seatId} missing boarding_type — aborting to prevent misroute. Set boarding_type via Tower before triggering handleSeatOpened.`;
    console.error(`[sendgrid-integration] ${msg}`, JSON.stringify({ seat_id: seatId, correlation_id: buildCorrelationId({ flightId: flight_id, passengerId: passenger_id, requestId: request_id }) }));
    return { success: false, error: 'boarding_type is required — set via Tower before triggering handleSeatOpened' };
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
  if (boarding_type === 'executive_pre') {
    console.log(`[sendgrid-integration] Seat ${seatId} — boarding_type=executive_pre, routing to exec_preboard_opentowork_v1`);
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
  // F-190 Apr 12: CTA URLs use tuj_code (canonical TUJ seat ID e.g. TUJ-KC2222), not seat.id (UUID).
  //   first_task_url corrected to /ResumeFitCheck (was /Studio — wrong path).
  //   secondary_url corrected to /OnboardingPassport (was bare siteUrl — missing path).
  // P2 Fix (Apr 19, 2026): &tuj_code= appended to firstTaskUrl, secondaryUrl, and mission_studio
  //   so all 3 CTA links carry both seat_id and tuj_code. Closes P2 open bug.
  const canonicalSeatId = tuj_code || seatId || '';  // prefer TUJ code for CTA URLs; fall back to UUID
  const passportUrl   = `${siteUrl}/?seat_id=${canonicalSeatId}`;
  const firstTaskUrl  = `${siteUrl}/ResumeFitCheck?seat_id=${canonicalSeatId}&tuj_code=${canonicalSeatId}`;
  const secondaryUrl  = `${siteUrl}/OnboardingPassport?seat_id=${canonicalSeatId}&tuj_code=${canonicalSeatId}`;
  const mainSiteUrl   = 'https://www.thispagedoesnotexist12345.com';
  const platformTechUrl = 'https://www.thispagedoesnotexist12345.tech'; // Base44 app — /Dashboard, /FlightLog, /CommandCenter etc.
  const flightLabel   = flight_display_name || flight_id || 'TUJ FLIGHT';

  // Fix 5b (Apr 18, 2026): add signup_date (boarding_pass_free_v1 uses {{signup_date}})
  //   and tuj_code (boarding_pass_paid_v1 uses {{tuj_code}} for tracking).
  //   signup_date defaults to today's date in a readable format if not supplied.
  const signupDate = seat.signup_date ||
    new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const dynamicData = {
    first_name,
    last_name,
    user_email,
    seat_id:             canonicalSeatId,
    seatreference:       canonicalSeatId,
    tuj_code:            canonicalSeatId,        // Fix 5b: boarding_pass_paid_v1 uses {{tuj_code}}
    cabin_class:         cabin_class || 'Economy',
    signup_date:         signupDate,             // Fix 5b: boarding_pass_free_v1 uses {{signup_date}}
    passport_url:        passportUrl,
    first_task_url:      firstTaskUrl,
    secondary_url:       secondaryUrl,
    platform_url:        mainSiteUrl,           // Fix 4: resolves {{platform_url}} Main Site footer link
    flight_code:         flightLabel,           // canonical token — all boarding templates use {{flight_code}}
    flight_id:           flightLabel,           // alias: seat_request_acknowledgement_v1 uses {{flight_id}} (Apr 19, 2026 alignment)
    flight_display_name: flightLabel,           // kept for backward-compat

    // Mission Control deep-link fields (spec: link audit rewrite, Apr 2026)
    // Templates should use these instead of root-only /?seat_id= links.
    // Routes on the Base44 .tech app use platformTechUrl; .com Studio uses mainSiteUrl.
    mission_passengers:   `${platformTechUrl}/Passengers?seat_id=${canonicalSeatId}`,
    mission_flight_log:   `${platformTechUrl}/FlightLog?seat_id=${canonicalSeatId}`,
    mission_applications: `${platformTechUrl}/Applications?seat_id=${canonicalSeatId}`,
    mission_reminders:    `${platformTechUrl}/FlightLog?view=reminders&seat_id=${canonicalSeatId}`,
    mission_interviews:   `${platformTechUrl}/InterviewsAndFollowUps?seat_id=${canonicalSeatId}`,
    mission_dashboard:    `${platformTechUrl}/Dashboard?seat_id=${canonicalSeatId}`,
    mission_command:      `${platformTechUrl}/CommandCenter?seat_id=${canonicalSeatId}`,
    mission_studio:       `${mainSiteUrl}/Studio?seat_id=${canonicalSeatId}&tuj_code=${canonicalSeatId}`,
  };

  // Select templates based on tier
  const boardingPassTemplateId        = isPaid ? TEMPLATE_BOARDING_PASS_PAID        : TEMPLATE_BOARDING_PASS_FREE;
  const boardingInstructionsTemplateId = isPaid ? TEMPLATE_BOARDING_INSTRUCTIONS_PAID : TEMPLATE_BOARDING_INSTRUCTIONS_FREE;
  const passTierKey         = `boarding_pass_${isPaid ? 'paid' : 'free'}_v1`;
  const instructionsTierKey = `boarding_instructions_${isPaid ? 'paid' : 'free'}_v1`;

  // Send 1: boarding_pass (paid or free)
  const passSent = await sendViaSendGrid(
    sendgridKey, fromEmail, user_email,
    boardingPassTemplateId, dynamicData,
    { ...logCtx, template_key: passTierKey }
  );
  if (!passSent) {
    console.error(`[sendgrid-integration] ${passTierKey} send failed for seat ${seatId} — aborting sequence`);
    return { success: false, error: `${passTierKey} send failed` };
  }

  // Send 2: boarding_instructions (paid or free)
  const instructionsSent = await sendViaSendGrid(
    sendgridKey, fromEmail, user_email,
    boardingInstructionsTemplateId, dynamicData,
    { ...logCtx, template_key: instructionsTierKey }
  );
  if (!instructionsSent) {
    console.error(`[sendgrid-integration] ${instructionsTierKey} send failed for seat ${seatId} — boarding_pass already sent, stamp withheld`);
    return { success: false, error: `${instructionsTierKey} send failed` };
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
  module.exports.sendViaSendGrid      = sendViaSendGrid;
  module.exports.updateSeatRecord     = updateSeatRecord;
  module.exports.buildCorrelationId   = buildCorrelationId;
}
