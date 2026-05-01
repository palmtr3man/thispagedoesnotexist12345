/**
 * /api/seat-request — Netlify Function (Gate Contract v2)
 *
 * Upgrades over v1:
 *   1. Validates age_token (HMAC-signed token from /api/verify-age — rejects if missing/invalid/expired)
 *   2. Generates seat_id in TUJ-XXXXXX format
 *   3. Calls beehiiv API to auto-subscribe email to Signal newsletter
 *   4. Returns { ok: true, seat_id, status } in response body
 *   5. Base44 write remains a graceful stub (wires in when credits return)
 *
 * Required Netlify env vars:
 *   SENDGRID_API_KEY              — SendGrid API key
 *   SENDGRID_FROM_EMAIL         — Sender address (default: noreply@thispagedoesnotexist12345.com)
 *   SENDGRID_TEMPLATE_SEAT_REQUEST — seat_request_acknowledgement_v1 template ID (canonical fallback defined in sendgrid-templates.js)
 *   PLATFORM_URL             — Platform URL injected into email (default: https://www.thispagedoesnotexist12345.com)
 *   SIGNAL_URL               — Signal newsletter URL injected into email
 *   BASE44_SEAT_REQUEST_URL  — Base44 endpoint for seat-request writes (optional; skipped if unset)
 *   BEEHIIV_API_KEY          — beehiiv API key
 *   BEEHIIV_PUB_ID           — beehiiv Publication ID (default: pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf)
 *
 * Request body (JSON):
 *   { name: string, email: string, age_token: string, source?: string, tier?: string, cabin_tier?: string, amount_paid?: number, referral_code?: string }
 *
 * BLOCKER-04 (2026-04-12): age_confirmed boolean replaced with age_token (HMAC-signed).
 * Supabase waitlist_submissions upsert added after SendGrid ack.
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars required for Supabase write.
 *
 * Success response:
 *   { ok: true, seat_id: 'TUJ-XXXXXX', status: 'confirmed' }
 *
 * Error response:
 *   { ok: false, error: string }
 *
 * Gate Contract v2 — seat_id bridge + beehiiv auto-subscribe
 *
 * F143 (2026-04-12): Waitlist path now correctly applies Beehiiv 'waitlist' tag
 * via Subscription Tags API (POST /v2/publications/:pubId/subscriptions/:subId/tags).
 * BCC added to next_flight_waitlist_v1 send per universal BCC rule.
 * subscribeToBeehiiv() now returns the sub_id for downstream tag application.
 */

const { TEMPLATES, assertTemplates } = require('./sendgrid-templates');
const { verifyAgeToken } = require('./verify-age');

const FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME || 'seat-request';
const STAGE = process.env.CONTEXT || process.env.NODE_ENV || 'unknown';

/**
 * Emit a structured observability log line (gated by SENDGRID_DEBUG=true).
 * Never logs request body, personalizations, or API key.
 */
function sgLog(fields) {
  if (process.env.SENDGRID_DEBUG !== 'true') return;
  console.log(JSON.stringify({ event: 'tuj_sendgrid_send', function: FUNCTION_NAME, stage: STAGE, ...fields }));
}

// --- SendGrid template IDs (sourced from sendgrid-templates.js — do not hardcode d-... here) ---
assertTemplates(['seat_request_acknowledgement_v1', 'internalsignupnotification_v1', 'next_flight_waitlist_v1']);
const TEMPLATE_ID = TEMPLATES.seat_request_acknowledgement_v1;
const INTERNAL_TEMPLATE_ID = TEMPLATES.internalsignupnotification_v1;
const INTERNAL_NOTIFY_EMAIL = 'support@theultimatejourney.app';
const ASM_GROUP_ID          = parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL || '33047', 10); // "The Ultimate Journey — Transactional" unsubscribe group
const ASM_MARKETING_GROUP_ID = process.env.SENDGRID_UNSUBSCRIBE_GROUP_MARKETING
  ? parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_MARKETING, 10)
  : null;
// groupsToDisplay shows both groups in the preference center when Marketing group is configured (F152).
const ASM_GROUPS_TO_DISPLAY  = ASM_MARKETING_GROUP_ID
  ? [ASM_GROUP_ID, ASM_MARKETING_GROUP_ID]
  : [ASM_GROUP_ID];
