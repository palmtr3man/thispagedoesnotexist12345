/**
 * /api/beehiiv-sync — Netlify Function (Beehiiv Issue 2)
 *
 * Consumes the Beehiiv sync canon contract, writes one row to
 * public.beehiiv_sync_log per invocation, and resolves cohort audience
 * against Supabase seat_requests + Beehiiv active subscribers.
 *
 * Phase 2 scope: dry_run by default. Live Beehiiv subscriber mutation is
 * gated behind dry_run=false AND BEEHIIV_SYNC_LIVE_ENABLED=true.
 *
 * Required env vars:
 *   ADMIN_SECRET                  — x-admin-secret for manual invocations
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   BEEHIIV_API_KEY
 *   BEEHIIV_PUB_ID
 *
 * Optional env vars:
 *   BEEHIIV_SYNC_LIVE_ENABLED     — must be true to allow live writes (default false)
 *
 * Request body:
 *   {
 *     "flight_key": "FL_051126",
 *     "flight_id": "FL 051126",
 *     "cohort_id": "gemini-alpha-2026-05-11",
 *     "dry_run": true,
 *     "segment_key": "gemini-alpha",
 *     "boarding_opened_at": "2026-05-11T12:34:00Z",
 *     "boarding_closed_at": null
 *   }
 */

const { validateBeehiivSyncIdentity } = require('./lib/beehiiv-flight-identity');

const HEADERS = {
  'Access-Control-Allow-Origin': process.env.ADMIN_ORIGIN || 'https://thispagedoesnotexist12345.net',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
  'Content-Type': 'application/json',
};

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function supabaseHeaders(key, prefer = 'return=representation') {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  };
}

async function supabaseFetch(url, key, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...supabaseHeaders(key, options.prefer || 'return=representation'),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`Supabase ${res.status}: ${detail.slice(0, 500)}`);
  }
  return body;
}

