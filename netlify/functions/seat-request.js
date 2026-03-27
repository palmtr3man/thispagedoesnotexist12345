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
 *   SENDGRID_API_KEY         — SendGrid API key
 *   SENDGRID_FROM_EMAIL      — Sender address (default: noreply@thispagedoesnotexist12345.com)
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

// --- SendGrid template IDs ---
const TEMPLATE_ID          = 'd-740595dc07be401295 69bc731f1bc454'; // seat_request_acknowledgement_v1
const INTERNAL_TEMPLATE_ID = 'd-073dc68a683348f18133d78c9879ced8'; // internalsignupnotification_v1
const INTERNAL_NOTIFY_EMAIL = 'support@theultimatejourney.app';
const ASM_GROUP_ID = 33047; // "The Ultimate Journey — Transactional" unsubscribe group
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
  const beehiivKey  = process.env.BEEHIIV_API_KEY;
  const beehiivPub  = process.env.BEEHIIV_PUB_ID || BEEHIIV_PUB_ID_DEFAULT;

  // --- Normalise inputs ---
  const nameTrimmed  = name.trim();
  const emailTrimmed = email.trim().toLowerCase();
  const nameParts    = nameTrimmed.split(/\s+/);
  const firstName    = nameParts[0] || nameTrimmed;
  const requestDate  = new Date().toISOString();

  // --- Generate seat_id (Gate Contract §3) ---
  const seatId = generateSeatId();
  console.log(`[seat-request] Generated seat_id ${seatId} for ${emailTrimmed}`);

  // --- Send user acknowledgement via SendGrid ---
  const dynamicTemplateData = {
    subject:      SUBJECT,
    first_name:   firstName,
    full_name:    nameTrimmed,
    email:        emailTrimmed,
    seat_id:      seatId,
    source:       (source && typeof source === 'string' ? source.trim() : 'Website'),
    platform_url: platformUrl,
    signal_url:   signalUrl,
    request_date: requestDate
  };

  try {
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

    if (sgResponse.ok || sgResponse.status === 202) {
      console.log(`[seat-request] Acknowledgement sent to ${emailTrimmed} with seat_id ${seatId}`);
    } else {
      const errorText = await sgResponse.text();
      console.error(`[seat-request] SendGrid error ${sgResponse.status}:`, errorText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ ok: false, error: 'Failed to send acknowledgement email' })
      };
    }
  } catch (err) {
    console.error('[seat-request] Unexpected error during SendGrid call:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Internal server error' })
    };
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
          dynamic_template_data: {
            name:         nameTrimmed,
            email:        'Email: ' + emailTrimmed,
            seat_id:      seatId,
            tier:         (tier && typeof tier === 'string' ? tier.trim() : 'Alpha (Founding)'),
            cabin_tier:   (cabin_tier && typeof cabin_tier === 'string' ? cabin_tier.trim() : 'Alpha (Founding)'),
            signup_date:  requestDate,
            amount_paid:  (amount_paid !== undefined && amount_paid !== null ? amount_paid : '$0.00')
          }
        }],
        template_id: INTERNAL_TEMPLATE_ID
      })
    });

    if (internalSgResponse.ok || internalSgResponse.status === 202) {
      console.log(`[seat-request] Internal notification sent to ${INTERNAL_NOTIFY_EMAIL} for ${emailTrimmed}`);
    } else {
      const errorText = await internalSgResponse.text();
      // Log but do not fail — user ack already succeeded
      console.error(`[seat-request] Internal notification SendGrid error ${internalSgResponse.status}:`, errorText);
    }
  } catch (err) {
    // Log but do not fail
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
