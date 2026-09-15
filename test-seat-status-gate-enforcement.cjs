'use strict';

/**
 * Server-side gate enforcement smoke tests for netlify/functions/seat-status.js.
 *
 * Covers:
 *   - anonymous GET → unchanged public payload, no profile_gate_status field
 *   - Bearer token present but invalid → 401 INVALID_TOKEN
 *   - Bearer token valid, unverified profile → profile_gate_status: 'unverified'
 *   - Bearer token valid, verified profile → profile_gate_status: 'verified'
 *
 * Run with: node test-seat-status-gate-enforcement.cjs
 */

const assert = require('assert');
const { handler } = require('./netlify/functions/seat-status.js');

const SUPABASE_URL = 'https://gate-test.supabase.co';
const AUTH_USER_ID = 'auth-user-456';
const VALID_TOKEN = 'valid-access-token';
const INVALID_TOKEN = 'invalid-access-token';
const COHORT_STATUS_URL = 'https://base44.example/functions/getCohortStatus';

process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.BASE44_COHORT_STATUS_URL = COHORT_STATUS_URL;
delete process.env.PROFILE_TABLE;
delete process.env.MAINTENANCE_MODE;
delete process.env.ALPHA_MODE;
delete process.env.BASE44_SEAT_URL;
delete process.env.BASE44_USER_URL;

let fetchCalls = [];
let profileRecord = null;

const COHORT_PAYLOAD = { gate_status: 'open', flight_id: 'FL_TEST_001' };

const UNKNOWN_SEAT_STATUS_META = {
  label: 'Unknown',
  category: 'unknown',
  countsAsApproved: false,
  countsAsOpened: false,
  countsAsOccupied: false,
};

global.fetch = async (url, options = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, options });

  if (u.includes('/rest/v1/flight_registry')) {
    // No active flight registry row — falls back to BASE44_COHORT_STATUS_URL.
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => [],
      text: async () => '[]',
    };
  }

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

  if (u.startsWith(COHORT_STATUS_URL)) {
    return { ok: true, status: 200, json: async () => ({ ...COHORT_PAYLOAD }) };
  }

  throw new Error(`Unexpected fetch URL: ${u}`);
};

function event({ headers = {} } = {}) {
  return { httpMethod: 'GET', headers, queryStringParameters: {} };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function run() {
  // 1. Anonymous GET → exact existing public payload shape, no profile_gate_status
  //    field, and no auth/profile lookups are ever made.
  {
    fetchCalls = [];
    const res = await handler(event());
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body, {
      gate_status: 'open',
      flight_id: 'FL_TEST_001',
      flight_code: 'FL_TEST_001',
      resume_fit_check_status: 'unknown',
      seat_status: 'unknown',
      seat_status_meta: UNKNOWN_SEAT_STATUS_META,
      registry_synced: false,
    });
    assert.ok(!('profile_gate_status' in body), 'anonymous responses must never include profile_gate_status');
    assert.ok(!fetchCalls.some((c) => c.url.includes('/auth/v1/user')), 'anonymous requests must not call Supabase Auth');
    assert.ok(!fetchCalls.some((c) => c.url.includes('/rest/v1/profiles')), 'anonymous requests must not fetch a profile');
  }

  // 2. Bearer token present but invalid → 401 INVALID_TOKEN, upstream never called.
  {
    fetchCalls = [];
    const res = await handler(event({ headers: bearer(INVALID_TOKEN) }));
    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body, { ok: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    assert.ok(!fetchCalls.some((c) => c.url.startsWith(COHORT_STATUS_URL)), 'invalid token must short-circuit before hitting the cohort status upstream');
  }

  // 3. Bearer token valid, unverified profile → adds only profile_gate_status: 'unverified'.
  {
    fetchCalls = [];
    profileRecord = { id: AUTH_USER_ID, me_profile_status: 'pending' };
    const res = await handler(event({ headers: bearer(VALID_TOKEN) }));
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.profile_gate_status, 'unverified');
    const { profile_gate_status, ...rest } = body;
    assert.deepStrictEqual(rest, {
      gate_status: 'open',
      flight_id: 'FL_TEST_001',
      flight_code: 'FL_TEST_001',
      resume_fit_check_status: 'unknown',
      seat_status: 'unknown',
      seat_status_meta: UNKNOWN_SEAT_STATUS_META,
      registry_synced: false,
    });
  }

  // 4. Bearer token valid, verified via passport_completed_at → profile_gate_status: 'verified'.
  {
    fetchCalls = [];
    profileRecord = { id: AUTH_USER_ID, me_profile_status: 'pending', passport_completed_at: '2026-01-01T00:00:00Z' };
    const res = await handler(event({ headers: bearer(VALID_TOKEN) }));
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.profile_gate_status, 'verified');
  }

  // 5. Bearer token valid, verified via me_profile_status === 'verified' → profile_gate_status: 'verified'.
  {
    fetchCalls = [];
    profileRecord = { id: AUTH_USER_ID, me_profile_status: 'verified' };
    const res = await handler(event({ headers: bearer(VALID_TOKEN) }));
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.profile_gate_status, 'verified');
  }

  console.log('test-seat-status-gate-enforcement: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
