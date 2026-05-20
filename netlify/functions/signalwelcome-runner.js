/**
 * /api/signalwelcome-runner — Netlify Function
 *
 * Publishes the signalwelcome_v1 workflow for the Gemini flight by polling
 * beehiiv active subscribers and sending the SendGrid dynamic template exactly
 * once per subscriber. This replaces paid beehiiv Automation with a controlled
 * SendGrid runner.
 *
 * Safety contracts:
 *   - Cohort gate: wait until at least SIGNALWELCOME_COHORT_SIZE eligible
 *     active subscribers are available before sending. Default: 5.
 *   - Daily cap: never send more than SIGNALWELCOME_DAILY_CAP per UTC day.
 *     Default: 100.
 *   - Duplicate guard: uses beehiiv tags. Subscribers tagged with
 *     SIGNALWELCOME_SENT_TAG are skipped. On successful send, that tag is added.
 *   - Dry-run support: ?dry_run=true or SIGNALWELCOME_DRY_RUN=true prevents
 *     live sends and tag writes.
 *   - Manual trigger protection: non-scheduled invocations require
 *     x-admin-secret = ADMIN_SECRET.
 *   - Scheduled trigger can be disabled with SIGNALWELCOME_ENABLED=false.
 *
 * Required env vars:
 *   BEEHIIV_API_KEY
 *   SENDGRID_API_KEY
 *   SENDGRID_FROM_EMAIL
 *
 * Optional env vars:
 *   SENDGRID_TEMPLATE_WELCOME      — SendGrid dynamic template ID (required)
 *   BEEHIIV_PUB_ID                 — beehiiv publication ID (required)
 *   SENDGRID_FROM_NAME             default Kevin
 *   SIGNALWELCOME_ENABLED          default true
 *   SIGNALWELCOME_DRY_RUN          default false
 *   SIGNALWELCOME_COHORT_SIZE      default 5
 *   SIGNALWELCOME_DAILY_CAP        default 100
 *   SIGNALWELCOME_SENT_TAG         default signalwelcome_v1_sent
 *   SIGNALWELCOME_CANDIDATE_TAG    optional; if set, only subscribers with this tag are eligible
 */

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
  'Content-Type': 'application/json',
};

const DEFAULT_SENT_TAG = 'signalwelcome_v1_sent';
const DEFAULT_COHORT_SIZE = 5;
const DEFAULT_DAILY_CAP = 100;

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function intEnv(name, defaultValue) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function normaliseTags(subscription) {
  const raw = subscription.tags || subscription.subscription_tags || subscription.custom_tags || [];
  if (Array.isArray(raw)) {
    return raw.map((tag) => {
      if (typeof tag === 'string') return tag;
      return tag?.name || tag?.tag || tag?.id || '';
    }).filter(Boolean);
  }
  return [];
}

function getEmail(subscription) {
  return subscription.email || subscription.email_address || subscription.subscriber_email || null;
}

function getFirstName(subscription) {
  if (subscription.first_name) return subscription.first_name;
  const customFields = subscription.custom_fields || [];
  if (Array.isArray(customFields)) {
    const field = customFields.find((f) => ['first_name', 'First Name', 'firstName'].includes(f.name || f.key || f.display));
    if (field?.value) return field.value;
  }
  const email = getEmail(subscription) || '';
  return email.includes('@') ? email.split('@')[0] : 'Traveler';
}

async function beehiivFetch(path, options = {}) {
  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId = process.env.BEEHIIV_PUB_ID;
  if (!pubId) throw new Error('BEEHIIV_PUB_ID is not configured');
  if (!apiKey) throw new Error('BEEHIIV_API_KEY is not configured');
  const url = `https://api.beehiiv.com/v2/publications/${pubId}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
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

async function listActiveSubscriptions(limit = 100) {
  const params = new URLSearchParams({ limit: String(limit), status: 'active' });
  const body = await beehiivFetch(`/subscriptions?${params.toString()}`);
  return Array.isArray(body.data) ? body.data : [];
}

async function applyBeehiivTag(subscriptionId, tag) {
  return beehiivFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tags: [tag] }),
  });
}

async function sendSignalWelcome(subscription) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;
  const fromName = process.env.SENDGRID_FROM_NAME || 'Kevin';
  const templateId = process.env.SENDGRID_TEMPLATE_WELCOME;
  if (!apiKey) throw new Error('SENDGRID_API_KEY is not configured');
  if (!fromEmail) throw new Error('SENDGRID_FROM_EMAIL is not configured');
  if (!templateId) throw new Error('SENDGRID_TEMPLATE_WELCOME is not configured');
  const email = getEmail(subscription);
  if (!email) throw new Error(`Subscription ${subscription.id || 'unknown'} has no email`);
  const firstName = getFirstName(subscription);

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email }],
        dynamic_template_data: {
          first_name: firstName,
          email,
          flight_code: 'FL_051126',
          flight_label: 'Gemini ♊',
        },
      }],
      from: { email: fromEmail, name: fromName },
      template_id: templateId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SendGrid ${res.status}: ${text.slice(0, 500)}`);
  }
  return { email, first_name: firstName };
}