const NOTION_API_VERSION = '2022-06-28';
const NOTION_SEAT_REQUEST_DATABASE_ID = process.env.NOTION_SEAT_REQUEST_DATABASE_ID || '5e6440af0ad94c6d89a8442ec2c528f3';
const ACTIVE_FLIGHT_CODE_DEFAULT = 'FL 042126'; // updated Apr 21, 2026 — Alpha Flight 1 rescheduled from FL 041926
const SUBJECT_TEMPLATE = (flightCode) => `Your seat request is in — ${flightCode} ✈️`;

// --- Gate Contract constants ---
const SEAT_ID_PREFIX = 'TUJ-';
const SEAT_ID_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const SEAT_ID_LENGTH = 6;
const MIN_AGE        = 21;

// --- beehiiv defaults ---
const BEEHIIV_PUB_ID_DEFAULT = 'pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf';

// --- Universal BCC (mirrors sendgrid-integration.js convention) ---
const BCC_EMAIL = 'support@thispagedoesnotexist12345.com';

/**
 * Generate a seat_id in TUJ-XXXXXX format.
 * Uses crypto.getRandomValues for randomness in the Netlify edge runtime.
 */
function generateSeatId() {
  let result = SEAT_ID_PREFIX;
  const array = new Uint8Array(SEAT_ID_LENGTH);
  crypto.getRandomValues(array);
  for (let i = 0; i < SEAT_ID_LENGTH; i++) {
    result += SEAT_ID_CHARS[array[i] % SEAT_ID_CHARS.length];
  }
  return result;
}

function notionRichText(content) {
  return [{ type: 'text', text: { content: String(content) } }];
}

/**
 * Check whether an email already has a seat request in the Notion registry.
 * Returns the existing seat_id string if found, or null if not found / API unavailable.
 * Fails gracefully — a Notion outage must not block new seat requests.
 */
async function checkExistingRequest({ email, notionApiKey, databaseId }) {
  if (!notionApiKey) return null;
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + notionApiKey,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_API_VERSION
      },
      body: JSON.stringify({
        // Exclude Denied records so previously denied passengers can re-submit.
        // Denied is treated as a closed/voided state — only Pending Review,
        // Approved, Waitlisted, and Level Lounge are considered active duplicates.
        // Fix (Apr 19, 2026): compound filter added to prevent permanent lockout.
        filter: {
          and: [
            {
              property: 'Email',
              email: { equals: email }
            },
            {
              property: 'Status',
              select: { does_not_equal: 'Denied' }
            }
          ]
        },
        page_size: 1
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      console.warn('[seat-request] Notion dedupe query failed ' + response.status + ': ' + errText);
      return null; // fail open
    }
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      const page = data.results[0];
      const seatIdProp = page.properties && page.properties['Seat ID'];
      const existingSeatId = seatIdProp && seatIdProp.rich_text && seatIdProp.rich_text[0]
        ? seatIdProp.rich_text[0].plain_text
        : null;
      console.log(`[seat-request] Duplicate request detected for ${email} — existing seat_id: ${existingSeatId || 'unknown'}`);
      return existingSeatId || '__duplicate__';
    }
    return null;
  } catch (err) {
    console.warn('[seat-request] Notion dedupe check unexpected error:', err.message);
    return null; // fail open
  }
}

async function logSeatRequestToNotion({ seatId, name, email, requestDate, source, notionApiKey, databaseId }) {
  if (!notionApiKey) {
    console.warn('[seat-request] NOTION_API_KEY not set — skipping Notion log write');
    return false;
  }

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + notionApiKey,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_API_VERSION
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        Name: { title: notionRichText(name) },
        Email: { email },
        'Seat ID': { rich_text: notionRichText(seatId) },
        Source: { rich_text: notionRichText(source) },
        'Request Date': { date: { start: requestDate } }
      }
    })
  });

  if (response.ok) {
    console.log('[seat-request] Notion log written for ' + email + ' seat_id ' + seatId);
    return true;
  }

  const errorText = await response.text();
  console.error('[seat-request] Notion log failed ' + response.status + ': ' + errorText);
  return false;
}

/**
 * Subscribe an email to the Signal beehiiv newsletter.
 * Fails gracefully — logs errors but does not block the seat request.
 * @returns {Promise<string|null>} The beehiiv subscription ID (sub_...) on success, or null on failure.
 */
