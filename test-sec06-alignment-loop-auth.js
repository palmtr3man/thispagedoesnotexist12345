'use strict';

const assert = require('assert');
const {
  validateAlignmentLoopTrigger,
} = require('./netlify/functions/shared/sec06-auth.js');

function event(overrides = {}) {
  return {
    httpMethod: 'GET',
    headers: {},
    ...overrides,
  };
}

// Netlify scheduled invocations must pass without leaking public webhook access.
assert.strictEqual(
  validateAlignmentLoopTrigger(event({ headers: { 'x-nf-event': 'schedule' } })),
  'cron',
);

assert.strictEqual(
  validateAlignmentLoopTrigger(event({ httpMethod: 'POST', headers: { origin: 'https://evil.example' } })),
  null,
);

assert.strictEqual(
  validateAlignmentLoopTrigger(event({ httpMethod: 'GET', headers: {} })),
  null,
);

console.log('test-sec06-alignment-loop-auth: ok');
