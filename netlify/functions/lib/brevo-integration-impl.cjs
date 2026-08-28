'use strict';

const { templateId } = require('./brevo-templates.js');
const API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_SENDER = 'support@thispagedoesnotexist12345.com';
const DEFAULT_SENDER_NAME = 'Palmtree Studios';

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) };
}
function parseBody(request) {
  if (!request) return {};
  if (typeof request.json === 'function') return request.json();
  try { return JSON.parse(request.body || '{}'); } catch { throw new Error('Invalid JSON body'); }
}
function first(value, fallback = '') { return value === undefined || value === null ? fallback : value; }

async function sendBrevo(payload) {
  const key = process.env.BREVO_API_KEY;
  if (!key) throw new Error('BREVO_API_KEY is not configured');
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': key },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 500) }; }
  if (!response.ok) { const error = new Error(data.message || `Brevo request failed (${response.status})`); error.status = response.status; throw error; }
  return data;
}

async function handler(request) {
  if (request?.method === 'OPTIONS' || request?.httpMethod === 'OPTIONS') return json(204, {});
  if ((request?.method || request?.httpMethod || 'POST').toUpperCase() !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });
  let body;
  try { body = await parseBody(request); } catch (error) { return json(400, { ok: false, error: error.message }); }
  const to = first(body.to || body.email).trim();
  if (!to || !to.includes('@')) return json(400, { ok: false, error: 'A valid recipient email is required' });
  const params = { ...(body.params || {}), ...(body.dynamicData || {}), ...(body.metadata || {}) };
  const id = templateId(body.templateKey || body.template_key || body.template);
  const payload = {
    sender: { email: process.env.BREVO_SENDER_EMAIL || DEFAULT_SENDER, name: process.env.BREVO_SENDER_NAME || DEFAULT_SENDER_NAME },
    to: [{ email: to, ...(body.name ? { name: String(body.name) } : {}) }],
    ...(id ? { templateId: id, params } : { subject: String(body.subject || params.subject || 'The Ultimate Journey'), htmlContent: String(body.html || body.htmlContent || ''), textContent: String(body.text || '') }),
    ...(body.headers ? { headers: body.headers } : {}),
  };
  try { const result = await sendBrevo(payload); return json(200, { ok: true, messageId: result.messageId || null }); }
  catch (error) { return json(error.status === 401 ? 502 : 500, { ok: false, error: error.message }); }
}

module.exports = { handler, sendBrevo };
