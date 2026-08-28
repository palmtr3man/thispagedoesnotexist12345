/**
 * bmac-webhook — Netlify Function
 *
 * Receives Buy Me a Coffee payment webhooks, verifies HMAC-SHA256, and
 * propagates cabin entitlement to Base44 (Option A contract).
 *
 * Route: POST /.netlify/functions/bmac-webhook
 *
 * Required env:
 *   BMAC_WEBHOOK_SECRET — HMAC secret from BMAC webhook settings
 *   BASE44_APP_ID       — Base44 app id for entity API calls
 *   BASE44_API_KEY / BASE44APIKEY / BASE44_AUTH_JSON — service auth
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

type BmacPayload = Record<string, unknown>;
type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
};

const EVENTS = new Set(['supporter.created', 'membership.started', 'membership.updated']);
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-bmac-signature',
  'Content-Type': 'application/json',
};

function jsonResponse(statusCode: number, payload: unknown) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(payload) };
}

function header(event: LambdaEvent, name: string): string {
  const headers = event.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || '').trim();
}

function resolveBase44ApiKey(): string {
  const direct = process.env.BASE44APIKEY || process.env.BASE44_API_KEY || '';
  if (direct) return direct;
  const raw = process.env.BASE44_AUTH_JSON;
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { apiKey?: string; api_key?: string };
    return String(parsed.apiKey || parsed.api_key || '').trim();
  } catch {
    return '';
  }
}

function base44Headers(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const apiKey = resolveBase44ApiKey();
  if (apiKey) headers.api_key = apiKey;
  return headers;
}

function entityUrl(entityName: string): string {
  const appId = String(process.env.BASE44_APP_ID || '').trim();
  if (!appId) throw new Error('BASE44_APP_ID is not configured');
  return `https://app.base44.com/api/apps/${appId}/entities/${entityName}`;
}

function pickArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as T[];
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.results)) return obj.results as T[];
  }
  return [];
}

function normalizeBmacPayload(payload: BmacPayload) {
  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  const supporter = (data.supporter as Record<string, unknown> | undefined) ?? {};
  const email = String(
    payload.supporter_email ?? supporter.email ?? data.email ?? '',
  )
    .trim()
    .toLowerCase();
  const eventType = String(payload.type ?? payload.event_type ?? data.type ?? '')
    .trim()
    .toLowerCase();
  const eventId = String(
    payload.id ?? payload.event_id ?? payload.eventId ?? data.id ?? data.event_id ?? '',
  ).trim();
  return { email, eventType, eventId, data };
}

function verifyHmacSha256(rawBody: string, event: LambdaEvent) {
  const secret = String(process.env.BMAC_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return { ok: false as const, response: jsonResponse(500, { error: 'server_misconfigured', detail: 'BMAC_WEBHOOK_SECRET is required' }) };
  }

  const signatureHeader = header(event, 'x-bmac-signature');
  if (!signatureHeader) {
    return { ok: false as const, response: jsonResponse(401, { error: 'missing_identity', detail: 'x-bmac-signature is required' }) };
  }

  const [algorithm, receivedHex] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !receivedHex) {
    return { ok: false as const, response: jsonResponse(403, { error: 'insufficient_role', detail: 'x-bmac-signature format is invalid' }) };
  }

  const computedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(computedHex, 'utf8');
  const b = Buffer.from(receivedHex, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false as const, response: jsonResponse(403, { error: 'insufficient_role', detail: 'x-bmac-signature is invalid' }) };
  }

  return { ok: true as const };
}

async function filterEntity<T extends Record<string, unknown>>(
  entityName: string,
  filter: Record<string, unknown>,
): Promise<T[]> {
  const url = new URL(entityUrl(entityName));
  for (const [key, value] of Object.entries(filter)) {
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url.toString(), { method: 'GET', headers: base44Headers() });
  if (!res.ok) throw new Error(`Base44 filter ${entityName} failed: ${res.status}`);
  return pickArray<T>(await res.json());
}

async function createEntity<T extends Record<string, unknown>>(
  entityName: string,
  fields: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(entityUrl(entityName), {
    method: 'POST',
    headers: base44Headers(),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Base44 create ${entityName} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function updateEntity(
  entityName: string,
  id: string,
  fields: Record<string, unknown>,
  existing?: Record<string, unknown>,
) {
  const res = await fetch(`${entityUrl(entityName)}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: base44Headers(),
    body: JSON.stringify({ ...(existing || {}), ...fields }),
  });
  if (!res.ok) throw new Error(`Base44 update ${entityName} failed: ${res.status}`);
  return res.json();
}

async function claimBmacEvent(eventId: string, handler: string, payload: BmacPayload) {
  if (!eventId) throw new Error('Missing BMAC event ID');
  try {
    const row = await createEntity<Record<string, unknown>>('BmacWebhookEvent', {
      event_id: eventId,
      handler,
      status: 'processing',
      payload,
      claimed_at: new Date().toISOString(),
    });
    return { claimed: true, row };
  } catch (error) {
    const rows = await filterEntity<Record<string, unknown>>('BmacWebhookEvent', {
      event_id: eventId,
      handler,
    });
    const existing = rows[0];
    if (existing?.status === 'completed') return { claimed: false, duplicate: true, row: existing };
    if (existing?.status === 'processing') return { claimed: false, inFlight: true, row: existing };
    if (existing?.id) {
      await updateEntity('BmacWebhookEvent', String(existing.id), {
        status: 'processing',
        claimed_at: new Date().toISOString(),
        last_error: null,
      }, existing);
      return { claimed: true, row: existing };
    }
    throw error;
  }
}

async function completeBmacEvent(row: Record<string, unknown>, result?: unknown) {
  await updateEntity('BmacWebhookEvent', String(row.id), {
    status: 'completed',
    completed_at: new Date().toISOString(),
    result: result ?? null,
  }, row);
}

async function failBmacEvent(row: Record<string, unknown>, error: unknown) {
  await updateEntity('BmacWebhookEvent', String(row.id), {
    status: 'failed',
    failed_at: new Date().toISOString(),
    last_error: error instanceof Error ? error.message : String(error),
  }, row);
}

export async function handler(event: LambdaEvent) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let row: Record<string, unknown> | undefined;
  try {
    const raw = event.body || '';
    const guard = verifyHmacSha256(raw, event);
    if (!guard.ok) return guard.response;

    let payload: BmacPayload;
    try {
      payload = JSON.parse(raw) as BmacPayload;
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON payload' });
    }

    const normalized = normalizeBmacPayload(payload);
    if (!normalized.eventId) return jsonResponse(400, { error: 'Missing event ID' });

    const claim = await claimBmacEvent(normalized.eventId, 'bmac-webhook', payload);
    if (!claim.claimed) {
      return jsonResponse(200, {
        received: true,
        action: claim.duplicate ? 'duplicate' : 'in_flight',
        eventId: normalized.eventId,
      });
    }
    row = claim.row;

    if (!normalized.email) {
      await completeBmacEvent(row, { action: 'no_email' });
      return jsonResponse(200, { received: true, action: 'no_email' });
    }

    if (!EVENTS.has(normalized.eventType)) {
      await completeBmacEvent(row, { action: 'ignored', eventType: normalized.eventType });
      return jsonResponse(200, { received: true, action: 'ignored', eventType: normalized.eventType });
    }

    const users = await filterEntity<Record<string, unknown>>('User', { email: normalized.email });
    if (!users.length) {
      await completeBmacEvent(row, { action: 'no_user_found' });
      return jsonResponse(200, { received: true, action: 'no_user_found' });
    }

    const user = users[0];
    if (user.is_sponsored === true) {
      await completeBmacEvent(row, { action: 'sponsored_bypass' });
      return jsonResponse(200, { received: true, action: 'sponsored_bypass' });
    }

    const flights = await filterEntity<Record<string, unknown>>('PassengerFlight', {
      passenger_id: user.id,
      bmac_payment_confirmed: false,
    });
    const flight = flights.sort(
      (a, b) =>
        new Date(String(b.joined_at || 0)).getTime() -
        new Date(String(a.joined_at || 0)).getTime(),
    )[0];

    if (!flight) {
      await completeBmacEvent(row, { action: 'no_flight_row' });
      return jsonResponse(200, { received: true, action: 'no_flight_row' });
    }

    const now = new Date().toISOString();
    if (!flight.cabin) {
      await updateEntity('PassengerFlight', String(flight.id), { bmac_payment_needs_review: true }, flight);
      await completeBmacEvent(row, { action: 'needs_review' });
      return jsonResponse(200, { received: true, action: 'needs_review' });
    }

    const tier =
      flight.cabin === 'First' ? 'pro' : flight.cabin === 'Business' ? 'plus' : 'free';

    await updateEntity('User', String(user.id), { cabin_class: flight.cabin }, user);
    await updateEntity(
      'PassengerFlight',
      String(flight.id),
      { bmac_payment_confirmed: true, bmac_payment_confirmed_at: now },
      flight,
    );

    const subscriptions = await filterEntity<Record<string, unknown>>('Subscription', {
      user_id: user.id,
    });
    if (subscriptions.length) {
      await updateEntity(
        'Subscription',
        String(subscriptions[0].id),
        { tier, status: 'active' },
        subscriptions[0],
      );
    } else {
      await createEntity('Subscription', { user_id: user.id, tier, status: 'active' });
    }

    await completeBmacEvent(row, { action: 'payment_confirmed', userId: user.id, tier });
    return jsonResponse(200, {
      received: true,
      action: 'payment_confirmed',
      userId: user.id,
      tier,
    });
  } catch (error) {
    if (row) {
      try {
        await failBmacEvent(row, error);
      } catch {
        // ignore secondary failure
      }
    }
    console.error('[bmac-webhook]', error);
    return jsonResponse(500, { error: 'Webhook processing failed' });
  }
}
