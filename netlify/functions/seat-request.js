/**
 * #118 — /api/seat-request Netlify Function
 *
 * Server-side POST handler for the seat request form.
 * Validates name + email, then sends the seat_request_acknowledgement_v1
 * SendGrid dynamic template (d-740595dc07be40129569bc731f1bc454) to the requester.
 *
 * Required Netlify env vars:
 *   SENDGRID_API_KEY      — SendGrid API key (required)
 *   SENDGRID_FROM_EMAIL   — Sender address (default: noreply@thispagedoesnotexist12345.com)
 *   PLATFORM_URL          — Platform URL injected into email (default: https://thispagedoesnotexist12345.tech)
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

  const fromEmail =
    process.env.SENDGRID_FROM_EMAIL || 'noreply@thispagedoesnotexist12345.com';
  const platformUrl =
    process.env.PLATFORM_URL || 'https://thispagedoesnotexist12345.tech';

  // --- Build dynamic template data ---
  const nameTrimmed = name.trim();
  const emailTrimmed = email.trim().toLowerCase();
  const nameParts = nameTrimmed.split(/\s+/);
  const firstName = nameParts[0] || nameTrimmed;
  const requestDate = new Date().toISOString();

  const dynamicTemplateData = {
    first_name: firstName,
    full_name: nameTrimmed,
    email: emailTrimmed,
    source: (source && typeof source === 'string' ? source.trim() : 'Website'),
    platform_url: platformUrl,
    request_date: requestDate
  };

  // --- Send via SendGrid ---
  try {
    const sgResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { email: fromEmail },
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
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true })
      };
    }

    const errorText = await sgResponse.text();
    console.error(`[seat-request] SendGrid error ${sgResponse.status}:`, errorText);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ ok: false, error: 'Failed to send acknowledgement email' })
    };
  } catch (err) {
    console.error('[seat-request] Unexpected error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Internal server error' })
    };
  }
};
