'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'netlify', 'functions', 'shared', 'alignment-core.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const calls = [];

const env = {
  NOTION_API_KEY: 'canonical-notion-token',
  NOTION_SECRET: 'legacy-notion-token',
  NOTION_SEAT_DB_ID: 'canonical-passenger-db',
  NOTION_PASSENGER_PIPELINE_DB_ID: 'legacy-passenger-db',
  NOTION_DRIFT_REPORT_DB_ID: 'drift-report-db',
  SEC06_INTERNAL_TOKEN: 'internal-token',
  SEC06_SCHEDULER_SECRET: 'scheduler-token',
  BASE44_SEAT_URL: 'https://base44.example/seats',
  BASE44_USER_URL: 'https://base44.example/users',
  BASE44_APPLICATION_URL: 'https://base44.example/applications',
  NOTION_JD_PIPELINE_DB_ID: 'jd-pipeline-db',
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  NETLIFY_API_KEY: 'netlify-api-key',
  NETLIFY_SITE_ID: 'netlify-site-id',
};

const loadedModule = { exports: {} };
vm.runInNewContext(source, {
  module: loadedModule,
  exports: loadedModule.exports,
  process: { env },
  AbortController,
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === env.BASE44_APPLICATION_URL) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/v1/databases/')) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  },
  console,
});

async function runAndGetPassengerRequest() {
  calls.length = 0;
  const result = await loadedModule.exports.runAlignmentLoop();
  assert.equal(result.errors.length, 0, `unexpected alignment errors: ${result.errors.join('; ')}`);
  const request = calls.find(call => call.url.includes('/v1/databases/'));
  assert.ok(request, 'expected a Passenger Pipeline Notion query');
  return request;
}

(async () => {
  let request = await runAndGetPassengerRequest();
  assert.equal(
    request.url,
    'https://api.notion.com/v1/databases/canonical-passenger-db/query',
    'the canonical Passenger Pipeline variable must take precedence'
  );
  assert.equal(
    request.options.headers.Authorization,
    'Bearer canonical-notion-token',
    'NOTION_API_KEY must take precedence when both token variables are present'
  );

  delete env.NOTION_API_KEY;
  delete env.NOTION_SEAT_DB_ID;
  request = await runAndGetPassengerRequest();
  assert.equal(
    request.url,
    'https://api.notion.com/v1/databases/legacy-passenger-db/query',
    'the documented Passenger Pipeline alias must remain supported'
  );
  assert.equal(
    request.options.headers.Authorization,
    'Bearer legacy-notion-token',
    'NOTION_SECRET must remain a token fallback for existing deployments'
  );

  delete env.NOTION_PASSENGER_PIPELINE_DB_ID;
  env.NOTION_PIPELINE_DATABASE_ID = 'older-pipeline-db';
  request = await runAndGetPassengerRequest();
  assert.equal(
    request.url,
    'https://api.notion.com/v1/databases/older-pipeline-db/query',
    'the older Pipeline Database alias must remain supported'
  );

  console.log('alignment-core Notion configuration tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
