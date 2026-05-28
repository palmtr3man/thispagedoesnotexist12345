/**
 * /api/mission-control-bind — Admin-only Supabase Mission Control binding helper
 *
 * Purpose:
 *   Supports the approved binding gate before any boarding-pass resend. This
 *   endpoint can run a dry-run audit or call the Supabase RPC
 *   bind_subject_at_mission_control() for selected passengers, then return the
 *   audit-view evidence. It never triggers SendGrid.
 *
 * Required env vars:
 *   SEC06_INTERNAL_TOKEN
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Request body:
 *   {
 *     dry_run?: boolean,              // default true
 *     flight_code?: string,           // default ACTIVE_FLIGHT_CODE / ACTIVE_FLIGHT_ID
 *     completed_by?: string,          // default mission-control
 *     operator_note?: string,
 *     subjects: [{ email?: string, seat_id?: string }]
 *   }
 */

const { validateAdminHeader } = require('./shared/sec06-auth.js');

const HEADERS = {
  'Access-Control-Allow-Origin': process.env.ADMIN_ORIGIN || 'https://thispagedoesnotexist12345.net',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, x-internal-token',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

function normalizeFlightCode(value) {
  return String(value || '').trim().replace(/\s+/g, '_');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSeatId(value) {
  return String(value || '').trim().replace(/\s+/g, '_').toUpperCase();
}

function getSubjectKey(subject) {
  return subject.email ? `email:${normalizeEmail(subject.email)}` : `seat:${normalizeSeatId(subject.seat_id)}`;
}

function validateSubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) return 'subjects must be a non-empty array';
  if (subjects.length > 25) return 'subjects may contain at most 25 passengers per request';
  for (const subject of subjects) {
    const email = normalizeEmail(subject?.email || '');
    const seatId = normalizeSeatId(subject?.seat_id || '');
    if (!email && !seatId) return 'each subject requires email or seat_id';
    if (seatId && !/^TUJ-[A-Z0-9]{4,}$/.test(seatId)) return `invalid seat_id: ${seatId}`;
  }
  return null;
}

function supabaseHeaders(serviceRoleKey, prefer = 'return=representation') {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  };
}

function buildAuditUrl(supabaseUrl, subjects) {
  const select = 'waitlist_submission_id,email,first_name,seat_id,flight_binding_status,waitlist_flight_code,seat_request_flight_code,canonical_flight_code,binding_status,waitlist_updated_at,seat_request_updated_at';
  const filters = subjects.map((subject) => {
    const parts = [];
    const email = normalizeEmail(subject.email || '');
    const seatId = normalizeSeatId(subject.seat_id || '');
    if (email) parts.push(`email.eq.${email}`);
    if (seatId) parts.push(`seat_id.eq.${seatId}`);
    return parts.join(',');
  }).filter(Boolean).join(',');
  const url = new URL(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/v_passenger_flight_binding_audit`);
  url.searchParams.set('select', select);
  if (filters) url.searchParams.set('or', `(${filters})`);
  url.searchParams.set('order', 'waitlist_updated_at.desc.nullslast');
  return url.toString();
}

async function fetchAudit({ supabaseUrl, serviceRoleKey, subjects }) {
  const res = await fetch(buildAuditUrl(supabaseUrl, subjects), {
    method: 'GET',
    headers: supabaseHeaders(serviceRoleKey),
  });
  const body = await res.json().catch(async () => ({ error: await res.text().catch(() => '') }));
  if (!res.ok) {
    const err = new Error(`Supabase audit failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return Array.isArray(body) ? body : [];
}

async function bindSubject({ supabaseUrl, serviceRoleKey, subject, flightCode, completedBy, operatorNote }) {
  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/bind_subject_at_mission_control`, {
    method: 'POST',
    headers: supabaseHeaders(serviceRoleKey),
    body: JSON.stringify({
      p_email: normalizeEmail(subject.email || '') || null,
      p_seat_id: normalizeSeatId(subject.seat_id || '') || null,
      p_flight_code: flightCode,
      p_completed_by: completedBy,
      p_operator_note: operatorNote,
    }),
  });
  const body = await res.json().catch(async () => ({ error: await res.text().catch(() => '') }));
  if (!res.ok) {
    return { ok: false, subject: getSubjectKey(subject), status: res.status, error: body };
  }
  return { ok: true, subject: getSubjectKey(subject), result: body };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  if (!validateAdminHeader(event)) {
    return json(401, { ok: false, error: 'Unauthorized' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'invalid_json_body' });
  }

  const subjects = payload.subjects || [];
  const subjectError = validateSubjects(subjects);
  if (subjectError) return json(400, { ok: false, error: subjectError });

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceRoleKey) return json(500, { ok: false, error: 'Supabase configuration missing' });

  const dryRun = payload.dry_run !== false;
  const flightCode = normalizeFlightCode(payload.flight_code || process.env.ACTIVE_FLIGHT_CODE || process.env.ACTIVE_FLIGHT_ID || 'FL_051126');
  const completedBy = String(payload.completed_by || 'mission-control').trim() || 'mission-control';
  const operatorNote = String(payload.operator_note || '').trim() || `Mission Control binding gate for ${flightCode}`;

  let before = [];
  try {
    before = await fetchAudit({ supabaseUrl, serviceRoleKey, subjects });
  } catch (err) {
    return json(err.status || 502, { ok: false, error: 'audit_before_failed', detail: err.message, body: err.body || null });
  }

  const bindingResults = [];
  if (!dryRun) {
    for (const subject of subjects) {
      bindingResults.push(await bindSubject({ supabaseUrl, serviceRoleKey, subject, flightCode, completedBy, operatorNote }));
    }
  }

  let after = before;
  if (!dryRun) {
    try {
      after = await fetchAudit({ supabaseUrl, serviceRoleKey, subjects });
    } catch (err) {
      return json(err.status || 502, { ok: false, error: 'audit_after_failed', binding_results: bindingResults, detail: err.message, body: err.body || null });
    }
  }

  const unresolved = after.filter((row) => row.binding_status !== 'ok' || row.canonical_flight_code !== flightCode);
  return json(200, {
    ok: true,
    dry_run: dryRun,
    flight_code: flightCode,
    subjects: subjects.map(getSubjectKey),
    before,
    binding_results: bindingResults,
    after,
    unresolved_count: unresolved.length,
    unresolved,
    sendgrid_triggered: false,
  });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports.handler = exports.handler;
}
