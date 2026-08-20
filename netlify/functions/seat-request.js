/**
 * seat-request.js — Netlify Function (Self-Contained)
 * 
 * Proxies seat request submissions to the Base44 upstream service.
 * Fully self-contained with no dynamic imports from ./lib/.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function parseJson(value, label) {
  if (!value || !String(value).trim()) throw new Error(`${label} is empty`);
  try { return JSON.parse(value); } catch (_) { throw new Error(`${label} is invalid JSON`); }
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

exports.handler = async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const upstreamUrl = process.env.BASE44_SEAT_REQUEST_URL;
    if (!upstreamUrl) return jsonResponse(400, { ok: false, error: 'Seat request service is not configured' });

    const payload = parseJson(event.body, 'Request body');
    let res;
    try {
      res = await fetch(upstreamUrl, {
        method: 'POST',
        headers: base44Headers(),
        body: JSON.stringify(payload),
      });
    } catch (_) {
      return jsonResponse(502, { ok: false, error: 'Seat request service is unavailable' });
    }

    let data;
    try { data = await res.json(); } catch (_) {
      return jsonResponse(502, { ok: false, error: 'Seat request service returned invalid JSON' });
    }

    return jsonResponse(res.status, { ...data, ok: res.ok });
  } catch (err) {
    if (err && (err.message === 'Request body is empty' || err.message === 'Request body is invalid JSON')) {
      return jsonResponse(400, { ok: false, error: err.message });
    }
    console.error('[seat-request] Internal error:', err && err.message ? err.message : 'unknown');
    return jsonResponse(500, { ok: false, error: 'Internal server error' });
  }
};
