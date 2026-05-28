'use strict';

const crypto = require('crypto');

const INTERNAL_TOKEN_ENV = 'SEC06_INTERNAL_TOKEN';
const SCHEDULER_SECRET_ENV = 'SEC06_SCHEDULER_SECRET';

function headerValue(headers, name) {
  if (!headers) return '';
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function bearerToken(headers) {
  const auth = headerValue(headers, 'authorization');
  const match = String(auth).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function secretsMatch(supplied, expected) {
  if (!supplied || !expected) return false;
  return timingSafeEqual(supplied, expected);
}

function requiredSecret(envName) {
  const value = process.env[envName];
  return value && String(value).trim() ? String(value).trim() : '';
}

function rejectBrowserOrigin(event) {
  const origin = headerValue(event.headers, 'origin').trim();
  return Boolean(origin);
}

function submittedInternalToken(event) {
  return (
    headerValue(event.headers, 'x-internal-token').trim()
    || headerValue(event.headers, 'x-webhook-secret').trim()
    || bearerToken(event.headers)
  );
}

function submittedSchedulerSecret(event) {
  return headerValue(event.headers, 'x-scheduler-secret').trim() || bearerToken(event.headers);
}

function validateSchedulerTrigger(event) {
  if (rejectBrowserOrigin(event)) return false;
  const expected = requiredSecret(SCHEDULER_SECRET_ENV);
  if (!expected) return false;
  return secretsMatch(submittedSchedulerSecret(event), expected);
}

function validateInternalTrigger(event) {
  if (rejectBrowserOrigin(event)) return false;
  const expected = requiredSecret(INTERNAL_TOKEN_ENV);
  if (!expected) return false;
  return secretsMatch(submittedInternalToken(event), expected);
}

function validateHeaderSecret(event, headerName) {
  if (rejectBrowserOrigin(event)) return false;
  const expected = requiredSecret(INTERNAL_TOKEN_ENV);
  if (!expected) return false;
  const supplied = headerValue(event.headers, headerName).trim() || submittedInternalToken(event);
  return secretsMatch(supplied, expected);
}

/** Cron or webhook trigger for alignment-loop. Returns 'cron' | 'webhook' | null. */
function validateAlignmentLoopTrigger(event) {
  const method = (event.httpMethod || '').toUpperCase();
  if (validateSchedulerTrigger(event)) return 'cron';
  if (method === 'POST' && validateInternalTrigger(event)) return 'webhook';
  return null;
}

module.exports = {
  INTERNAL_TOKEN_ENV,
  SCHEDULER_SECRET_ENV,
  timingSafeEqual,
  validateSchedulerTrigger,
  validateInternalTrigger,
  validateHeaderSecret,
  validateAlignmentLoopTrigger,
};
