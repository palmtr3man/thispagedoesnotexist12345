'use strict';

/**
 * Admin alert email when a scheduled Netlify task fails.
 * Mirrors base44-functions/notifyTaskFailure.ts for the static-site side.
 */

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';

function trimEnv(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : '';
}

function taskFailureRecipient() {
  return trimEnv('TASK_FAILURE_ALERT_EMAIL') || trimEnv('TASK_FAILURE_EMAIL');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildAlertHtml(task, error, details) {
  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const detailsHtml = details
    ? `<pre style="background:#1a0000;color:#ff8888;padding:12px;border-radius:6px;font-size:13px;overflow:auto">${escapeHtml(JSON.stringify(details, null, 2))}</pre>`
    : '';

  return `
    <div style="font-family:monospace;background:#0a0a0a;color:#e2e8f0;padding:24px;border-radius:8px;max-width:600px">
      <div style="background:#3a0a0a;border:1px solid #ff537055;border-radius:8px;padding:16px;margin-bottom:20px">
        <p style="color:#ff5370;font-size:18px;font-weight:bold;margin:0 0 4px">🚨 Task Failure Alert</p>
        <p style="color:#888;font-size:12px;margin:0">${escapeHtml(ts)} ET</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr>
          <td style="color:#4a6a7a;font-size:12px;padding:6px 0;width:100px">Task</td>
          <td style="color:#64ffda;font-weight:bold">${escapeHtml(task)}</td>
        </tr>
        <tr>
          <td style="color:#4a6a7a;font-size:12px;padding:6px 0">Error</td>
          <td style="color:#ff5370">${escapeHtml(error)}</td>
        </tr>
      </table>
      ${detailsHtml}
      <p style="color:#2a4a5a;font-size:11px;margin-top:20px">
        Sent by The Ultimate Journey · automated task monitor
      </p>
    </div>
  `;
}

/**
 * Best-effort admin alert. Never throws.
 *
 * @param {{ task: string, error: string, details?: unknown }} payload
 * @returns {Promise<{ ok: boolean, notified?: string, skipped?: boolean, reason?: string, error?: string }>}
 */
async function notifyTaskFailure({ task, error, details = null }) {
  const to = taskFailureRecipient();
  if (!to) {
    console.warn('[notify-task-failure] TASK_FAILURE_ALERT_EMAIL not set — skipping alert');
    return { ok: false, skipped: true, reason: 'recipient_not_configured' };
  }

  const apiKey = trimEnv('SENDGRID_API_KEY');
  if (!apiKey) {
    console.warn('[notify-task-failure] SENDGRID_API_KEY not set — skipping alert');
    return { ok: false, skipped: true, reason: 'sendgrid_not_configured' };
  }

  const fromEmail = trimEnv('SENDGRID_FROM_EMAIL')
    || trimEnv('SENDER_EMAIL')
    || 'support@thispagedoesnotexist12345.com';

  try {
    const res = await fetch(SENDGRID_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: 'TUJ Task Monitor' },
        subject: `🚨 TUJ Task Failure: ${task}`,
        content: [{ type: 'text/html', value: buildAlertHtml(task, error, details) }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[notify-task-failure] SendGrid error', res.status, text);
      return { ok: false, error: text };
    }

    return { ok: true, notified: to };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[notify-task-failure]', message);
    return { ok: false, error: message };
  }
}

module.exports = {
  notifyTaskFailure,
  buildAlertHtml,
  taskFailureRecipient,
};