async function insertAuditRow(supabaseUrl, supabaseKey, payload) {
  const rows = await supabaseFetch(
    `${supabaseUrl}/rest/v1/beehiiv_sync_log`,
    supabaseKey,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function finalizeAuditRow(supabaseUrl, supabaseKey, id, patch) {
  await supabaseFetch(
    `${supabaseUrl}/rest/v1/beehiiv_sync_log?id=eq.${id}`,
    supabaseKey,
    {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify(patch),
    },
  );
}

async function fetchSeatRequestsForFlight(supabaseUrl, supabaseKey, flightKey) {
  const url = `${supabaseUrl}/rest/v1/seat_requests?flight_id=eq.${encodeURIComponent(flightKey)}&status=neq.cancelled&select=id,email,seat_id,status,cabin_class&limit=500`;
  const rows = await supabaseFetch(url, supabaseKey, { prefer: 'return=representation' });
  return Array.isArray(rows) ? rows : [];
}

async function fetchCohortById(supabaseUrl, supabaseKey, cohortId) {
  const url = `${supabaseUrl}/rest/v1/cohorts?id=eq.${encodeURIComponent(cohortId)}&limit=1`;
  const rows = await supabaseFetch(url, supabaseKey, { prefer: 'return=representation' });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchCohortByFlightKey(supabaseUrl, supabaseKey, flightKey) {
  const url = `${supabaseUrl}/rest/v1/cohorts?flight_id=eq.${encodeURIComponent(flightKey)}&limit=1`;
  const rows = await supabaseFetch(url, supabaseKey, { prefer: 'return=representation' });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function beehiivFetch(path, options = {}) {
  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId = process.env.BEEHIIV_PUB_ID;
  if (!pubId) throw new Error('BEEHIIV_PUB_ID is not configured');
  if (!apiKey) throw new Error('BEEHIIV_API_KEY is not configured');

  const res = await fetch(`https://api.beehiiv.com/v2/publications/${pubId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`beehiiv ${res.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

function normaliseTags(subscription) {
  const raw = subscription.tags || subscription.subscription_tags || subscription.custom_tags || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((tag) => {
    if (typeof tag === 'string') return tag;
    return tag?.name || tag?.tag || tag?.id || '';
  }).filter(Boolean);
}

function subscriberEmail(subscription) {
  return String(
    subscription.email || subscription.email_address || subscription.subscriber_email || '',
  ).trim().toLowerCase();
}

async function listActiveBeehiivSubscribers(limit = 250) {
  const params = new URLSearchParams({ limit: String(limit), status: 'active' });
  const body = await beehiivFetch(`/subscriptions?${params.toString()}`);
  return Array.isArray(body.data) ? body.data : [];
}

function buildAudiencePlan(seatRequests, beehiivSubscribers, segmentKey) {
  const subscriberByEmail = new Map();
  for (const sub of beehiivSubscribers) {
    const email = subscriberEmail(sub);
    if (!email) continue;
    subscriberByEmail.set(email, sub);
  }

  const matched = [];
  const skipped = [];

  for (const seat of seatRequests) {
    const email = String(seat.email || '').trim().toLowerCase();
    if (!email) {
      skipped.push({ seat_id: seat.seat_id, reason: 'missing_email' });
      continue;
    }

    const subscriber = subscriberByEmail.get(email);
    if (!subscriber) {
      skipped.push({ seat_id: seat.seat_id, email_domain: email.split('@')[1] || null, reason: 'not_in_beehiiv_active' });
      continue;
    }

    if (segmentKey) {
      const tags = normaliseTags(subscriber).map((tag) => tag.toLowerCase());
      if (!tags.includes(segmentKey.toLowerCase())) {
        skipped.push({ seat_id: seat.seat_id, email_domain: email.split('@')[1] || null, reason: 'segment_key_mismatch' });
        continue;
      }
    }

    matched.push({
      seat_id: seat.seat_id,
      email_domain: email.split('@')[1] || null,
      beehiiv_subscription_id: subscriber.id || null,
      status: seat.status,
      cabin_class: seat.cabin_class,
    });
  }

  return { matched, skipped };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const adminSecret = process.env.ADMIN_SECRET;
  const providedSecret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || '';
  if (!adminSecret || !safeCompare(providedSecret, adminSecret)) {
    console.warn('[beehiiv-sync] Unauthorized attempt');
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return json(500, { ok: false, error: 'server_misconfigured', detail: 'Supabase env vars are required' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  const identity = validateBeehiivSyncIdentity(body);
  if (!identity.ok) {
    return json(400, { ok: false, ...identity.details, error: identity.error });
  }

  const input = identity.value;
  const requestId = crypto.randomUUID();
  let auditId = null;

  try {
    const auditRow = await insertAuditRow(supabaseUrl, supabaseKey, {
      request_id: requestId,
      flight_key: input.flight_key,
      flight_id: input.flight_id,
      cohort_id: input.cohort_id,
      segment_key: input.segment_key,
      dry_run: input.dry_run,
      status: 'started',
      boarding_opened_at: input.boarding_opened_at,
      boarding_closed_at: input.boarding_closed_at,
      metadata: {
        phase: 'beehiiv_issue_2',
        invocation: 'netlify/beehiiv-sync',
      },
    });
    auditId = auditRow?.id ?? null;
    if (!auditId) {
      throw new Error('beehiiv_sync_log insert did not return an id');
    }

    const cohortById = await fetchCohortById(supabaseUrl, supabaseKey, input.cohort_id);
    const cohortByFlight = cohortById ? null : await fetchCohortByFlightKey(supabaseUrl, supabaseKey, input.flight_key);
    const cohort = cohortById || cohortByFlight;

    const seatRequests = await fetchSeatRequestsForFlight(supabaseUrl, supabaseKey, input.flight_key);
    const beehiivSubscribers = await listActiveBeehiivSubscribers();
    const audience = buildAudiencePlan(seatRequests, beehiivSubscribers, input.segment_key);

    const liveEnabled = boolEnv('BEEHIIV_SYNC_LIVE_ENABLED', false);
    let status = 'completed';
    let updated = 0;
    let failed = 0;
    let errorMessage = null;
    const metadata = {
      phase: 'beehiiv_issue_2',
      invocation: 'netlify/beehiiv-sync',
      cohort_found: Boolean(cohort),
      cohort_lookup: cohortById ? 'id' : (cohortByFlight ? 'flight_key' : 'none'),
      seat_request_count: seatRequests.length,
      beehiiv_active_count: beehiivSubscribers.length,
      matched_sample: audience.matched.slice(0, 10),
      skipped_sample: audience.skipped.slice(0, 10),
      live_enabled: liveEnabled,
    };

    if (!input.dry_run) {
      if (!liveEnabled) {
        status = 'skipped';
        metadata.skip_reason = 'live_sync_disabled';
      } else {
        status = 'skipped';
        metadata.skip_reason = 'live_mutation_not_implemented';
      }
    }

    await finalizeAuditRow(supabaseUrl, supabaseKey, auditId, {
      status,
      matched: audience.matched.length,
      updated,
      failed,
      skipped: audience.skipped.length,
      error_message: errorMessage,
      metadata,
      completed_at: new Date().toISOString(),
    });

    return json(200, {
      ok: true,
      request_id: requestId,
      audit_id: auditId,
      status,
      dry_run: input.dry_run,
      counts: {
        matched: audience.matched.length,
        updated,
        failed,
        skipped: audience.skipped.length,
      },
      metadata,
    });
  } catch (err) {
    console.error('[beehiiv-sync] failed:', err.message);
    if (auditId) {
      try {
        await finalizeAuditRow(supabaseUrl, supabaseKey, auditId, {
          status: 'failed',
          error_message: err.message,
          metadata: {
            phase: 'beehiiv_issue_2',
            invocation: 'netlify/beehiiv-sync',
          },
          completed_at: new Date().toISOString(),
        });
      } catch (finalizeErr) {
        console.error('[beehiiv-sync] audit finalize failed:', finalizeErr.message);
      }
    }
    return json(500, { ok: false, error: 'sync_failed', detail: err.message, request_id: requestId, audit_id: auditId });
  }
};
