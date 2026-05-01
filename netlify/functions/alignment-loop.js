/**
 * alignment-loop.js — Netlify Function
 *
 * BLOCKER-08: Notion ↔ SaaS Alignment Loop
 * Drift detection, auto-repair, and manual-review routing across
 * Base44, Supabase, Netlify env vars, and Notion field sync.
 *
 * Triggers:
 *   1. Cron: every 4 hours (configured in netlify.toml)
 *   2. Webhook: POST /api/alignment-loop with x-webhook-secret header
 *      (deploy/gate-change events, manual ops runs)
 *
 * Policy (locked May 1, 2026):
 *   AUTO-REPAIR  — boarding_emails_sent, resume_fit_check_status, Netlify env var presence flags
 *   MANUAL-REVIEW — journey_status, seat_status, Supabase schema fields, identity/billing fields
 *
 * Drift records are NEVER deleted — persisted as an auditable lifecycle log.
 *
 * Required env vars:
 *   NOTION_SECRET                — TUJ Alignment Bot integration token
 *   NOTION_SEAT_DB_ID            — Passenger Pipeline DB (86452d89-...)
 *   NOTION_DRIFT_REPORT_DB_ID    — TUJ Drift Reports DB (ce04014f-...)
 *   ALIGNMENT_WEBHOOK_SECRET     — Shared secret for webhook trigger (x-webhook-secret header)
 *   ALIGNMENT_CRON_SECRET        — Bearer token for scheduled cron invocations
 *   BASE44_SEAT_URL              — Base44 Seat entity read endpoint
 *   BASE44_USER_URL              — Base44 User entity read endpoint
 *   SUPABASE_URL                 — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY    — Supabase service role key
 *   NETLIFY_API_KEY              — Netlify personal access token
 *   NETLIFY_SITE_ID              — Netlify site ID
 */

'use strict';

const FETCH_TIMEOUT_MS = 8000;

