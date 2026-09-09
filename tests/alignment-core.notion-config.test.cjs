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
  // NOTION_SEAT_DB_ID is present from the start and stays present through
  // most of this file — it must satisfy the Canonical Profile DB group but
  // must NEVER be used to resolve the Passenger Pipeline DB.
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

/**
 * The Passenger Pipeline fetch is the *only* Notion database query that asks
 * for `{ page_size: 100 }` with no `filter` — drift-report idempotency
 * checks and JD-pipeline lookups always send a `filter`. This lets us find
 * the pipeline request unambiguously regardless of how many other Notion
 * queries (e.g. env-drift reports) happen to run first.
 */
function isPassengerPipelineRequest(call) {
  if (!call.url.includes('/v1/databases/')) return false;
  try {
    const body = JSON.parse(call.options.body || '{}');
    return body.page_size === 100 && !body.filter;
  } catch (_) {
    return false;
  }
}

async function runAndGetPassengerRequest() {
  calls.length = 0;
  const result = await loadedModule.exports.runAlignmentLoop();
  const request = calls.find(isPassengerPipelineRequest);
  return { result, request };
}

(async () => {
  // 1. Only the documented NOTION_PASSENGER_PIPELINE_DB_ID alias is
  //    configured (NOTION_SEAT_DB_ID is also present, but must be ignored
  //    for pipeline resolution).
  let { result, request } = await runAndGetPassengerRequest();
  assert.equal(result.errors.length, 0, `unexpected alignment errors: ${result.errors.join('; ')}`);
  assert.ok(request, 'expected a Passenger Pipeline Notion query');
  assert.equal(
    request.url,
    'https://api.notion.com/v1/databases/legacy-passenger-db/query',
    'NOTION_SEAT_DB_ID must be ignored — the documented pipeline alias must resolve the Passenger Pipeline DB'
  );
  assert.equal(
    request.options.headers.Authorization,
    'Bearer canonical-notion-token',
    'NOTION_API_KEY must take precedence when both token variables are present'
  );

  // 2. Adding the canonical NOTION_PIPELINE_DATABASE_ID must take precedence
  //    over both the legacy alias and NOTION_SEAT_DB_ID.
  env.NOTION_PIPELINE_DATABASE_ID = 'canonical-pipeline-db';
  ({ result, request } = await runAndGetPassengerRequest());
  assert.equal(result.errors.length, 0, `unexpected alignment errors: ${result.errors.join('; ')}`);
  assert.ok(request, 'expected a Passenger Pipeline Notion query');
  assert.equal(
    request.url,
    'https://api.notion.com/v1/databases/canonical-pipeline-db/query',
    'NOTION_PIPELINE_DATABASE_ID must take precedence for the Passenger Pipeline DB'
  );

  // 3. NOTION_SEAT_DB_ID must NEVER resolve the Passenger Pipeline DB — even
  //    when it is the only pipeline-shaped variable left configured. It is
  //    reserved exclusively for the Canonical Profile DB post alias-split.
  delete env.NOTION_PIPELINE_DATABASE_ID;
  delete env.NOTION_PASSENGER_PIPELINE_DB_ID;
  ({ result, request } = await runAndGetPassengerRequest());
  assert.ok(!request, 'NOTION_SEAT_DB_ID must never be used to query the Passenger Pipeline DB');
  assert.ok(
    result.errors.some(err => err.includes('Notion passenger database is not configured')),
    'expected a configuration error when only NOTION_SEAT_DB_ID is set'
  );

  // 4. Canonical Profile resolution: NOTION_SEAT_DB_ID is accepted as a
  //    fallback, but NOTION_CANON_PROFILE_DB_ID must take precedence.
  assert.equal(
    loadedModule.exports.canonicalProfileDbId(),
    'canonical-passenger-db',
    'NOTION_SEAT_DB_ID must be accepted as the Canonical Profile DB fallback'
  );
  env.NOTION_CANON_PROFILE_DB_ID = 'canon-profile-db';
  assert.equal(
    loadedModule.exports.canonicalProfileDbId(),
    'canon-profile-db',
    'NOTION_CANON_PROFILE_DB_ID must take precedence over NOTION_SEAT_DB_ID'
  );

  console.log('alignment-core Notion configuration tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
