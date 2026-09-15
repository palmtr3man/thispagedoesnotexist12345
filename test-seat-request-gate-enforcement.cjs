'use strict';

/**
 * Server-side gate enforcement smoke tests for netlify/functions/seat-request.js.
 *
 * Covers:
 *   - missing Bearer token → 401 AUTH_REQUIRED
 *   - invalid Bearer token → 401 INVALID_TOKEN
 *   - valid token, unverified profile → 403 ME_PROFILE_NOT_VERIFIED, no Base44 call
 *   - valid token, verified via me_profile_status === 'verified' → forwards to Base44
 *   - valid token, verified via passport_completed_at → forwards to Base44
 *
 * Run with: node test-seat-request-gate-enforcement.cjs
 */

const assert = require('assert');
const { handler } = require('./netlify/functions/seat-request.js');

const SUPABASE_URL = 'https://gate-test.supabase.co';
const AUTH_USER_ID = 'auth-user-123';
const VALID_TOKEN = 'valid-access-token';
const INVALID_TOKEN = 'invalid-access-token';
const BASE44_URL = 'https://base44.example/functions/seatRequest';

process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.BASE44_SEAT_REQUEST_URL = BASE44_URL;
delete process.env.PROFILE_TABLE;
delete process.env.MAINTENANCE_MODE;

let fetchCalls = [];
let profileRecord = null;
let base44Response = { ok: true, status: 200, payload: { ok: true } };

global.fetch = async (url, options = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, options });

  if (u.includes('/auth/v1/user')) {
    const auth = (options.headers && options.headers.Authorization) || '';
    if (auth === `Bearer ${VALID_TOKEN}`) {
      return { ok: true, status: 200, json: async () => ({ id: AUTH_USER_ID, email: 'passenger@example.com' }) };
    }
    return { ok: false, status: 401, json: async () => ({ message: 'invalid token' }) };
  }

  if (u.includes('/rest/v1/profiles')) {
    return { ok: true, status: 200, json: async () => (profileRecord ? [profileRecord] : []) };
  }

  if (u.startsWith(BASE44_URL)) {
    return { ok: base44Response.ok, status: base44Response.status, json: async () => base44Response.payload };
  }

  throw new Error(`Unexpected fetch URL: ${u}`);
};

function event({ headers = {}, body = {} } = {}) {
  return {
    httpMethod: 'POST',
    headers,
    body: JSON.stringify(body),
  };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function run() {
  // 1. Missing token → 401 AUTH_REQUIRED, no Supabase/Base44 calls at all.
  {
    fetchCalls = [];
    const res = await handler(event({ headers: {} }));
    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body, { ok: false, error: 'Authorization is required', code: 'AUTH_REQUIRED' });
    assert.strictEqual(fetchCalls.length, 0, 'must not call Supabase or Base44 before a token is present');
  }

  // 2. Invalid/expired token → 401 INVALID_TOKEN, Base44 never called.
  {
    fetchCalls = [];
    const res = await handler(event({ headers: bearer(INVALID_TOKEN) }));
    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body, { ok: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    assert.ok(!fetchCalls.some((c) => c.url.startsWith(BASE44_URL)), 'invalid token must never reach Base44');
  }

  // 3. Valid token, unverified profile → 403 ME_PROFILE_NOT_VERIFIED, no Base44 call.
  {
    fetchCalls = [];
    profileRecord = { id: AUTH_USER_ID, me_profile_status: 'pending' };
    const res = await handler(event({
      headers: bearer(VALID_TOKEN),
      body: { tuj_code: 'TUJ-AB2222' },
    }));
    assert.strictEqual(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body, { ok: false, error: 'Verified profile required', code: 'ME_PROFILE_NOT_VERIFIED' });
    assert.ok(!fetchCalls.some((c) => c.url.startsWith(BASE44_URL)), 'unverified profile must never reach Base44');
  }

  // 4. Valid token, verified via me_profile_status === 'verified' → forwards to Base44,
  //    with user_id always set to the authenticated user's id (never the client body).
  {
    fetchCalls = [];
    profileRecord = { id: AUTH_USER_ID, me_profile_status: 'verified' };
    base44Response = { ok: true, status: 200, payload: { seat_id: 'TUJ-AB2222' } };
    const res = await handler(event({
      headers: bearer(VALID_TOKEN),
      body: { tuj_code: 'TUJ-AB2222', user_id: 'client-supplied-should-be-ignored' },
    }));
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.seat_id, 'TUJ-AB2222');
    const base44Call = fetchCalls.find((c) => c.url.startsWith(BASE44_URL));
    assert.ok(base44Call, 'expected a forwarded Base44 call');
    const forwardedBody = JSON.parse(base44Call.options.body);
    assert.strictEqual(forwardedBody.user_id, AUTH_USER_ID);
    assert.strictEqual(forwardedBody.tuj_code, 'TUJ-AB2222');
  }

  // 5. Valid token, verified via passport_completed_at (me_profile_status not 'verified')
  //    → forwards to Base44 with the authenticated user id.
  {
    fetchCalls = [];
    profileRecord = { id: AUTH_USER_ID, me_profile_status: 'pending', passport_completed_at: '2026-01-01T00:00:00Z' };
    base44Response = { ok: true, status: 200, payload: { seat_id: 'TUJ-CD3333' } };
    const res = await handler(event({
      headers: bearer(VALID_TOKEN),
      body: { tuj_code: 'TUJ-CD3333' },
    }));
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.seat_id, 'TUJ-CD3333');
    const base44Call = fetchCalls.find((c) => c.url.startsWith(BASE44_URL));
    assert.ok(base44Call, 'expected a forwarded Base44 call');
    const forwardedBody = JSON.parse(base44Call.options.body);
    assert.strictEqual(forwardedBody.user_id, AUTH_USER_ID);
  }

  console.log('test-seat-request-gate-enforcement: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
