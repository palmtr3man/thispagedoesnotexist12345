/**
 * Gate 3/4 staging handler: idempotent Supabase intake with Base44 fallback.
 * Review only; this does not replace seat-request.js automatically.
 *
 * Security notes:
 * - Every request requires the same signed age token used by seat-request.js.
 * - Duplicate responses are deliberately sanitized and never expose stored metadata.
 * - Header names are handled case-insensitively and conflicting credentials are rejected.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAgeToken } = require('./verify-age');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Idempotency-Key, X-Request-Id',
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

function getHeader(event, name) {
  const headers = event.headers || {};
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchingKey ? String(headers[matchingKey] || '').trim() : '';
}

function getAuthenticatedAgeToken(event, payload) {
  const bodyToken = typeof payload.age_token === 'string' ? payload.age_token.trim() : '';
  const authorization = getHeader(event, 'Authorization');
  let bearerToken = '';

  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match || !match[1].trim()) throw new Error('Invalid authorization header');
    bearerToken = match[1].trim();
  }

  if (bodyToken && bearerToken && bodyToken !== bearerToken) {
    throw new Error('Conflicting authentication tokens');
  }

  const token = bodyToken || bearerToken;
  const secret = process.env.AGE_TOKEN_SECRET;
  if (!secret || !token) throw new Error('Age verification required');

  const verified = verifyAgeToken(token, secret);
  if (!verified || !verified.verified) throw new Error('Age verification required');
  return token;
}

function getIdempotencyKey(event, payload) {
  const headerKey = getHeader(event, 'X-Idempotency-Key');
  const bodyKey = typeof payload.idempotency_key === 'string' ? payload.idempotency_key.trim() : '';
  if (headerKey && bodyKey && headerKey !== bodyKey) throw new Error('Conflicting idempotency keys');
  const key = headerKey || bodyKey;
  if (!key) throw new Error('Idempotency key is required');
  if (key.length > 255) throw new Error('Idempotency key is too long');
  return key;
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

function duplicateResponse(row, idempotencyKey) {
  // Never return metadata or the original payload from a duplicate lookup.
  return jsonResponse(200, {
    ok: true,
    duplicate: true,
    idempotency_key: idempotencyKey,
    seat_request: {
      id: row.id,
      status: row.status,
    },
  });
}

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed' });

  let payload;
  try {
    payload = parseJson(event.body);
    // Authenticate before any idempotency lookup or other database access.
    getAuthenticatedAgeToken(event, payload);
    const idempotencyKey = getIdempotencyKey(event, payload);
    const requestId = getHeader(event, 'X-Request-Id') || null;
    const db = getSupabase();

    const existing = await db
      .from('seat_requests')
      .select('id, status')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing.error) throw existing.error;

    if (existing.data) return duplicateResponse(existing.data, idempotencyKey);

    const requestRow = {
      passenger_id: payload.passenger_id ?? null,
      cohort_id: payload.cohort_id ?? null,
      seat_id: payload.seat_id ?? null,
      idempotency_key: idempotencyKey,
      source: payload.source || 'seat-request-idempotency',
      status: 'open',
      metadata: { payload, request_id: requestId, intake: 'gate4-staging' },
    };

    const inserted = await db.from('seat_requests').insert(requestRow).select('id, status').single();
    if (inserted.error) {
      // A concurrent request may have won the unique-key race. Return only a
      // sanitized result rather than forwarding a duplicate upstream request.
      if (inserted.error.code === '23505') {
        const raced = await db.from('seat_requests').select('id, status').eq('idempotency_key', idempotencyKey).maybeSingle();
        if (!raced.error && raced.data) return duplicateResponse(raced.data, idempotencyKey);
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
    // Authentication failures must never fall through to the upstream proxy.
    if (error?.message === 'Age verification required' ||
        error?.message === 'Invalid authorization header' ||
        error?.message === 'Conflicting authentication tokens') {
      return jsonResponse(401, { ok: false, error: 'Authentication required' });
    }
    if (error?.message === 'Idempotency key is required' ||
        error?.message === 'Idempotency key is too long' ||
        error?.message === 'Conflicting idempotency keys') {
      return jsonResponse(400, { ok: false, error: error.message });
    }

    // Staging fallback preserves the existing proxy behavior if Supabase is
    // unavailable. Authentication has already succeeded before this point.
    try {
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