function isScheduledInvocation(event) {
  const headers = event.headers || {};
  const marker = String(headers['x-nf-event'] || headers['X-Nf-Event'] || headers['x-netlify-event'] || headers['X-Netlify-Event'] || '').toLowerCase();
  return marker === 'schedule' || marker === 'scheduled';
}

function isAdminInvocation(event) {
  const expected = process.env.ADMIN_SECRET;
  const headers = event.headers || {};
  const provided = headers['x-admin-secret'] || headers['X-Admin-Secret'];
  return Boolean(expected && provided === expected);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }) };
  }

  const scheduled = isScheduledInvocation(event);
  const admin = isAdminInvocation(event);
  if (!scheduled && !admin) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  }

  const query = event.queryStringParameters || {};
  const enabled = boolEnv('SIGNALWELCOME_ENABLED', true);
  const dryRun = boolEnv('SIGNALWELCOME_DRY_RUN', false) || query.dry_run === 'true';
  const cohortSize = intEnv('SIGNALWELCOME_COHORT_SIZE', DEFAULT_COHORT_SIZE);
  const dailyCap = intEnv('SIGNALWELCOME_DAILY_CAP', DEFAULT_DAILY_CAP);
  const sentTag = process.env.SIGNALWELCOME_SENT_TAG || DEFAULT_SENT_TAG;
  const candidateTag = process.env.SIGNALWELCOME_CANDIDATE_TAG || '';

  if (!enabled && query.force !== 'true') {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, enabled: false, skipped: true, reason: 'disabled' }) };
  }

  try {
    const active = await listActiveSubscriptions(100);
    const eligible = active.filter((sub) => {
      const tags = normaliseTags(sub);
      if (tags.includes(sentTag)) return false;
      if (candidateTag && !tags.includes(candidateTag)) return false;
      return Boolean(getEmail(sub));
    });

    if (eligible.length < cohortSize) {
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          ok: true,
          dry_run: dryRun,
          skipped: true,
          reason: 'cohort_not_ready',
          active_seen: active.length,
          eligible_count: eligible.length,
          cohort_size: cohortSize,
          sent_tag: sentTag,
          day: todayUtc(),
        }),
      };
    }

    const batch = eligible.slice(0, dailyCap);
    const results = [];
    for (const sub of batch) {
      const subId = sub.id || sub.subscription_id;
      if (dryRun) {
        results.push({ subscription_id: subId, email: getEmail(sub), dry_run: true, would_send: true });
        continue;
      }
      try {
        const sent = await sendSignalWelcome(sub);
        if (subId) await applyBeehiivTag(subId, sentTag);
        results.push({ subscription_id: subId, email: sent.email, sent: true, tagged: Boolean(subId) });
      } catch (err) {
        results.push({ subscription_id: subId, email: getEmail(sub), sent: false, error: err.message });
      }
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        template: 'signalwelcome_v1',
        template_id: process.env.SENDGRID_TEMPLATE_WELCOME || null,
        flight_code: 'FL_051126',
        flight_label: 'Gemini ♊',
        dry_run: dryRun,
        active_seen: active.length,
        eligible_count: eligible.length,
        processed_count: results.length,
        daily_cap: dailyCap,
        sent_tag: sentTag,
        day: todayUtc(),
        results,
      }),
    };
  } catch (error) {
    console.error('[signalwelcome-runner]', error.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ ok: false, error: error.message }) };
  }
};
