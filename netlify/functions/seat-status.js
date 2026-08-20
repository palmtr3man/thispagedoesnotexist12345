/**
 * seat-status.js — Netlify Function (Master Registry Version)
 * 
 * Dynamically queries the Supabase flight_registry for the active cohort.
 */

const { createClient } = require('@supabase/supabase-js');

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function jsonResponse(statusCode, payload, extraHeaders = {}) { return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(payload) }; }
function getSupabaseUrl() { return process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''; }
function getSupabaseServiceKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.APP_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''; }
function getSupabaseClient() { const url = getSupabaseUrl(); const key = getSupabaseServiceKey(); if (!url || !key) throw new Error('Supabase configuration is missing'); return createClient(url, key); }

const SEAT_ID_REGEX = /^TUJ-[A-Z2-9]{6}$/;
const SEAT_STATUSES = new Set(['pending', 'approved', 'opened', 'denied']);
function normalizeSeatStatus(value) { const normalized = String(value || '').trim().toLowerCase(); return SEAT_STATUSES.has(normalized) ? normalized : 'unknown'; }
function seatStatusMetadata(status) { const metadata = { pending: { label: 'Pending', category: 'pending', countsAsApproved: false, countsAsOpened: false, countsAsOccupied: false }, approved: { label: 'Approved', category: 'approved', countsAsApproved: true, countsAsOpened: false, countsAsOccupied: true }, opened: { label: 'Opened', category: 'opened', countsAsApproved: true, countsAsOpened: true, countsAsOccupied: true }, denied: { label: 'Denied', category: 'denied', countsAsApproved: false, countsAsOpened: false, countsAsOccupied: false }, unknown: { label: 'Unknown', category: 'unknown', countsAsApproved: false, countsAsOpened: false, countsAsOccupied: false } }; return metadata[status] || metadata.unknown; }

const LOOKUP_TIMEOUT_MS = 2500;
const UPSTREAM_TIMEOUT_MS = 3000;

function timeoutPromise(promise, ms, defaultValue) { return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(defaultValue), ms))]); }
const BASE44_APP_ID = '67912f60b0c40c4f1a48d1c7';

async function getActiveFlightRegistry(supabase) {
  try {
    const { data, error } = await timeoutPromise(
      supabase
      .from('flight_registry')
      .select('base44_status_url, gate_status, flight_code')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),
      2500,
      { data: null, error: new Error("Active flight registry lookup timed out") },
    );
    
    if (error) {
      console.error('[registry] Error fetching active flight:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[registry] Catch error:', err.message);
    return null;
  }
}

