const assert = require('assert');
const seatFn = require('./netlify/functions/lib/seat-impl.cjs');
const seatStatusFn = require('./netlify/functions/lib/seat-status-impl.cjs');

process.env.BASE44_SEAT_URL = 'https://api.base44.com/api/apps/test/entities/Seat';
process.env.BASE44_USER_URL = 'https://api.base44.com/api/apps/test/entities/User';
process.env.BASE44_COHORT_STATUS_URL = 'https://base44.example/functions/getCohortStatus';
process.env.ACTIVE_FLIGHT_CODE = 'FL_051126';

const requests = [];

global.fetch = async (url) => {
  requests.push(String(url));

  if (String(url).includes('getCohortStatus')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return { gate_status: 'open', flight_id: 'FL_051126' };
      },
    };
  }

  if (String(url).includes('/entities/Seat?tuj_code=TUJ-JA2222')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return [{
          id: 'base44-seat-record-id',
          tuj_code: 'TUJ-JA2222',
          status: 'approved',
          user_id: 'base44-user-record-id',
        }];
      },
    };
  }

  if (String(url).includes('/entities/User/base44-user-record-id')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: 'base44-user-record-id', passport_completed_at: '2026-05-16T00:00:00Z' };
      },
    };
  }

  throw new Error(`Unexpected fetch URL: ${url}`);
};

(async () => {
  const seatRes = await seatFn.handler({
    httpMethod: 'GET',
    path: '/api/seat',
    queryStringParameters: { id: 'TUJ-JA2222' },
  });
  assert.strictEqual(seatRes.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(seatRes.body), { valid: true, seat_id: 'TUJ-JA2222', status: 'approved' });

  const statusRes = await seatStatusFn.handler({
    httpMethod: 'GET',
    queryStringParameters: { seat_id: 'TUJ-JA2222' },
  });
  assert.strictEqual(statusRes.statusCode, 200);
  const statusBody = JSON.parse(statusRes.body);
  assert.strictEqual(statusBody.flight_code, 'FL_051126');
  assert.strictEqual(statusBody.seat_status, 'approved');
  assert.strictEqual(statusBody.resume_fit_check_status, 'complete');

  assert(requests.some((url) => url.includes('/entities/Seat?tuj_code=TUJ-JA2222')));
  assert(!requests.some((url) => url.endsWith('/entities/Seat/TUJ-JA2222')));
  console.log('seat lookup by TUJ code smoke tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
