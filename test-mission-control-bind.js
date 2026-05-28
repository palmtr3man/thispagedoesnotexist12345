const assert = require('assert');
const { handler } = require('./netlify/functions/mission-control-bind.js');

process.env.SEC06_INTERNAL_TOKEN = 'test-secret';
process.env.ADMIN_ORIGIN = 'https://thispagedoesnotexist12345.net';
process.env.SUPABASE_URL = 'https://supabase.example.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';
process.env.ACTIVE_FLIGHT_CODE = 'FL_051126';

let rpcCalls = 0;
let auditPhase = 'before';
const requests = [];

global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), method: options.method || 'GET', body: options.body || null });

  if (String(url).includes('/rest/v1/v_passenger_flight_binding_audit')) {
    const rows = auditPhase === 'before'
      ? [{
          email: 'janelle.jclark@gmail.com',
          seat_id: 'TUJ-JA2222',
          flight_binding_status: 'unbound',
          waitlist_flight_code: null,
          canonical_flight_code: null,
          binding_status: 'mission_control_binding_pending',
        }]
      : [{
          email: 'janelle.jclark@gmail.com',
          seat_id: 'TUJ-JA2222',
          flight_binding_status: 'bound',
          waitlist_flight_code: 'FL_051126',
          canonical_flight_code: 'FL_051126',
          binding_status: 'ok',
        }];
    return {
      ok: true,
      status: 200,
      async json() { return rows; },
      async text() { return JSON.stringify(rows); },
    };
  }

  if (String(url).includes('/rest/v1/rpc/bind_subject_at_mission_control')) {
    rpcCalls += 1;
    auditPhase = 'after';
    const body = JSON.parse(options.body);
    assert.strictEqual(body.p_email, 'janelle.jclark@gmail.com');
    assert.strictEqual(body.p_seat_id, 'TUJ-JA2222');
    assert.strictEqual(body.p_flight_code, 'FL_051126');
    return {
      ok: true,
      status: 200,
      async json() { return [{ ...body, flight_binding_status: 'bound' }]; },
      async text() { return '[]'; },
    };
  }

  throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
};

async function invoke(body, secret = 'test-secret') {
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': secret },
    body: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

(async () => {
  const unauthorized = await invoke({ subjects: [{ seat_id: 'TUJ-JA2222' }] }, 'bad-secret');
  assert.strictEqual(unauthorized.statusCode, 401);

  auditPhase = 'before';
  rpcCalls = 0;
  const dryRun = await invoke({ dry_run: true, subjects: [{ email: 'janelle.jclark@gmail.com', seat_id: 'TUJ-JA2222' }] });
  assert.strictEqual(dryRun.statusCode, 200);
  assert.strictEqual(dryRun.body.ok, true);
  assert.strictEqual(dryRun.body.dry_run, true);
  assert.strictEqual(rpcCalls, 0);
  assert.strictEqual(dryRun.body.unresolved_count, 1);

  auditPhase = 'before';
  const applied = await invoke({ dry_run: false, flight_code: 'FL_051126', subjects: [{ email: 'janelle.jclark@gmail.com', seat_id: 'TUJ-JA2222' }] });
  assert.strictEqual(applied.statusCode, 200);
  assert.strictEqual(applied.body.ok, true);
  assert.strictEqual(applied.body.dry_run, false);
  assert.strictEqual(rpcCalls, 1);
  assert.strictEqual(applied.body.unresolved_count, 0);
  assert.strictEqual(applied.body.sendgrid_triggered, false);

  assert(requests.some((request) => request.url.includes('/rpc/bind_subject_at_mission_control')));
  console.log('mission-control binding helper smoke tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
