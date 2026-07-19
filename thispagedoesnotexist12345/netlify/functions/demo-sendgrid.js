'use strict';

/**
 * /api/demo-sendgrid — secured demo-account SendGrid fan-out
 *
 * Sends the configured demo account a controlled set of TUJ templates using
 * Seat ID TUJ-KC2222 by default. This endpoint is intentionally admin-gated and
 * never exposes the SendGrid API key or target email in responses.
 *
 * Required env vars:
 *   SENDGRID_API_KEY
 *   SENDGRID_FROM_EMAIL
 *   DEMO_ACCOUNT_EMAIL
 *   DEMO_SEND_SECRET or SEC06_INTERNAL_TOKEN
 *
 * Optional env vars:
 *   DEMO_SEAT_ID          default: TUJ-KC2222
 *   DEMO_FIRST_NAME       default: Kevin
 *   DEMO_LAST_NAME        default: Clark
 *   DEMO_FLIGHT_CODE      default: ACTIVE_FLIGHT_CODE || FL_051126
 *   SENDGRID_DEMO_DAILY_LIMIT default: 100
 */

const fs = require('fs');
const path = require('path');
const { TEMPLATES, templateKeyForId } = require('./sendgrid-templates');
const { validateDemoSecret } = require('./shared/sec06-auth.js');

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';
const SEAT_ID_REGEX = /^TUJ-[A-Z2-9]{6}$/;
const URL_OVERRIDE_FIELDS = ['passport_url', 'wheels_up_url', 'unsubscribe_url'];
const TEMPLATE_HTML_DIR = path.join(__dirname, '..', '..', 'sendgrid-templates');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret, X-Demo-Secret',
  'Content-Type': 'application/json',
};

const DEFAULT_TEMPLATE_SEQUENCE = [
  'seat_request_acknowledgement_v1',
  'boarding_confirmation_v1',
  'alphaflightannouncement_v1',
  'boarding_pass_free_v1',
  'boarding_instructions_free_v1',
  'boarding_pass_paid_v1',
  'boarding_instructions_paid_v1',
  'vip_boarding_pass_v1',
  'vip_boarding_instructions_v1',
  'exec_preboard_opentowork_v1',
  'sponsored_approved_v1',
  'next_flight_waitlist_v1',
  'optout_acknowledgement_v1',
  'offer_congrats_v1',
  'alpha_seat_confirm_v1',
  'preboard_nurture_v1',
];

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function safeCompare(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function validateHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed;
  try { parsed = new URL(trimmed); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

function sanitizeUrlOverrides(input) {
  const overrides = {};
  const errors = [];
  if (input == null || typeof input !== 'object') return { overrides, errors };
  for (const field of URL_OVERRIDE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const raw = input[field];
    const safe = validateHttpUrl(raw);
    if (!safe) errors.push(field);
    else overrides[field] = safe;
  }
  return { overrides, errors };
}

function renderTemplateHtml(templateKey, dynamicData) {
  try {
    const filePath = path.join(TEMPLATE_HTML_DIR, `${templateKey}.html`);
    const html = fs.readFileSync(filePath, 'utf8');
    return html.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      const value = dynamicData[key];
      return value == null ? '' : String(value);
    });
  } catch {
    return null;
  }
}

function extractHrefs(html) {
  if (typeof html !== 'string') return [];
  const matches = [];
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) matches.push(m[1]);
  return matches;
}

function sanitizeTemplateKeys(input) {
  if (!Array.isArray(input) || input.length === 0) return DEFAULT_TEMPLATE_SEQUENCE;
  return input
    .map((value) => String(value || '').trim())
    .filter((value) => value && DEFAULT_TEMPLATE_SEQUENCE.includes(value));
}