function base44Headers() {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
    headers.api_key = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function normalizeBase44EntityUrl(rawUrl, entityName) {
  const value = String(rawUrl || '').trim().replace(/\/$/, '');
  if (!value) return value;
  if (value.includes('api.base44.com/api/apps/')) return value;
  if (value.includes('.base44.app/api/') || value.includes('app.base44.com/api/')) {
    return `https://api.base44.com/api/apps/${BASE44_APP_ID}/entities/${entityName}`;
  }
  return value;
}

function pickEntityRecord(data) {
  if (Array.isArray(data)) return data[0] || null;
  if (Array.isArray(data?.items)) return data.items[0] || null;
  if (Array.isArray(data?.data)) return data.data[0] || null;
  if (Array.isArray(data?.results)) return data.results[0] || null;
  return data || null;
}

async function fetchBase44Record(baseUrl, id, lookupField = 'id') {
  if (!baseUrl || !id) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const url = lookupField === 'id'
      ? `${baseUrl}/${encodeURIComponent(id)}`
      : `${baseUrl}?${encodeURIComponent(lookupField)}=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: base44Headers(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('Seat enrichment upstream error');
    return pickEntityRecord(await res.json());
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function deriveResumeFitCheckStatus(user) {
  if (!user) return 'unknown';
  if (user.passport_completed_at) return 'complete';
  if (user.highest_ats_score && user.highest_ats_score > 0) return 'in_progress';
  return 'not_started';
}

function resolveFlightCode(data, registryCode) {
  // Priority 1: Registry Code (Source of Truth)
  if (registryCode) return registryCode.replace(/ /g, '_');
  
  const raw =
    (data.flight_code && String(data.flight_code).trim()) ||
    (data.flight_id && String(data.flight_id).trim()) ||
    null;
  if (!raw) return null;
  return raw.replace(/ /g, '_');
}

function resolveProgramMode(rawMode) {
  const normalized = String(rawMode || '').trim();
  if (!normalized) return null;
  return normalized.toUpperCase().replace(/[\s-]+/g, '_');
}

function getProgramModeMeta(programMode) {
  if (!programMode) return { label: '', variant: 'active' };
  return {
    label: programMode.replace(/_/g, ' '),
    variant: programMode === 'AWAITING_CLEARANCE' ? 'neutral' : 'active',
  };
}

function ensureStableModeFields(data) {
  const upstreamMode = data.program_mode || data.programMode || null;
  const programMode = resolveProgramMode(upstreamMode);
  const modeMeta = getProgramModeMeta(programMode);

  if (programMode) {
    data.program_mode = data.program_mode || programMode;
    data.mode = data.mode || modeMeta.label;
    data.mode_variant = data.mode_variant || modeMeta.variant;
  }
}

exports.handler = async function handler(event) {
  if ((event.httpMethod || '').toUpperCase() === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  if ((event.httpMethod || '').toUpperCase() !== 'GET') return jsonResponse(405, { gate_status: 'closed', seat_status: 'unknown', seat_status_meta: seatStatusMetadata('unknown'), error: 'Method not allowed' });

  try {
    const supabase = getSupabaseClient();
    // ── 0. Registry Lookup ───────────────────────────────────────────────
    const registry = await getActiveFlightRegistry(supabase);
    const upstreamUrl = registry?.base44_status_url || process.env.BASE44_COHORT_STATUS_URL;
    
    if (!upstreamUrl) throw new Error("No upstream cohort status URL found.");

    // ── 1. Proxy getCohortStatus ───────────────────────────────────────────
    const upstreamController = new AbortController();
    const upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(upstreamUrl, {
        method: 'GET',
        headers: base44Headers(),
        signal: upstreamController.signal,
      });
    } finally {
      clearTimeout(upstreamTimer);
    }
    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const data = await res.json();

    // ── 2. Registry Overrides ─────────────────────────────────────────────
    if (registry?.gate_status) {
      data.gate_status = registry.gate_status;
    }
    
    // F-HIER-01: registry code is the master override
    data.flight_code = resolveFlightCode(data, registry?.flight_code);
    if (registry?.flight_code) {
      data.flight_id = registry.flight_code;
    }

    // ── 3. ALPHA_MODE override ─────────────────────────────────────────────
    const alphaModeEnv = String(process.env.ALPHA_MODE || '').toLowerCase();
    if (alphaModeEnv === 'false') {
      data.alpha_mode = false;
    }

    ensureStableModeFields(data);

    // ── 5. BLOCKER-05-FU: resume_fit_check_status enrichment ──────────────
    const qp = event.queryStringParameters || {};
    let rawSeatId = (qp.seat_id || qp.id || '').replace(/ /g, '_').trim();

    let resume_fit_check_status = 'unknown';
    let seat_status = 'unknown';

    if (rawSeatId && SEAT_ID_REGEX.test(rawSeatId)) {
      const base44SeatUrl = normalizeBase44EntityUrl(process.env.BASE44_SEAT_URL, 'Seat');
      const base44UserUrl = normalizeBase44EntityUrl(process.env.BASE44_USER_URL, 'User');

      if (base44SeatUrl && base44UserUrl) {
        const seat = await fetchBase44Record(base44SeatUrl, rawSeatId, 'tuj_code');
        if (seat) {
          seat_status = normalizeSeatStatus(seat.status);

          const seatEmail = String(seat.user_email || seat.email || seat.passenger_email || '').trim().toLowerCase();
          if (seatEmail) data.passenger_email = seatEmail;

          if (seat.user_id) {
            const user = await fetchBase44Record(base44UserUrl, seat.user_id);
            resume_fit_check_status = deriveResumeFitCheckStatus(user);
          } else {
            resume_fit_check_status = 'not_started';
          }
        }
      }
    }

    data.resume_fit_check_status = resume_fit_check_status;
    data.seat_status = seat_status;
    data.seat_status_meta = seatStatusMetadata(seat_status);
    data.registry_synced = !!registry;

    return {
      ...jsonResponse(200, data, { 'Cache-Control': 'no-cache' }),
    };
  } catch (err) {
    return {
      ...jsonResponse(502, { gate_status: 'closed', seat_status: 'unknown', seat_status_meta: seatStatusMetadata('unknown'), error: 'Seat status service unavailable' }),
    };
  }
};
