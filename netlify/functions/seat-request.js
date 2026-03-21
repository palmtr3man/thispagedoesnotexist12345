/**
 * #118 — /api/seat-request Netlify Function
 *
 * Server-side POST handler for the seat request form.
 * Validates name + email, then sends the seat_request_acknowledgement_v1
 * SendGrid dynamic template (d-740595dc07be40129569bc731f1bc454) to the requester.
 * After the SendGrid call, POSTs the seat data to Base44 so the count increments.
 *
 * Required Netlify env vars:
 *   SENDGRID_API_KEY      — SendGrid API key (required)
 *   SENDGRID_FROM_EMAIL   — Sender address (default: noreply@thispagedoesnotexist12345.com)
 *   PLATFORM_URL          — Platform URL injected into email (default: https://thispagedoesnotexist12345.tech)
 *   SIGNAL_URL            — Signal newsletter URL injected into email (default: Perplexity TUJ departure portal)
 *   BASE44_SEAT_REQUEST_URL — Base44 endpoint for seat-request writes (required for count)
 *
 * Request body (JSON):
 *   { name: string, email: string, source?: string }
 *
 * Success response:
 *   { ok: true }
 *
 * Error response:
 *   { ok: false, error: string }
 *
 * Closes Ambiguity 2 (Go/No-Go Contract) → feeds FL 032126 Go/No-Go gate.
 */

const TEMPLATE_ID  = 'd-740595dc07be40129569bc731f1bc454'; // seat_request_acknowledgement_v1
const ASM_GROUP_ID = 33047; // "The Ultimate Journey — Transactional" unsubscribe group
const SUBJECT      = 'Your seat request is in — FL 032126 ✈️';

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

  const { name, email, source } = body;

  // --- Validate required fields ---
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'Missing or invalid field: name' })
    };
  }

  const emailRegex = new RegExp('^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$');
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

  const fromEmail =
    process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const platformUrl =
    process.env.PLATFORM_URL || 'https://thispagedoesnotexist12345.tech';
  const signalUrl =
    process.env.SIGNAL_URL || 'https://www.perplexity.ai/computer/a/pageforward-airways-tuj-depart-.RTLHPm.Q5uzAOjQLvBhWA';

  // --- Build dynamic template data ---
  const nameTrimmed = name.trim();
  const emailTrimmed = email.trim().toLowerCase();
  const nameParts = nameTrimmed.split(new RegExp('\\s+'));
  const firstName = nameParts[0] || nameTrimmed;
  const requestDate = new Date().toISOString();

  const dynamicTemplateData = {
    subject: SUBJECT,
    first_name: firstName,
    full_name: nameTrimmed,
    email: emailTrimmed,
    source: (source && typeof source === 'string' ? source.trim() : 'Website'),
    platform_url: platformUrl,
    signal_url: signalUrl,
    request_date: requestDate
  };

  // --- Send via SendGrid ---
  let sgOk = false;
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
      console.log(`[seat-request] Acknowledgement sent to ${emailTrimmed}`);
      sgOk = true;
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

  // --- Write to Base44 (seat count increment) ---
  const base44Url = process.env.BASE44_SEAT_REQUEST_URL;
  if (!base44Url) {
    console.warn('[seat-request] BASE44_SEAT_REQUEST_URL is not set — skipping Base44 write');
    // SendGrid succeeded; return ok so the user experience is not broken,
    // but log the gap so the team can action the missing env var.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true })
    };
  }

  try {
    const base44Response = await fetch(base44Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nameTrimmed,
        email: emailTrimmed,
        source: (source && typeof source === 'string' ? source.trim() : 'Website')
      })
    });

    if (!base44Response.ok) {
      const errorText = await base44Response.text();
      console.error(`[seat-request] Base44 write failed ${base44Response.status}:`, errorText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ ok: false, error: 'Base44 write failed — seat count not incremented' })
      };
    }

    console.log(`[seat-request] Base44 write succeeded for ${emailTrimmed}`);
  } catch (err) {
    console.error('[seat-request] Unexpected error during Base44 call:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Internal server error during Base44 write' })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true })
  };
};
