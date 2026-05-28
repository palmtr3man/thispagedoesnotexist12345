const assert = require('assert');
const seatClaim = require('./netlify/functions/seat-claim.js');
const seatMap = require('./netlify/functions/seat-map.js');

process.env.BASE44_SEAT_URL = 'https://app.base44.com/api/apps/test/entities/Seat';
process.env.BASE44_SEAT_LIST_URL = 'https://app.base44.com/api/apps/test/entities/Seat';
process.env.ACTIVE_FLIGHT_ID = 'FL_051126';

const seatRows = [
  {
    id: 'internal-seat-1',
    tuj_code: 'TUJ-AA2222',
    flight_id: 'FL_051126',
    seat_number: 'seat_1',
    status: 'pending',
  },
  {
    id: 'internal-seat-2',
    tuj_code: 'TUJ-BB2222',
    flight_id: 'FL_051126',
    seat_number: 'seat_2',
    status: 'approved',
    assigned_passenger_id: 'other-passenger',
    user_email: 'other@example.com',
  },
  {
    id: 'internal-seat-3',
    tuj_code: 'TUJ-CC2222',
    flight_id: 'FL_052726',
    seat_number: 'seat_3',
    status: 'pending',
  },
];

const requests = [];

global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), method: options.method || 'GET', body: options.body || null });

  if ((options.method || 'GET') === 'GET' && String(url).includes('/entities/Seat?tuj_code=')) {
    const code = decodeURIComponent(String(url).split('tuj_code=')[1] || '');
    return {
      ok: true,
      status: 200,
      async json() { return seatRows.filter((row) => row.tuj_code === code); },
      async text() { return ''; },
    };
  }

  if ((options.method || 'GET') === 'GET' && String(url).endsWith('/entities/Seat')) {
    return {
      ok: true,
      status: 200,
      async json() { return seatRows; },
      async text() { return ''; },
    };
  }

  if (options.method === 'PUT' && String(url).endsWith('/entities/Seat/internal-seat-1')) {
    const body = JSON.parse(options.body);
    Object.assign(seatRows[0], body);
    return {
      ok: true,
      status: 200,
      async json() { return body; },
      async text() { return ''; },
    };
  }

  throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
};

async function claim(body) {
  const res = await seatClaim.handler({ httpMethod: 'POST', body: JSON.stringify(body) });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

async function map(queryStringParameters) {
  const res = await seatMap.handler({ httpMethod: 'GET', queryStringParameters });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

(async () => {
  const mapBefore = await map({ flight_id: 'FL_051126', passenger_id: 'passenger-1' });
  assert.strictEqual(mapBefore.statusCode, 200);
  assert.strictEqual(mapBefore.body.ok, true);
  assert.strictEqual(mapBefore.body.seats.length, 2);
  assert.strictEqual(mapBefore.body.seats.find((s) => s.seat_id === 'TUJ-AA2222').status, 'open');
  assert.strictEqual(mapBefore.body.seats.find((s) => s.seat_id === 'TUJ-BB2222').status, 'held');

  const claimed = await claim({
    seat_id: 'TUJ-AA2222',
    flight_id: 'FL_051126',
    passenger_id: 'passenger-1',
    passenger_email: 'one@example.com',
    expected_seat_number: 1,
  });
  assert.strictEqual(claimed.statusCode, 200);
  assert.strictEqual(claimed.body.ok, true);
  assert.strictEqual(claimed.body.status, 'held');
  assert.strictEqual(claimed.body.flight_id, 'FL_051126');
  assert.strictEqual(claimed.body.passenger_id, 'passenger-1');
  assert.strictEqual(seatRows[0].assigned_passenger_id, 'passenger-1');
  assert.strictEqual(seatRows[0].flight_id, 'FL_051126');
  assert.strictEqual(seatRows[0].status, 'approved');

  const duplicate = await claim({
    seat_id: 'TUJ-AA2222',
    flight_id: 'FL_051126',
    passenger_id: 'passenger-1',
    passenger_email: 'one@example.com',
  });
  assert.strictEqual(duplicate.statusCode, 200);
  assert.strictEqual(duplicate.body.duplicate, true);

  const taken = await claim({
    seat_id: 'TUJ-BB2222',
    flight_id: 'FL_051126',
    passenger_id: 'passenger-2',
    passenger_email: 'two@example.com',
  });
  assert.strictEqual(taken.statusCode, 409);
  assert.strictEqual(taken.body.error, 'seat_already_taken');

  const wrongFlight = await claim({
    seat_id: 'TUJ-CC2222',
    flight_id: 'FL_051126',
    passenger_id: 'passenger-3',
    passenger_email: 'three@example.com',
  });
  assert.strictEqual(wrongFlight.statusCode, 409);
  assert.strictEqual(wrongFlight.body.error, 'seat_not_in_flight');

  assert(requests.some((request) => request.method === 'PUT' && request.url.endsWith('/internal-seat-1')));
  console.log('self-seat-selection binding smoke tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
