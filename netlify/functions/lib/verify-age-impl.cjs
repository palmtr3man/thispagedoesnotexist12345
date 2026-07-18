/**
 * /api/verify-age — Netlify Function (Gate Contract 4-P2)
 * The Ultimate Journey · .com
 *
 * Accepts a DOB, validates the passenger is GATE.MIN_AGE (21) or older,
 * and on success issues a signed age_token (HMAC-SHA256 JWT-style token)
 * that the .tech OnboardingPassport reads from sessionStorage to skip
 * DOB re-entry within the same browser session.
 *
 * Security rules (Gate Contract §5):
 *   - DOB is NEVER echoed back in any response body
 *   - DOB is NEVER logged
 *   - Token contains only: { verified: true, min_age: 21, iat, exp }
 *   - Token expires in 24 hours (session-length safety margin)
 *   - Token is signed with AGE_TOKEN_SECRET (Netlify env var)
 *
 * Required Netlify env vars:
 *   AGE_TOKEN_SECRET — random 32+ char secret for HMAC signing
 *
 * Request body (JSON):
 *   { date_of_birth: 'YYYY-MM-DD' }
 *
 * Success response (200):
 *   { ok: true, age_token: '<signed-token>' }
 *
 * Failure response (400 / 422):
 *   { ok: false, passed: false, reason: string }
 *
 * Gate Contract 4-P2 · March 29, 2026
 */

const crypto = require('crypto');

const MIN_AGE         = 21;
const TOKEN_TTL_SECS  = 86400; // 24 hours
const FUNCTION_NAME   = 'verify-age';

/**
 * Compute age in full years from a YYYY-MM-DD string.
 */
function computeAge(dobStr) {
  const today = new Date();
  const birth = new Date(dobStr);
  if (isNaN(birth.getTime())) return null;
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

/**
 * Build a minimal signed token: base64url(header).base64url(payload).signature
 * Uses HMAC-SHA256 — not a full JWT library, but compatible with the
 * same verification pattern on the .tech side.
 */
function buildAgeToken(secret) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'AGE' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    verified: true,
    min_age:  MIN_AGE,
    iat:      now,
    exp:      now + TOKEN_TTL_SECS
  })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/**
 * Verify a token string — returns the payload if valid, null if invalid/expired.
 */
function verifyAgeToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return data;
  } catch {
    return null;
  }
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, reason: 'Method not allowed' })
    };
  }

  const secret = process.env.AGE_TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    console.error(`[${FUNCTION_NAME}] AGE_TOKEN_SECRET is not configured`);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, reason: 'Server configuration error' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, passed: false, reason: 'Invalid request body' })
    };
  }

  const dob = body.date_of_birth;

  // Validate DOB format (YYYY-MM-DD) without logging the value
  if (!dob || typeof dob !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, passed: false, reason: 'A valid date of birth is required.' })
    };
  }

  const age = computeAge(dob);

  if (age === null) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({ ok: false, passed: false, reason: 'Could not parse date of birth.' })
    };
  }

  if (age < MIN_AGE) {
    // Do NOT log the DOB or the age — just the outcome
    console.log(`[${FUNCTION_NAME}] age_gate=failed`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok:     false,
        passed: false,
        reason: `You must be ${MIN_AGE} or older to use The Ultimate Journey.`
      })
    };
  }

  // Age verified — issue signed token
  const age_token = buildAgeToken(secret);
  console.log(`[${FUNCTION_NAME}] age_gate=passed token_issued=true`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, passed: true, age_token })
  };
};

// Export verifyAgeToken for use in other Netlify functions (e.g., seat-request)
exports.verifyAgeToken = verifyAgeToken;
