const assert = require('assert');
const { handler } = require('./netlify/functions/seat-ready.js');

process.env.BASE44_SEAT_URL = 'https://app.base44.com/api/apps/test/entities/Seat';
process.env.ACTIVE_FLIGHT_ID = 'FL_051126';
process.env.READY_CLICK_SEND_ENABLED = 'false';
process.env.SEC06_INTERNAL_TOKEN = 'test-seat-secret';
process.env.READY_CLICK_IDEMPOTENCY_GUARD_OPTIONAL = 'true';

global.fetch = async (url, options = {}) => {
  if (options.method === 'GET') {
    const mismatch = String(url).includes('TUJ-JA4444');
    return {
      ok: true,
      status: 200,
      async json() {
        return [{
          id: mismatch ? 'base44-seat-4' : 'base44-seat-2',
          tuj_code: mismatch ? 'TUJ-JA4444' : 'TUJ-JA2222',
          user_email: 'passenger@example.com',
          flight_id: 'FL_051126',
          seat_number: mismatch ? 'seat_4' : 'seat_2',
          status: 'pending',
        }];
      },
      async text() { return ''; },
    };
  }

  if (options.method === 'PUT') {
    return {
      ok: true,
      status: 200,
      async json() { return JSON.parse(options.body); },
      async text() { return ''; },
    };
  }

  throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
};

async function invoke(body, headers = { 'x-seat-api-secret': 'test-seat-secret' }) {
  const res = await handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

(async () => {
  const unauthenticated = await invoke({
    seat_id: 'TUJ-JA2222',
    passenger_email: 'passenger@example.com',
    flight_id: 'FL_051126',
  }, {});
  assert.strictEqual(unauthenticated.statusCode, 401);
  assert.strictEqual(unauthenticated.body.error, 'unauthorized');

  const blocked = await invoke({
    seat_id: 'TUJ-JA4444',
    passenger_email: 'passenger@example.com',
    flight_id: 'FL_051126',
    expected_seat_number: 2,
  });
  assert.strictEqual(blocked.statusCode, 409);
  assert.strictEqual(blocked.body.error, 'qa_reconciliation_required');
  assert.strictEqual(blocked.body.reason, 'seat_number_mismatch');
  assert.strictEqual(blocked.body.actual_seat_number, 4);

  const opened = await invoke({
    seat_id: 'TUJ-JA2222',
    passenger_email: 'passenger@example.com',
    flight_id: 'FL_051126',
    expected_seat_number: 2,
  });
  assert.strictEqual(opened.statusCode, 200);
  assert.strictEqual(opened.body.ok, true);
  assert.strictEqual(opened.body.status, 'opened');

  console.log('seat-ready seat-number smoke tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
