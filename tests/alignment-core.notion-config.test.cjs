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
  // NOTION_SEAT_DB_ID intentionally holds an UNRELATED database id here (it
  // maps to the Canon Profiles DB in real deployments, not the Passenger
  // Pipeline). It must never be selected for Passenger Pipeline operations,
  // even when it is present alongside — or in place of — the real pipeline
  // aliases.
  NOTION_SEAT_DB_ID: 'canon-profiles-db-unrelated',
  NOTION_PIPELINE_DATABASE_ID: 'fresh-pipeline-db',
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
  // 1. Fresh NOTION_PIPELINE_DATABASE_ID must win over every other alias,
  //    including NOTION_SEAT_DB_ID, when all are present.
  let request = await runAndGetPassengerRequest();
  assert.equal(
    request.url,
    'https://api.notion.com/v1/databases/fresh-pipeline-db/query',
    'NOTION_PIPELINE_DATABASE_ID must take precedence over every other Passenger Pipeline alias'
  );
  assert.equal(
    request.options.headers.Authorization,
    'Bearer canonical-notion-token',
    'NOTION_API_KEY must take precedence when both token variables are present'
  );

  // 2. With the fresh pipeline id absent, the documented legacy alias must
  //    still be used — and NOTION_SEAT_DB_ID (still present) must be skipped.
  delete env.NOTION_API_KEY;
  delete env.NOTION_PIPELINE_DATABASE_ID;
  request = await runAndGetPassengerRequest();
  assert.equal(
    request.url,
    'https://api.notion.com/v1/databases/legacy-passenger-db/query',
    'NOTION_PASSENGER_PIPELINE_DB_ID must be used when the fresh pipeline id is absent, without falling back to NOTION_SEAT_DB_ID'
  );
  assert.equal(
    request.options.headers.Authorization,
    'Bearer legacy-notion-token',
    'NOTION_SECRET must remain a token fallback for existing deployments'
  );

  // 3. NOTION_SEAT_DB_ID must NEVER be used for Passenger Pipeline
  //    operations, even as a last resort when it is the only Notion
  //    database id configured. The loop must fail closed with a config
  //    error rather than silently querying the Canon Profiles database.
  delete env.NOTION_PASSENGER_PIPELINE_DB_ID;
  calls.length = 0;
  const result = await loadedModule.exports.runAlignmentLoop();
  assert.ok(
    result.errors.some(e => e.includes('Notion passenger fetch failed')),
    'expected a Notion passenger fetch failure when only NOTION_SEAT_DB_ID is configured'
  );
  assert.ok(
    !calls.some(call => call.url.includes('canon-profiles-db-unrelated')),
    'NOTION_SEAT_DB_ID must never be queried for Passenger Pipeline operations, even as a last-resort fallback'
  );

  console.log('alignment-core Notion configuration tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
