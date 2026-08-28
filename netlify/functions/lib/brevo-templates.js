'use strict';

// Brevo template registry. Values may be supplied as BREVO_TEMPLATE_<KEY> environment variables.
const TEMPLATE_KEYS = Object.freeze([
  'SEAT_REQUEST_ACKNOWLEDGEMENT', 'BOARDING_CONFIRMATION', 'ALPHA_FLIGHT_ANNOUNCEMENT',
  'BOARDING_PASS_FREE', 'BOARDING_INSTRUCTIONS_FREE', 'BOARDING_PASS_PAID',
  'BOARDING_INSTRUCTIONS_PAID', 'VIP_BOARDING_PASS', 'VIP_BOARDING_INSTRUCTIONS',
  'EXEC_PREBOARD_OPEN_TO_WORK', 'SPONSORED_APPROVED', 'NEXT_FLIGHT_WAITLIST',
  'OPTOUT_ACKNOWLEDGEMENT', 'OFFER_CONGRATS', 'ALPHA_SEAT_CONFIRM', 'PREBOARD_NURTURE'
]);

function parseInteger(value, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return fallback;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

const TEMPLATES = Object.freeze(Object.fromEntries(TEMPLATE_KEYS.map((key) => [
  key,
  parseInteger(process.env[`BREVO_TEMPLATE_${key}`])
])));

function templateId(key) {
  return parseInteger(TEMPLATES[String(key || '').trim().toUpperCase()]);
}

module.exports = { TEMPLATE_KEYS, TEMPLATES, parseInteger, templateId };
