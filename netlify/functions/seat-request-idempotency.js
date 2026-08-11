/**
 * Gate 3/4 staging handler: idempotent Supabase intake with Base44 fallback.
 * Review only; this does not replace seat-request.js automatically.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Idempotency-Key, X-Request-Id',
};

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function parseJson(value) {
  if (!value || !String(value).trim()) throw new Error('Request body is empty');
  try { return JSON.parse(value); } catch (_) { throw new Error('Request body is invalid JSON'); }
}

function header(event, name) {
  const headers = event.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase configuration is missing');
  return createClient(url, key);
}

function base44Headers() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (apiKey) {
    headers.api_key = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function proxyToBase44(payload) {
  const upstreamUrl = process.env.BASE44_SEAT_REQUEST_URL;
  if (!upstreamUrl) return jsonResponse(400, { ok: false, error: 'Seat request service is not configured' });

  let response;
  try {
    response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: base44Headers(),
      body: JSON.stringify(payload),
    });
  } catch (_) {
    return jsonResponse(502, { ok: false, error: 'Seat request service is unavailable' });
  }

  let data;
  try { data = await response.json(); } catch (_) {
    return jsonResponse(502, { ok: false, error: 'Seat request service returned invalid JSON' });
  }
  return jsonResponse(response.status, { ...data, ok: response.ok });
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed' });

  try {
    const payload = parseJson(event.body);
    const idempotencyKey = String(
      header(event, 'X-Idempotency-Key') || payload.idempotency_key || ''
    ).trim();
    if (!idempotencyKey) return jsonResponse(400, { ok: false, error: 'Idempotency key is required' });
    if (idempotencyKey.length > 255) return jsonResponse(400, { ok: false, error: 'Idempotency key is too long' });

    const requestId = String(header(event, 'X-Request-Id') || '').trim() || null;
    const db = getSupabase();

    const existing = await db
      .from('seat_requests')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing.error) throw existing.error;

    if (existing.data) {
      return jsonResponse(200, {
        ok: true,
        duplicate: true,
        idempotency_key: idempotencyKey,
        seat_request: existing.data,
      });
    }

    const requestRow = {
      passenger_id: payload.passenger_id ?? null,
      cohort_id: payload.cohort_id ?? null,
      seat_id: payload.seat_id ?? null,
      idempotency_key: idempotencyKey,
      source: payload.source || 'seat-request-idempotency',
      status: 'open',
      metadata: { payload, request_id: requestId, intake: 'gate4-staging' },
    };

    const inserted = await db.from('seat_requests').insert(requestRow).select('*').single();
    if (inserted.error) {
      // A concurrent request may have won the unique-key race. Return its row
      // rather than forwarding a duplicate upstream request.
      if (inserted.error.code === '23505') {
        const raced = await db.from('seat_requests').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
        if (!raced.error && raced.data) {
          return jsonResponse(200, { ok: true, duplicate: true, idempotency_key: idempotencyKey, seat_request: raced.data });
        }
      }
      throw inserted.error;
    }

    const eventInsert = await db.from('sendgrid_intake_events').insert({
      event_id: requestId,
      idempotency_key: idempotencyKey,
      event_type: 'seat_request',
      payload,
      status: 'received',
    });
    if (eventInsert.error && eventInsert.error.code !== '42P01') throw eventInsert.error;

    const upstream = await proxyToBase44({ ...payload, idempotency_key: idempotencyKey });
    return {
      ...upstream,
      body: JSON.stringify({
        ...JSON.parse(upstream.body),
        seat_request_id: inserted.data.id,
        idempotency_key: idempotencyKey,
        intake_recorded: true,
      }),
    };
  } catch (error) {
    // Staging fallback preserves the existing proxy behavior if Supabase is
    // unavailable. The response explicitly indicates that DB intake was not
    // recorded so callers can investigate rather than assume Gate 4 passed.
    try {
      const payload = parseJson(event.body);
      const fallback = await proxyToBase44(payload);
      return {
        ...fallback,
        headers: { ...fallback.headers, 'X-Intake-Fallback': 'base44-proxy' },
        body: JSON.stringify({ ...JSON.parse(fallback.body), intake_recorded: false, fallback: true }),
      };
    } catch (_) {
      console.error('[seat-request-idempotency] Internal error:', error?.message || 'unknown');
      return jsonResponse(500, { ok: false, error: 'Internal server error', intake_recorded: false });
    }
  }
};
