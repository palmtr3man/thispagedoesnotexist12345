const assert = require('assert');

const {
  resolveHandleSeatOpenedTarget,
  triggerBase44HandleSeatOpened,
} = require('./netlify/functions/shared/handle-seat-opened-trigger.cjs');

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
}

async function run() {
  try {
    delete process.env.BASE44_HANDLE_SEAT_OPENED_URL;
    assert.strictEqual(resolveHandleSeatOpenedTarget(), 'netlify');

    process.env.BASE44_HANDLE_SEAT_OPENED_URL = 'https://base44.example/handleSeatOpened';
    assert.strictEqual(resolveHandleSeatOpenedTarget(), 'base44');

    delete process.env.SEC06_INTERNAL_TOKEN;
    const missingToken = await triggerBase44HandleSeatOpened(
      process.env.BASE44_HANDLE_SEAT_OPENED_URL,
      { id: 'seat-1', tuj_code: 'TUJ-KC2222' },
    );
    assert.strictEqual(missingToken.ok, false);
    assert.strictEqual(missingToken.status, 500);
    assert.strictEqual(missingToken.via, 'base44');

    process.env.SEC06_INTERNAL_TOKEN = 'test-internal-token';
    let captured = null;
    const mockFetch = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, skipped: false, path: 'free' }),
      };
    };

    const result = await triggerBase44HandleSeatOpened(
      process.env.BASE44_HANDLE_SEAT_OPENED_URL,
      { id: 'seat-1', tuj_code: 'TUJ-KC2222', user_email: 'p@example.com' },
      mockFetch,
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.via, 'base44');
    assert.strictEqual(captured.url, 'https://base44.example/handleSeatOpened');
    assert.strictEqual(captured.init.headers['x-internal-token'], 'test-internal-token');
    assert.match(captured.init.body, /TUJ-KC2222/);

    console.log('test-handle-seat-opened-trigger: ok');
  } finally {
    restoreEnv();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
