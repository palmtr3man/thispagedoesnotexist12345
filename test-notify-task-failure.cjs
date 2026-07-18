const assert = require('assert');
const {
  notifyTaskFailure,
  buildAlertHtml,
  taskFailureRecipient,
} = require('./netlify/functions/shared/notify-task-failure.cjs');

const requests = [];

global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), method: options.method || 'GET', body: options.body || null });
  return { ok: true, status: 202, async text() { return ''; } };
};

(async () => {
  delete process.env.TASK_FAILURE_ALERT_EMAIL;
  delete process.env.TASK_FAILURE_EMAIL;
  delete process.env.SENDGRID_API_KEY;

  assert.strictEqual(taskFailureRecipient(), '');
  const skipped = await notifyTaskFailure({ task: 'test', error: 'boom' });
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.reason, 'recipient_not_configured');
  assert.strictEqual(requests.length, 0);

  process.env.TASK_FAILURE_ALERT_EMAIL = 'ops@example.com';
  const skippedSendgrid = await notifyTaskFailure({ task: 'test', error: 'boom' });
  assert.strictEqual(skippedSendgrid.skipped, true);
  assert.strictEqual(skippedSendgrid.reason, 'sendgrid_not_configured');
  assert.strictEqual(requests.length, 0);

  process.env.SENDGRID_API_KEY = 'sg-test';
  process.env.SENDGRID_FROM_EMAIL = 'alerts@example.com';

  const sent = await notifyTaskFailure({
    task: 'alignment-loop',
    error: 'Notion timeout',
    details: { trigger: 'scheduled' },
  });
  assert.strictEqual(sent.ok, true);
  assert.strictEqual(sent.notified, 'ops@example.com');
  assert.strictEqual(requests.length, 1);

  const payload = JSON.parse(requests[0].body);
  assert.strictEqual(payload.personalizations[0].to[0].email, 'ops@example.com');
  assert.match(payload.subject, /alignment-loop/);

  const html = buildAlertHtml('alignment-loop', 'Notion <timeout>', { code: 504 });
  assert.match(html, /Notion &lt;timeout&gt;/);

  console.log('test-notify-task-failure.cjs: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