function buildDynamicData({ seatId, firstName, lastName, email, flightCode, siteUrl, overrides = {} }) {
  const canonicalFlightId = String(flightCode || '').replace(/ /g, '_');
  const passportUrl = `${siteUrl}/OnboardingPassport?seat_id=${seatId}&tuj_code=${seatId}`;
  const studioUrl = `${siteUrl}/Studio?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}`;
  const techUrl = 'https://www.thispagedoesnotexist12345.tech';
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const defaultWheelsUpUrl = process.env.BEEHIIV_GIFT_LINK_URL
    || `https://newsletter.thispagedoesnotexist12345.us/p/${canonicalFlightId.toLowerCase()}`;
  const defaultUnsubscribeUrl = '<%asm_group_unsubscribe_raw_url%>';

  const data = {
    subject: `Demo boarding pass — ${flightCode}`,
    first_name: firstName,
    last_name: lastName,
    full_name: `${firstName} ${lastName}`.trim(),
    name: `${firstName} ${lastName}`.trim(),
    passenger_name: `${firstName} ${lastName}`.trim(),
    email,
    user_email: email,
    seat_id: seatId,
    seatreference: seatId,
    tuj_code: seatId,
    pid: `PID-${seatId.replace(/^TUJ-/, '')}`,
    source: 'demo-sendgrid',
    tier: 'demo',
    cabin_tier: 'First',
    cabin_class: 'First',
    signup_date: today,
    request_date: new Date().toISOString(),
    departure_date: today,
    flight_code: flightCode,
    flight_id: flightCode,
    flight_display_name: flightCode,
    passport_url: passportUrl,
    wheels_up_url: defaultWheelsUpUrl,
    unsubscribe_url: defaultUnsubscribeUrl,
    dashboard_url: passportUrl,
    platform_url: siteUrl,
    signal_url: 'https://newsletter.thispagedoesnotexist12345.us/',
    first_task_url: passportUrl,
    secondary_url: studioUrl,
    board_now_url: `${siteUrl}/OnboardingPassport?seat_id=${seatId}&tuj_code=${seatId}`,
    mission_studio: studioUrl,
    mission_passengers: `${techUrl}/Passengers?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}`,
    mission_flight_log: `${techUrl}/FlightLog?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}`,
    mission_applications: `${techUrl}/Applications?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}`,
    mission_reminders: `${techUrl}/FlightLog?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}&view=reminders`,
    mission_interviews: `${techUrl}/InterviewsAndFollowUps?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}`,
    mission_dashboard: `${techUrl}/Dashboard?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}`,
    mission_command: `${techUrl}/CommandCenter?seat_id=${seatId}&tuj_code=${seatId}&flight_id=${canonicalFlightId}`,
    seats_available: 1,
    departure_airport: 'Mission Control',
    arrival_airport: 'Career Clarity',
    departure_time: 'Demo Window',
    boarding_group: 'Demo — Group 1',
    seat_assignment: seatId,
    gate: 'Mission Control',
    boarding_open_time: 'Now',
    boarding_close_time: 'Demo only',
    career_stage: 'Active Job Seeker',
  };

  for (const field of URL_OVERRIDE_FIELDS) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, field)) {
      data[field] = overrides[field];
    }
  }
  return data;
}

