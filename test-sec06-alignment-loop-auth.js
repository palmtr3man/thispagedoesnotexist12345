'use strict';

const assert = require('assert');
const {
  validateAlignmentLoopTrigger,
} = require('./netlify/functions/shared/sec06-auth.js');
const { handler } = require('./netlify/functions/alignment-loop.js');

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: {},
    ...overrides,
  };
}

async function main() {
  const originalSchedulerSecret = process.env.SEC06_SCHEDULER_SECRET;
  const originalInternalToken = process.env.SEC06_INTERNAL_TOKEN;

  try {
    delete process.env.SEC06_SCHEDULER_SECRET;
    delete process.env.SEC06_INTERNAL_TOKEN;

    // Netlify schedule marker headers alone must not authorize cron execution.
    assert.strictEqual(
      validateAlignmentLoopTrigger(event({ headers: { 'x-nf-event': 'schedule' } })),
      null,
    );

    assert.strictEqual(
      validateAlignmentLoopTrigger(event({ headers: { 'x-netlify-event': 'scheduled' } })),
      null,
    );

    const markerOnlyResponse = await handler(event({ headers: { 'x-nf-event': 'schedule' } }));
    assert.strictEqual(markerOnlyResponse.statusCode, 401);

    assert.strictEqual(
      validateAlignmentLoopTrigger(
        event({ headers: { origin: 'https://evil.example', 'x-nf-event': 'schedule' } }),
      ),
      null,
    );

    assert.strictEqual(
      validateAlignmentLoopTrigger(
        event({ headers: { origin: 'https://evil.example', 'x-netlify-event': 'scheduled' } }),
      ),
      null,
    );

    process.env.SEC06_SCHEDULER_SECRET = 'scheduler-secret-test-value';
    process.env.SEC06_INTERNAL_TOKEN = 'internal-token-test-value';

    // Cron execution requires the configured scheduler secret.
    assert.strictEqual(
      validateAlignmentLoopTrigger(event({ headers: { 'x-scheduler-secret': 'scheduler-secret-test-value' } })),
      'cron',
    );

    assert.strictEqual(
      validateAlignmentLoopTrigger(event({ headers: { authorization: 'Bearer scheduler-secret-test-value' } })),
      'cron',
    );

    // Schedule markers alone remain insufficient even when secrets are configured.
    assert.strictEqual(
      validateAlignmentLoopTrigger(event({ headers: { 'x-nf-event': 'schedule' } })),
      null,
    );

    assert.strictEqual(
      validateAlignmentLoopTrigger(event({ headers: { 'x-netlify-event': 'scheduled' } })),
      null,
    );

    assert.strictEqual(
      validateAlignmentLoopTrigger(
        event({ headers: { origin: 'https://evil.example', 'x-scheduler-secret': 'scheduler-secret-test-value' } }),
      ),
      null,
    );

    // Public webhook execution remains POST + internal-token only.
    assert.strictEqual(
      validateAlignmentLoopTrigger(event({
        httpMethod: 'POST',
        headers: { 'x-internal-token': 'internal-token-test-value' },
      })),
      'webhook',
    );

    assert.strictEqual(
      validateAlignmentLoopTrigger(event({
        httpMethod: 'POST',
        headers: { origin: 'https://evil.example', 'x-internal-token': 'internal-token-test-value' },
      })),
      null,
    );

    assert.strictEqual(
      validateAlignmentLoopTrigger(event({ httpMethod: 'GET', headers: {} })),
      null,
    );
  } finally {
    if (originalSchedulerSecret === undefined) {
      delete process.env.SEC06_SCHEDULER_SECRET;
    } else {
      process.env.SEC06_SCHEDULER_SECRET = originalSchedulerSecret;
    }

    if (originalInternalToken === undefined) {
      delete process.env.SEC06_INTERNAL_TOKEN;
    } else {
      process.env.SEC06_INTERNAL_TOKEN = originalInternalToken;
    }
  }
}

main()
  .then(() => console.log('test-sec06-alignment-loop-auth: ok'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