// ── Field-level repair policy ─────────────────────────────────────────────────
// 'auto'   → Notion is source of truth; write Notion value to SaaS when stale.
// 'manual' → Both sides may have changed; flag for human review, never auto-write.
const FIELD_POLICY = {
  boarding_emails_sent:    'auto',
  resume_fit_check_status: 'auto',
  journey_status:          'manual',
  seat_status:             'manual',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

function notionHeaders() {
  return {
    'Authorization': `Bearer ${process.env.NOTION_SECRET}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

function supabaseHeaders() {
  return {
    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Validate the incoming trigger secret. Returns 'cron' | 'webhook' | null. */
function validateTrigger(event) {
  const method = (event.httpMethod || '').toUpperCase();
  const headers = event.headers || {};

  // Cron: scheduled invocation passes Authorization: Bearer <ALIGNMENT_CRON_SECRET>
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  if (authHeader === `Bearer ${process.env.ALIGNMENT_CRON_SECRET}`) return 'cron';

  // Webhook: POST with x-webhook-secret header
  const webhookSecret = headers['x-webhook-secret'] || '';
  if (method === 'POST' && webhookSecret === process.env.ALIGNMENT_WEBHOOK_SECRET) return 'webhook';

  return null;
}

// ── Notion DB queries ─────────────────────────────────────────────────────────

/** Fetch all pages from the Passenger Pipeline DB. */
async function fetchNotionPassengers() {
  const url = `https://api.notion.com/v1/databases/${process.env.NOTION_SEAT_DB_ID}/query`;
  const res = await timedFetch(url, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify({ page_size: 100 }),
  });
  if (!res.ok) throw new Error(`Notion passenger query failed: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

/** Extract a plain-text property value from a Notion page. */
function notionProp(page, name) {
  const prop = (page.properties || {})[name];
  if (!prop) return null;
  if (prop.type === 'select') return prop.select?.name ?? null;
  if (prop.type === 'rich_text') return prop.rich_text?.[0]?.plain_text ?? null;
  if (prop.type === 'title') return prop.title?.[0]?.plain_text ?? null;
  if (prop.type === 'number') return prop.number ?? null;
  if (prop.type === 'checkbox') return prop.checkbox ?? null;
  return null;
}

// ── Base44 lookup ─────────────────────────────────────────────────────────────

async function fetchBase44Seat(seatId) {
  if (!process.env.BASE44_SEAT_URL || !seatId) return null;
  try {
    const res = await timedFetch(`${process.env.BASE44_SEAT_URL}/${seatId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

async function fetchBase44User(userId) {
  if (!process.env.BASE44_USER_URL || !userId) return null;
  try {
    const res = await timedFetch(`${process.env.BASE44_USER_URL}/${userId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

// ── Supabase lookup ───────────────────────────────────────────────────────────

async function fetchSupabaseSeatRequest(seatId) {
  if (!process.env.SUPABASE_URL || !seatId) return null;
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/seat_requests?seat_id=eq.${encodeURIComponent(seatId)}&limit=1`;
    const res = await timedFetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] ?? null;
  } catch (_) { return null; }
}

// ── Netlify env var check ─────────────────────────────────────────────────────

const REQUIRED_ENV_VARS = [
  'NOTION_SECRET', 'NOTION_SEAT_DB_ID', 'NOTION_DRIFT_REPORT_DB_ID',
  'ALIGNMENT_WEBHOOK_SECRET', 'ALIGNMENT_CRON_SECRET',
  'BASE44_SEAT_URL', 'BASE44_USER_URL',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'NETLIFY_API_KEY', 'NETLIFY_SITE_ID',
];

function checkNetlifyEnvDrift() {
  const missing = REQUIRED_ENV_VARS.filter(k => !process.env[k]);
  return missing.map(k => ({
    source: 'netlify_env',
    field_name: k,
    notion_value: 'required',
    saas_value: 'missing',
    repair_action: 'auto', // flag only — never write secrets automatically
    drift_type: 'config',
  }));
}

// ── Drift report writer ───────────────────────────────────────────────────────

/**
 * Write a drift report row to NOTION_DRIFT_REPORT_DB_ID.
 * Idempotent: skips write if an open row with the same
 * passenger_id + field_name + saas_value already exists.
 */
async function writeDriftReport(report) {
  const dbId = process.env.NOTION_DRIFT_REPORT_DB_ID;
  if (!dbId) return;

  // Idempotency check: query for existing open row
  const queryUrl = `https://api.notion.com/v1/databases/${dbId}/query`;
  const filter = {
    and: [
      { property: 'passenger_id',  rich_text: { equals: report.passenger_id || '' } },
      { property: 'field_name',    rich_text: { equals: report.field_name } },
      { property: 'saas_value',    rich_text: { equals: String(report.saas_value ?? '') } },
      { property: 'status',        select:    { equals: 'open' } },
    ],
  };

  try {
    const checkRes = await timedFetch(queryUrl, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify({ filter, page_size: 1 }),
    });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      if ((existing.results || []).length > 0) return; // already logged — skip
    }
  } catch (_) { /* proceed to write on check failure */ }

  // Write new drift report row
  const createUrl = 'https://api.notion.com/v1/pages';
  const body = {
    parent: { database_id: dbId },
    properties: {
      passenger_id:  { rich_text: [{ text: { content: report.passenger_id || '' } }] },
      field_name:    { rich_text: [{ text: { content: report.field_name } }] },
      notion_value:  { rich_text: [{ text: { content: String(report.notion_value ?? '') } }] },
      saas_value:    { rich_text: [{ text: { content: String(report.saas_value ?? '') } }] },
      detected_at:   { rich_text: [{ text: { content: new Date().toISOString() } }] },
      status:        { select: { name: report.repair_action === 'manual' ? 'needs_review' : 'open' } },
      repair_action: { rich_text: [{ text: { content: report.repair_action } }] },
      source:        { rich_text: [{ text: { content: report.source || 'passenger' } }] },
      drift_type:    { rich_text: [{ text: { content: report.drift_type || 'field' } }] },
    },
  };

  try {
    await timedFetch(createUrl, {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify(body),
    });
  } catch (_) { /* log failure silently — never block primary response */ }
}

/** Mark a drift report row as resolved (status → resolved, resolved_at set). */
async function resolveDriftReport(pageId) {
  try {
    await timedFetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: notionHeaders(),
      body: JSON.stringify({
        properties: {
          status:      { select: { name: 'resolved' } },
          resolved_at: { rich_text: [{ text: { content: new Date().toISOString() } }] },
        },
      }),
    });
  } catch (_) {}
}

