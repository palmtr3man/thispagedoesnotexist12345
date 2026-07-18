'use strict';

function getTrimmedEnv(name) {
  const value = process.env[name];
  return value ? String(value).trim() : '';
}

function resolveHandleSeatOpenedTarget() {
  return getTrimmedEnv('BASE44_HANDLE_SEAT_OPENED_URL') ? 'base44' : 'netlify';
}

async function triggerBase44HandleSeatOpened(base44Url, seatPayload, fetchImpl = fetch) {
  const url = String(base44Url || getTrimmedEnv('BASE44_HANDLE_SEAT_OPENED_URL') || '').trim();
  if (!url) {
    return { ok: false, status: 500, via: 'base44', error: 'BASE44_HANDLE_SEAT_OPENED_URL not configured' };
  }

  const token = getTrimmedEnv('SEC06_INTERNAL_TOKEN');
  if (!token) {
    return { ok: false, status: 500, via: 'base44', error: 'SEC06_INTERNAL_TOKEN not configured' };
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': token,
      },
      body: JSON.stringify(seatPayload),
    });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok && body.ok !== false,
      status: res.status,
      via: 'base44',
      body,
      error: body.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, via: 'base44', error: message };
  }
}

async function triggerNetlifySendgridIntegration(siteUrl, seatPayload, fetchImpl = fetch) {
  const base = String(
    siteUrl || getTrimmedEnv('URL') || getTrimmedEnv('SITE_URL') || 'https://www.thispagedoesnotexist12345.com',
  ).replace(/\/$/, '');
  const url = `${base}/.netlify/functions/sendgrid-integration`;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(seatPayload),
    });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok && body.ok !== false,
      status: res.status,
      via: 'netlify',
      body,
      error: body.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, via: 'netlify', error: message };
  }
}

async function triggerHandleSeatOpened(seatPayload, options = {}) {
  const target = resolveHandleSeatOpenedTarget();
  if (target === 'base44') {
    return triggerBase44HandleSeatOpened(options.base44Url, seatPayload, options.fetch);
  }
  return triggerNetlifySendgridIntegration(options.siteUrl, seatPayload, options.fetch);
}

module.exports = {
  resolveHandleSeatOpenedTarget,
  triggerBase44HandleSeatOpened,
  triggerNetlifySendgridIntegration,
  triggerHandleSeatOpened,
};
