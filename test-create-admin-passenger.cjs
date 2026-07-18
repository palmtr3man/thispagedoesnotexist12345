const assert = require('assert');
const { handler, normalizeSeatId, normalizeFlightId } = require('./netlify/functions/create-admin-passenger.js');

process.env.SEC06_INTERNAL_TOKEN = 'test-secret';
process.env.ADMIN_ORIGIN = 'https://thispagedoesnotexist12345.com';
process.env.SUPABASE_URL = 'https://supabase.example.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role';

const requests = [];

global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), method: options.method || 'GET', body: options.body || null });

  if (String(url).includes('/rest/v1/passengers?email=eq.') && String(url).includes('new.passenger')) {
    return {
      ok: true,
      status: 200,
      async json() { return []; },
      async text() { return '[]'; },
    };
  }

  if (String(url).endsWith('/rest/v1/passengers') && options.method === 'POST') {
    const payload = JSON.parse(options.body);
    assert.strictEqual(payload.email, 'new.passenger@example.com');
    assert.strictEqual(payload.seat_id, 'TUJ-JA2222');
    assert.strictEqual(payload.flight_tag, 'FL_051126');
    assert.strictEqual(payload.intake_status, 'pending');
    return {
      ok: true,
      status: 201,
      async json() { return [{ id: 'passenger-uuid-1', ...payload }]; },
      async text() { return '{}'; },
    };
  }

  throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
};

(async () => {
  assert.strictEqual(normalizeSeatId('tuj-ja2222'), 'TUJ-JA2222');
  assert.strictEqual(normalizeFlightId('FL 051126'), 'FL_051126');

  const response = await handler({
    httpMethod: 'POST',
    headers: { 'x-internal-token': 'test-secret' },
    body: JSON.stringify({
      name: 'Jane Clark',
      email: 'new.passenger@example.com',
      seat_id: 'TUJ-JA2222',
      flight_id: 'FL 051126',
      cabin_class: 'Economy',
      send_invite: false,
    }),
  });

  assert.strictEqual(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.created, true);
  assert.strictEqual(payload.passenger_id, 'passenger-uuid-1');
  assert.strictEqual(payload.seat_id, 'TUJ-JA2222');
  assert.strictEqual(payload.flight_id, 'FL_051126');
  assert.strictEqual(payload.invite_sent, false);

  const unauthorized = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ name: 'x', email: 'x@y.com', seat_id: 'TUJ-AB2222', flight_id: 'FL_1' }),
  });
  assert.strictEqual(unauthorized.statusCode, 401);

  console.log('test-create-admin-passenger: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