async function subscribeToBeehiiv(email, firstName, apiKey, pubId) {
  const url = `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        reactivate_existing: false,
        send_welcome_email: true,
        utm_source: 'seat-request',
        utm_medium: 'netlify-function',
        utm_campaign: 'fl041926-gate',
        custom_fields: [
          { name: 'first_name', value: firstName }
        ]
      })
    });

    if (res.ok || res.status === 201 || res.status === 200) {
      const data = await res.json().catch(() => ({}));
      const subId = data?.data?.id || null;
      console.log(`[seat-request] beehiiv subscribe OK for ${email}`, subId || '');
      return subId;
    } else {
      const errText = await res.text();
      console.error(`[seat-request] beehiiv subscribe error ${res.status}:`, errText);
      return null;
    }
  } catch (err) {
    console.error('[seat-request] beehiiv subscribe unexpected error:', err);
    return null;
  }
}

/**
 * Apply the 'waitlist' tag to an existing beehiiv subscriber (F143).
 * Uses the Subscription Tags API: POST /v2/publications/:pubId/subscriptions/:subId/tags
 * Fails gracefully — a tag failure must not block the waitlist response.
 * @param {string} subId   - beehiiv subscription ID (sub_...)
 * @param {string} apiKey  - beehiiv API key
 * @param {string} pubId   - beehiiv publication ID
 */
async function applyBeehiivWaitlistTag(subId, apiKey, pubId) {
  if (!subId) {
    console.warn('[seat-request] applyBeehiivWaitlistTag: no subId — skipping tag apply');
    return;
  }
  const url = `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions/${subId}/tags`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tags: ['waitlist'] })
    });
    if (res.ok || res.status === 200 || res.status === 201) {
      console.log(`[seat-request] beehiiv 'waitlist' tag applied to ${subId}`);
    } else {
      const errText = await res.text();
      console.error(`[seat-request] beehiiv tag apply error ${res.status}:`, errText);
    }
  } catch (err) {
    console.error('[seat-request] beehiiv tag apply unexpected error:', err);
  }
}

exports.handler = async function (event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' })
    };
  }

  // --- Parse body ---
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Invalid JSON body' })
    };
  }

   const { name, email, age_token, source, tier, cabin_tier, amount_paid, referral_code: inboundReferralCode, seat_id_override } = body;
  // --- Validate: age_token (Gate Contract §2a / §5 — BLOCKER-04) ---
  // Must be a valid HMAC-signed token issued by /api/verify-age within the last 24h.
  // age_confirmed: boolean is no longer accepted — token required.
  const ageSecret = process.env.AGE_TOKEN_SECRET;
  const agePayload = ageSecret && age_token ? verifyAgeToken(age_token, ageSecret) : null;
  if (!agePayload || !agePayload.verified) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error: `Age verification required. Please confirm you are ${MIN_AGE} or older before requesting a seat.`
      })
    };
  }

  // --- Validate: name ---
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Missing or invalid field: name' })
    };
  }

  // --- Validate: email ---
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || typeof email !== 'string' || !emailRegex.test(email.trim())) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Missing or invalid field: email' })
    };
  }

  // --- Resolve env vars ---
  const apiKey = process.env.SENDGRID_API_KEY;
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    console.error('[seat-request] SENDGRID_API_KEY is not set');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Server configuration error' })
    };
  }

  const fromEmail   = process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const platformUrl = process.env.PLATFORM_URL        || 'https://www.thispagedoesnotexist12345.com';
  const signalUrl   = process.env.SIGNAL_URL          || 'https://newsletter.thispagedoesnotexist12345.us';
  const passportBase = process.env.PASSPORT_URL       || 'https://www.thispagedoesnotexist12345.com';
  const beehiivKey  = process.env.BEEHIIV_API_KEY;
  const beehiivPub  = process.env.BEEHIIV_PUB_ID || BEEHIIV_PUB_ID_DEFAULT;

  // --- Normalise inputs ---
  const nameTrimmed  = name.trim();
  const emailTrimmed = email.trim().toLowerCase();
  const nameParts    = nameTrimmed.split(/\s+/);
  const firstName    = nameParts[0] || nameTrimmed;
  const requestDate  = new Date().toISOString();
  const sourceValue   = (source && typeof source === 'string' ? source.trim() : 'Website');
  const resolvedTier  = (tier && typeof tier === 'string' ? tier.trim() : 'Alpha (Founding)');
  const resolvedCabinTier = (cabin_tier && typeof cabin_tier === 'string' ? cabin_tier.trim() : 'Alpha (Founding)');
  const formattedAmountPaid = (amount_paid !== undefined && amount_paid !== null ? amount_paid : '$0.00');

  // --- F143: Cohort capacity check — divert to waitlist if seats_available === false ---
  // Fires next_flight_waitlist_v1 email + applies Beehiiv 'waitlist' tag.
  // Non-fatal: if /api/seat-status is unavailable, falls through to normal flow.
  try {
    const seatStatusUrl = (process.env.PLATFORM_URL || 'https://www.thispagedoesnotexist12345.com') + '/api/seat-status';
    const statusRes = await fetch(seatStatusUrl);
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData.seats_available === false) {
        console.log(`[seat-request] Cohort full — diverting ${emailTrimmed} to waitlist (F143)`);
        const wlFirstName = nameTrimmed.split(/\s+/)[0] || nameTrimmed;
        const wlPlatformUrl = (process.env.PLATFORM_URL || 'https://www.thispagedoesnotexist12345.com') + '/ResumeFitCheck';
        const waitlistTemplateId = TEMPLATES.next_flight_waitlist_v1;
        // Send next_flight_waitlist_v1 email (with BCC per universal BCC rule)
        try {
          const wlRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: { email: fromEmail },
              personalizations: [{
                to:  [{ email: emailTrimmed }],
                bcc: [{ email: BCC_EMAIL }],
                dynamic_template_data: { first_name: wlFirstName, platform_url: wlPlatformUrl }
              }],
              template_id: waitlistTemplateId,
              asm: { group_id: ASM_GROUP_ID, groups_to_display: ASM_GROUPS_TO_DISPLAY }
            })
          });
          console.log(`[seat-request] next_flight_waitlist_v1 ${wlRes.ok || wlRes.status === 202 ? 'sent' : 'failed (' + wlRes.status + ')'} to ${emailTrimmed}`);
        } catch (wlErr) {
          console.error('[seat-request] Waitlist email error:', wlErr.message);
        }
        // Subscribe to beehiiv + apply 'waitlist' tag (F143 §4)
        // subscribeToBeehiiv returns the sub_id; applyBeehiivWaitlistTag uses it to call the Tags API.
        if (beehiivKey) {
          const wlSubId = await subscribeToBeehiiv(emailTrimmed, wlFirstName, beehiivKey, beehiivPub);
          await applyBeehiivWaitlistTag(wlSubId, beehiivKey, beehiivPub);
        }
        // F143 §5 — Idempotency marker: write waitlist_email_sent_at to Supabase
        // Prevents duplicate next_flight_waitlist_v1 sends on retry or re-submission.
        const supabaseUrlWl = process.env.SUPABASE_URL;
        const supabaseKeyWl = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supabaseUrlWl && supabaseKeyWl) {
          try {
            const wlSentAt = new Date().toISOString();
            // Upsert by email — creates or updates the waitlist record with the sent timestamp.
            await fetch(`${supabaseUrlWl}/rest/v1/waitlist_submissions`, {
              method: 'POST',
              headers: {
                apikey:         supabaseKeyWl,
                Authorization:  `Bearer ${supabaseKeyWl}`,
                'Content-Type': 'application/json',
                Prefer:         'resolution=merge-duplicates,return=minimal'
              },
              body: JSON.stringify({
                email:                  emailTrimmed.toLowerCase(),
                first_name:             wlFirstName || null,
                status:                 'waitlisted',
                waitlist_email_sent_at: wlSentAt,
                source:                 sourceValue || 'landing'
              })
            });
            console.log(`[seat-request] F143 idempotency marker written for ${emailTrimmed} at ${wlSentAt}`);
          } catch (wlSbErr) {
            console.error('[seat-request] F143 Supabase idempotency marker write failed (non-blocking):', wlSbErr.message);
          }
        }
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ ok: true, waitlisted: true, status: 'waitlisted', message: "You're on the next flight. Check your inbox for details." })
        };
      }
    }
  } catch (capacityErr) {
    console.warn('[seat-request] Capacity check unavailable (F143 — fail open):', capacityErr.message);
  }

  // --- Deduplicate: one seat request per email (Gate Contract §2e) ---
  // Query the Notion Seat Request Registry before generating a new seat_id.
  // If the email already has a record, return 409 with the existing seat_id.
  // Fails gracefully: if Notion is unavailable, proceed normally.
  const existingSeatId = await checkExistingRequest({
    email: emailTrimmed,
    notionApiKey,
    databaseId: NOTION_SEAT_REQUEST_DATABASE_ID
  });
  if (existingSeatId) {
    console.log(`[seat-request] Rejecting duplicate request for ${emailTrimmed}`);
    const resolvedExisting = existingSeatId === '__duplicate__' ? null : existingSeatId;
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({
        ok: false,
        duplicate: true,
        error: 'A seat request has already been submitted for this email address. Check your inbox for your original confirmation.',
        ...(resolvedExisting ? { seat_id: resolvedExisting } : {})
      })
    };
  }

  // --- Generate seat_id (Gate Contract §3) ---
  // seat_id_override: allows pre-assigned Alpha cohort passengers to submit with
  // their canonical ID (e.g. TUJ-KC2222) instead of a randomly generated one.
  // Validation: must match /^TUJ-[A-Z0-9]{4,}$/ — same regex as handleSeatOpened.
  // If override is invalid, fall back to generateSeatId() silently.
  const SEAT_ID_OVERRIDE_REGEX = /^TUJ-[A-Z0-9]{4,}$/;
  let seatId;
  if (seat_id_override && typeof seat_id_override === 'string' && SEAT_ID_OVERRIDE_REGEX.test(seat_id_override.trim().toUpperCase())) {
    seatId = seat_id_override.trim().toUpperCase();
    console.log(`[seat-request] Using seat_id_override ${seatId} for ${emailTrimmed}`);
  } else {
    seatId = generateSeatId();
    console.log(`[seat-request] Generated seat_id ${seatId} for ${emailTrimmed}`);
  }

  // --- Build passport URL with seat_id pre-filled (Gate Contract §4 — email handoff) ---
  // Fix 3b (Apr 5, 2026): encodeURIComponent removed per canonical spec.
  // seat_id chars (A-Z, 2-9, hyphen) are URL-safe — no encoding needed or wanted.
  // Canonical form: https://www.thispagedoesnotexist12345.com/?seat_id=TUJ-XXXXXX
  // P2 Fix (Apr 19, 2026): tuj_code appended so the acknowledgement email CTA also carries both params.
  const passportUrl = `${passportBase}?seat_id=${seatId}&tuj_code=${seatId}`;

  // Bug-003 fix: pass values without the leading-space pad so the SendGrid template
  // can render "Name: Kevin" style rows without label/value collision.
  // first_name uses the full nameTrimmed so {{first_name}} resolves as "Jo Ann", not "Jo".
  const internalDynamicTemplateData = {
    name:         nameTrimmed,
    first_name:   nameTrimmed,
    email:        emailTrimmed,
    seat_id:      seatId,
    tier:         resolvedTier,
    cabin_tier:   resolvedCabinTier,
    signup_date:  requestDate,
    passport_url: passportUrl,
    source:       sourceValue,
    amount_paid:  formattedAmountPaid
  };

  // --- Send user acknowledgement via SendGrid ---
  // Canon token alignment (Apr 19, 2026): flight_code is canonical across all boarding templates.
  // flight_id is aliased to the same value for backward-compat with seat_request_acknowledgement_v1
  // which was built against {{flight_id}}. Both tokens resolve to the same string.
  const activeFlightCode = process.env.ACTIVE_FLIGHT_CODE || ACTIVE_FLIGHT_CODE_DEFAULT;
  const dynamicTemplateData = {
    subject:      SUBJECT_TEMPLATE(activeFlightCode),
    first_name:   firstName,
    full_name:    nameTrimmed,
    email:        emailTrimmed,
    seat_id:      seatId,
    tuj_code:     seatId,          // alias: same value as seat_id for templates that use {{tuj_code}}
    source:       sourceValue,
    platform_url: platformUrl,
    signal_url:   signalUrl,
    passport_url: passportUrl,     // https://www.thispagedoesnotexist12345.com?seat_id=TUJ-XXXXXX&tuj_code=TUJ-XXXXXX
    request_date: requestDate,
    flight_code:  activeFlightCode,  // canonical token used by all boarding templates
    flight_id:    activeFlightCode   // alias: seat_request_acknowledgement_v1 uses {{flight_id}}
  };

  // correlation_id: no flight_id or passenger_id at this stage — use seat_id as request anchor
  const correlationId = `req_${seatId}`;
  // subject is now dynamic — update the SendGrid personalizations subject to match
  // (SendGrid dynamic templates can override subject via personalizations.dynamic_template_data.subject)

  try {
    const t0_ack = Date.now();
    const sgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { email: fromEmail },
        subject: SUBJECT,
        personalizations: [{
          to: [{ email: emailTrimmed }],
          dynamic_template_data: dynamicTemplateData
        }],
        template_id: TEMPLATE_ID,
        asm: { group_id: ASM_GROUP_ID, groups_to_display: ASM_GROUPS_TO_DISPLAY }
      })
    });

    const ackStatus = sgResponse.status;
    const ackOk = sgResponse.ok || ackStatus === 202;
    sgLog({ correlation_id: correlationId, request_id: seatId, template_key: 'seat_request_acknowledgement_v1', sendgrid_template_id: TEMPLATE_ID, status: ackStatus, elapsed_ms: Date.now() - t0_ack, ok: ackOk, attempt: 1 });
    if (ackOk) {
      console.log(`[seat-request] Acknowledgement sent to ${emailTrimmed} with seat_id ${seatId}`);
    } else {
      const errorText = await sgResponse.text();
      console.error(`[seat-request] SendGrid error ${ackStatus}: ${errorText}`);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          ok: false,
          error: 'Failed to send acknowledgement email',
          details: errorText
        })
      };
    }
  } catch (err) {
    sgLog({ correlation_id: correlationId, request_id: seatId, template_key: 'seat_request_acknowledgement_v1', sendgrid_template_id: TEMPLATE_ID, ok: false, elapsed_ms: 0, error_name: err?.name, error_message: err?.message, status: err?.code || err?.response?.statusCode });
    console.error('[seat-request] Unexpected error during SendGrid call:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Internal server error' })
    };
  }

  // --- Supabase upsert: waitlist_submissions (BLOCKER-04) ---
  // Persists the seat request to Supabase as the canonical waitlist store.
  // Fails gracefully — a Supabase outage must not block the SendGrid ack.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseKey) {
    try {
      // Generate a stable referral_code for this record (8 chars, same charset as seat_id)
      const refCodeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const refCodeArr = new Uint8Array(8);
      crypto.getRandomValues(refCodeArr);
      const newReferralCode = Array.from(refCodeArr).map(b => refCodeChars[b % refCodeChars.length]).join('');
      const upsertPayload = {
        email:         emailTrimmed.toLowerCase(),
        first_name:    firstName || null,
        seat_id:       seatId,
        source:        sourceValue || 'landing',
        referral_code: newReferralCode,
        status:        'pending',
        age_verified:  true
      };
      // If passenger arrived via a referral link, resolve the referring record's id
      if (inboundReferralCode && typeof inboundReferralCode === 'string') {
        try {
          const refLookup = await fetch(
            `${supabaseUrl}/rest/v1/waitlist_submissions?referral_code=eq.${encodeURIComponent(inboundReferralCode.trim())}&select=id&limit=1`,
            { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
          );
          const refRows = await refLookup.json();
          if (Array.isArray(refRows) && refRows[0]?.id) {
            upsertPayload.referred_by = refRows[0].id;
          }
        } catch (refErr) {
          console.warn('[seat-request] Referral lookup failed (non-blocking):', refErr.message);
        }
      }
      const sbRes = await fetch(
        `${supabaseUrl}/rest/v1/waitlist_submissions`,
        {
          method: 'POST',
          headers: {
            apikey:         supabaseKey,
            Authorization:  `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer:         'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify(upsertPayload)
        }
      );
      if (sbRes.ok || sbRes.status === 201) {
        console.log(`[seat-request] Supabase waitlist upsert succeeded for ${emailTrimmed}`);
      } else {
        const sbErr = await sbRes.text();
        console.error(`[seat-request] Supabase waitlist upsert failed ${sbRes.status}: ${sbErr}`);
      }
    } catch (sbErr) {
      console.error('[seat-request] Supabase upsert unexpected error (non-blocking):', sbErr.message);
    }
  } else {
    console.warn('[seat-request] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping Supabase waitlist upsert');
  }

  // --- Notion log: Seat Request Registry ---
  try {
    await logSeatRequestToNotion({
      seatId,
      name: nameTrimmed,
      email: emailTrimmed,
      requestDate,
      source: sourceValue,
      notionApiKey,
      databaseId: NOTION_SEAT_REQUEST_DATABASE_ID
    });
  } catch (err) {
    console.error('[seat-request] Notion log write failed:', err);
  }

  // --- Subscribe to beehiiv Signal newsletter (Gate Contract §2d) ---
  if (beehiivKey) {
    await subscribeToBeehiiv(emailTrimmed, firstName, beehiivKey, beehiivPub);
  } else {
    console.warn('[seat-request] BEEHIIV_API_KEY not set — skipping Signal auto-subscribe');
  }

  // --- Write to Base44 seat store (stub — wires in when credits return) ---
  const base44Url = process.env.BASE44_SEAT_REQUEST_URL;
  if (!base44Url) {
    console.warn('[seat-request] BASE44_SEAT_REQUEST_URL not set — skipping Base44 write (stub active)');
    // Base44 is blocked; proceed without it. seat_id is still returned to client.
  } else {
    try {
      const base44Response = await fetch(base44Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:    nameTrimmed,
          email:   emailTrimmed,
          seat_id: seatId,
          source:  (source && typeof source === 'string' ? source.trim() : 'Website')
        })
      });

      if (!base44Response.ok) {
        const errorText = await base44Response.text();
        console.error(`[seat-request] Base44 write failed ${base44Response.status}:`, errorText);
        // Do not block — seat_id already issued and SendGrid sent. Log for manual reconciliation.
      } else {
        console.log(`[seat-request] Base44 write succeeded for ${emailTrimmed} seat_id ${seatId}`);
      }
    } catch (err) {
      console.error('[seat-request] Unexpected error during Base44 call:', err);
      // Do not block — log for manual reconciliation.
    }
  }

  // --- Send internal signup notification via SendGrid ---
  try {
    const t0_int = Date.now();
    const internalSgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { email: fromEmail },
        personalizations: [{
          to: [{ email: INTERNAL_NOTIFY_EMAIL }],
          dynamic_template_data: internalDynamicTemplateData
        }],
        template_id: INTERNAL_TEMPLATE_ID,
        asm: { group_id: ASM_GROUP_ID, groups_to_display: ASM_GROUPS_TO_DISPLAY }
      })
    });

    const intStatus = internalSgResponse.status;
    const intOk = internalSgResponse.ok || intStatus === 202;
    sgLog({ correlation_id: correlationId, request_id: seatId, template_key: 'internalsignupnotification_v1', sendgrid_template_id: INTERNAL_TEMPLATE_ID, status: intStatus, elapsed_ms: Date.now() - t0_int, ok: intOk, attempt: 1 });
    if (intOk) {
      console.log(`[seat-request] Internal notification sent to ${INTERNAL_NOTIFY_EMAIL} for ${emailTrimmed}`);
    } else {
      const errorText = await internalSgResponse.text();
      // Log but do not fail — user ack already succeeded
      console.error(`[seat-request] Internal notification SendGrid error ${intStatus}:`, errorText);
    }
  } catch (err) {
    // Log but do not fail
    sgLog({ correlation_id: correlationId, request_id: seatId, template_key: 'internalsignupnotification_v1', sendgrid_template_id: INTERNAL_TEMPLATE_ID, ok: false, elapsed_ms: 0, error_name: err?.name, error_message: err?.message, status: err?.code || err?.response?.statusCode });
    console.error('[seat-request] Unexpected error during internal notification SendGrid call:', err);
  }

  // --- Return seat_id to client (Gate Contract §2c) ---
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok:      true,
      seat_id: seatId,
      status:  'confirmed',
      email:   emailTrimmed,
      name:    nameTrimmed
    })
  };
};