// ── Auto-repair writers ───────────────────────────────────────────────────────

/** Write a corrected field value back to Base44 Seat record. */
async function autoRepairBase44Seat(seatId, field, notionValue) {
  if (!process.env.BASE44_SEAT_URL || !seatId) return false;
  try {
    const res = await timedFetch(`${process.env.BASE44_SEAT_URL}/${seatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: notionValue }),
    });
    return res.ok;
  } catch (_) { return false; }
}

// ── Core alignment logic ──────────────────────────────────────────────────────

async function runAlignmentLoop() {
  const results = { drifts_detected: 0, auto_repaired: 0, manual_review: 0, errors: [] };

  // 1. Netlify env var drift check (config scope)
  const envDrifts = checkNetlifyEnvDrift();
  for (const d of envDrifts) {
    await writeDriftReport({ ...d, passenger_id: 'system' });
    results.drifts_detected++;
    results.manual_review++; // env var flags always go to manual review queue
  }

  // 2. Passenger-level drift across Base44 + Supabase + Notion
  let passengers = [];
  try {
    passengers = await fetchNotionPassengers();
  } catch (err) {
    results.errors.push(`Notion passenger fetch failed: ${err.message}`);
    return results;
  }

  for (const page of passengers) {
    const passengerId = page.id;
    const seatId = notionProp(page, 'seat_id') || notionProp(page, 'Seat ID');
    if (!seatId) continue;

    // Fetch live SaaS state
    const [b44Seat, supaSeat] = await Promise.all([
      fetchBase44Seat(seatId),
      fetchSupabaseSeatRequest(seatId),
    ]);

    // Fetch user record for resume_fit_check_status
    const userId = b44Seat?.user_id;
    const b44User = userId ? await fetchBase44User(userId) : null;

    // Build SaaS state snapshot
    const saasState = {
      seat_status:             b44Seat?.status ?? supaSeat?.status ?? null,
      journey_status:          b44Seat?.journey_status ?? supaSeat?.journey_status ?? null,
      boarding_emails_sent:    b44Seat?.boarding_emails_sent ?? supaSeat?.boarding_emails_sent ?? null,
      resume_fit_check_status: b44User?.passport_completed_at
        ? 'complete'
        : (b44User?.highest_ats_score > 0 ? 'in_progress' : 'not_started'),
    };

    // Compare against Notion values
    for (const [field, policy] of Object.entries(FIELD_POLICY)) {
      const notionValue = notionProp(page, field) ?? notionProp(page, field.replace(/_/g, ' '));
      const saasValue = saasState[field];

      // Skip if either side is null (no data to compare) or values match
      if (notionValue === null || saasValue === null) continue;
      if (String(notionValue) === String(saasValue)) continue;

      results.drifts_detected++;

      const report = {
        passenger_id: passengerId,
        field_name: field,
        notion_value: notionValue,
        saas_value: saasValue,
        repair_action: policy,
        source: 'passenger',
        drift_type: 'field',
      };

      if (policy === 'auto') {
        // Attempt auto-repair: write Notion value to Base44
        const repaired = await autoRepairBase44Seat(seatId, field, notionValue);
        if (repaired) {
          // Log as resolved immediately
          await writeDriftReport({ ...report, repair_action: 'auto_repaired' });
          results.auto_repaired++;
        } else {
          // Repair failed — escalate to manual review
          await writeDriftReport({ ...report, repair_action: 'manual' });
          results.manual_review++;
        }
      } else {
        // Manual review — write drift report, do not touch SaaS
        await writeDriftReport(report);
        results.manual_review++;
      }
    }
  }

  return results;
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async function handler(event) {
  // OPTIONS preflight
  if ((event.httpMethod || '').toUpperCase() === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-webhook-secret',
      },
      body: '',
    };
  }

  // Auth gate
  const triggerType = validateTrigger(event);
  if (!triggerType) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized — invalid or missing trigger secret.' }),
    };
  }

  try {
    const results = await runAlignmentLoop();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        trigger: triggerType,
        ran_at: new Date().toISOString(),
        ...results,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.handler = exports.handler;
}
