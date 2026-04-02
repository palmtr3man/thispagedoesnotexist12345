/**
 * /api/seat-request — Netlify Function (Gate Contract v2)
 *
 * Upgrades over v1:
 *   1. Validates age_confirmed field (rejects if false or missing)
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
 *   { name: string, email: string, age_confirmed: boolean, source?: string, tier?: string, cabin_tier?: string, amount_paid?: number }
 *
 * Success response:
 *   { ok: true, seat_id: 'TUJ-XXXXXX', status: 'confirmed' }
 *
 * Error response:
 *   { ok: false, error: string }
 *
 * Gate Contract v2 — seat_id bridge + beehiiv auto-subscribe
 */

const { TEMPLATES, assertTemplates } = require('./sendgrid-templates');

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
assertTemplates(['seat_request_acknowledgement_v1', 'internalsignupnotification_v1']);
const TEMPLATE_ID = TEMPLATES.seat_request_acknowledgement_v1;
const INTERNAL_TEMPLATE_ID = TEMPLATES.internalsignupnotification_v1;
const INTERNAL_NOTIFY_EMAIL = 'support@theultimatejourney.app';
const ASM_GROUP_ID = parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL || '33047', 10); // "The Ultimate Journey — Transactional" unsubscribe group
const NOTION_API_VERSION = '2022-06-28';
const NOTION_SEAT_REQUEST_DATABASE_ID = process.env.NOTION_SEAT_REQUEST_DATABASE_ID || '5e6440af0ad94c6d89a8442ec2c528f3';
const SUBJECT      = 'Your seat request is in — FL 032126 ✈️';

// --- Gate Contract constants ---
const SEAT_ID_PREFIX = 'TUJ-';
const SEAT_ID_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const SEAT_ID_LENGTH = 6;
const MIN_AGE        = 21;

// --- beehiiv defaults ---
const BEEHIIV_PUB_ID_DEFAULT = 'pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf';

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
        filter: {
          property: 'Email',
          email: { equals: email }
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
        utm_campaign: 'fl032126-gate',
        custom_fields: [
          { name: 'first_name', value: firstName }
        ]
      })
    });

    if (res.ok || res.status === 201 || res.status === 200) {
      const data = await res.json().catch(() => ({}));
      console.log(`[seat-request] beehiiv subscribe OK for ${email}`, data?.data?.id || '');
      return true;
    } else {
      const errText = await res.text();
      console.error(`[seat-request] beehiiv subscribe error ${res.status}:`, errText);
      return false;
    }
  } catch (err) {
    console.error('[seat-request] beehiiv subscribe unexpected error:', err);
    return false;
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

  const { name, email, age_confirmed, source, tier, cabin_tier, amount_paid } = body;

  // --- Validate: age_confirmed (Gate Contract §2a / §5) ---
  if (age_confirmed !== true) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error: `Age verification required. You must confirm you are ${MIN_AGE} or older to request a seat.`
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
  const seatId = generateSeatId();
  console.log(`[seat-request] Generated seat_id ${seatId} for ${emailTrimmed}`);

  // --- Build passport URL with seat_id pre-filled (Gate Contract §4 — email handoff) ---
  // seat_id chars are URL-safe (A-Z, 2-9, hyphen) — no additional encoding needed,
  // but encodeURIComponent is used defensively in case the format ever changes.
  const passportUrl = `${passportBase}?seat_id=${encodeURIComponent(seatId)}`;

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
  const dynamicTemplateData = {
    subject:      SUBJECT,
    first_name:   firstName,
    full_name:    nameTrimmed,
    email:        emailTrimmed,
    seat_id:      seatId,
    source:       sourceValue,
    platform_url: platformUrl,
    signal_url:   signalUrl,
    passport_url: passportUrl,   // https://www.thispagedoesnotexist12345.com?seat_id=TUJ-XXXXXX
    request_date: requestDate
  };

  // correlation_id: no flight_id or passenger_id at this stage — use seat_id as request anchor
  const correlationId = `req_${seatId}`;

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
        asm: { group_id: ASM_GROUP_ID }
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
        template_id: INTERNAL_TEMPLATE_ID
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