async function sendTemplate({ apiKey, fromEmail, toEmail, templateId, dynamicData, asm }) {
  const response = await fetch(SENDGRID_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: { email: fromEmail },
      personalizations: [{
        to: [{ email: toEmail }],
        dynamic_template_data: dynamicData,
      }],
      template_id: templateId,
      ...(asm ? { asm } : {}),
    }),
  });

  const text = response.ok || response.status === 202 ? '' : await response.text();
  return {
    ok: response.ok || response.status === 202,
    status: response.status,
    error: text ? text.slice(0, 500) : undefined,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });

  if (!validateDemoSecret(event)) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const renderOnly = body.render_only === true || body.dry_run === true;

  const apiKey = process.env.SENDGRID_API_KEY || '';
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || '';
  const toEmail = process.env.DEMO_ACCOUNT_EMAIL || '';
  if (!renderOnly) {
    if (!apiKey) return json(500, { ok: false, error: 'SENDGRID_API_KEY is not configured' });
    if (!fromEmail) return json(500, { ok: false, error: 'SENDGRID_FROM_EMAIL is not configured' });
    if (!toEmail) return json(500, { ok: false, error: 'DEMO_ACCOUNT_EMAIL is not configured' });
  }

  const seatId = String(body.seat_id || process.env.DEMO_SEAT_ID || 'TUJ-KC2222').trim().toUpperCase();
  if (!SEAT_ID_REGEX.test(seatId)) return json(400, { ok: false, error: 'Invalid demo seat_id format' });

  const requestedTemplates = sanitizeTemplateKeys(body.templates);
  const dailyLimit = Number.parseInt(process.env.SENDGRID_DEMO_DAILY_LIMIT || '100', 10);
  if (requestedTemplates.length > dailyLimit) {
    return json(400, { ok: false, error: `Template request exceeds SENDGRID_DEMO_DAILY_LIMIT (${dailyLimit})` });
  }

  const firstName = String(body.first_name || process.env.DEMO_FIRST_NAME || 'Kevin').trim() || 'Kevin';
  const lastName = String(body.last_name || process.env.DEMO_LAST_NAME || 'Clark').trim() || 'Clark';
  const flightCode = String(body.flight_code || process.env.DEMO_FLIGHT_CODE || process.env.ACTIVE_FLIGHT_CODE || 'FL_051126').trim();
  const siteUrl = String(process.env.SITE_URL || 'https://www.thispagedoesnotexist12345.com').replace(/\/$/, '');

  const { overrides, errors: overrideErrors } = sanitizeUrlOverrides(body.url_overrides || body);
  if (overrideErrors.length) {
    return json(400, { ok: false, error: `Invalid URL override(s): ${overrideErrors.join(', ')}. Must be http(s) URL.` });
  }

  const dynamicData = buildDynamicData({ seatId, firstName, lastName, email: toEmail, flightCode, siteUrl, overrides });

  if (renderOnly) {
    const previews = requestedTemplates.map((key) => {
      const templateId = TEMPLATES[key] || null;
      const html = renderTemplateHtml(key, dynamicData);
      const hrefs = extractHrefs(html);
      const preview = {
        template_key: key,
        template_id: templateId,
        dynamic_data: dynamicData,
        rendered: Boolean(html),
        href_count: hrefs.length,
        hrefs,
      };
      if (key === 'boarding_pass_free_v1') {
        preview.cta = {
          primary_cta: { label: 'Mission Control', href: dynamicData.passport_url, field: 'passport_url' },
          secondary_cta: { label: 'Read your wheels-up briefing', href: dynamicData.wheels_up_url, field: 'wheels_up_url' },
          unsubscribe: { href: dynamicData.unsubscribe_url, field: 'unsubscribe_url' },
        };
      }
      return preview;
    });

    return json(200, {
      ok: true,
      render_only: true,
      seat_id: seatId,
      flight_code: flightCode,
      recipient: toEmail ? toEmail.replace(/^(.).+(@.+)$/, '$1***$2') : null,
      templates: requestedTemplates,
      overrides_applied: overrides,
      previews,
    });
  }

  const asmGroupId = Number.parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_TRANSACTIONAL || '33047', 10);
  const asmMarketingGroupId = process.env.SENDGRID_UNSUBSCRIBE_GROUP_MARKETING ? Number.parseInt(process.env.SENDGRID_UNSUBSCRIBE_GROUP_MARKETING, 10) : null;
  const asm = Number.isFinite(asmGroupId)
    ? { group_id: asmGroupId, groups_to_display: asmMarketingGroupId ? [asmGroupId, asmMarketingGroupId] : [asmGroupId] }
    : null;

  const results = [];
  for (const key of requestedTemplates) {
    const templateId = TEMPLATES[key];
    if (!templateId) {
      results.push({ template_key: key, ok: false, skipped: true, error: 'Template ID is not configured' });
      continue;
    }
    try {
      const result = await sendTemplate({ apiKey, fromEmail, toEmail, templateId, dynamicData, asm });
      results.push({ template_key: key, template_id: templateId, resolved_key: templateKeyForId(templateId), ...result });
    } catch (err) {
      results.push({ template_key: key, template_id: templateId, ok: false, error: err.message || 'Unexpected send error' });
    }
  }

  const sent = results.filter((row) => row.ok).length;
  const failed = results.filter((row) => !row.ok && !row.skipped).length;
  const skipped = results.filter((row) => row.skipped).length;

  return json(failed ? 207 : 200, {
    ok: failed === 0,
    seat_id: seatId,
    recipient: toEmail.replace(/^(.).+(@.+)$/, '$1***$2'),
    requested: requestedTemplates.length,
    sent,
    failed,
    skipped,
    results,
  });
};
