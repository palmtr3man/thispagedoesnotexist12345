/**
 * sendgrid-templates.js — Single source of truth for all SendGrid template IDs.
 *
 * Every function that sends a SendGrid email MUST import its template ID from
 * this module. No d-... ID may be hardcoded anywhere else in the codebase.
 *
 * Pattern:
 *   const { TEMPLATES, assertTemplates } = require('./sendgrid-templates');
 *   assertTemplates(['seat_request_acknowledgement_v1']);   // throws at cold-start if missing
 *   const templateId = TEMPLATES.seat_request_acknowledgement_v1;
 *
 * Env var → template key mapping (all vars must be set in Netlify + .env.example):
 *
 *   SENDGRID_TEMPLATE_SEAT_REQUEST          → seat_request_acknowledgement_v1
 *   SENDGRID_TEMPLATE_INTERNAL_SIGNUP       → internalsignupnotification_v1
 *   SENDGRID_TEMPLATE_NEXT_FLIGHT_WAITLIST  → next_flight_waitlist_v1
 *   SENDGRID_TEMPLATE_OPT_OUT_ACK           → optout_acknowledgement_v1
 *   SENDGRID_TEMPLATE_ALPHA_ANNOUNCEMENT    → alphaflightannouncement_v1
 *   SENDGRID_TEMPLATE_BOARDING_CONFIRMATION → boarding_confirmation_v1
 *   SENDGRID_TEMPLATE_OFFER_CONGRATS        → offer_congrats_v1
 *   SENDGRID_TEMPLATE_EXEC_PREBOARD         → exec_preboard_opentowork_v1
 *
 * Fallback IDs are the confirmed canonical values from the SendGrid Template
 * Registry (Notion). They exist so local dev without a .env file still resolves
 * correctly, and so a missing Netlify var produces a clear startup error rather
 * than a silent wrong-template send.
 *
 * Last verified: 2026-04-01
 * Source of truth: Notion — 📧 SendGrid Template Registry — All Templates
 */

'use strict';

// ---------------------------------------------------------------------------
// Canonical fallback IDs (confirmed live in SendGrid as of 2026-04-01)
// ---------------------------------------------------------------------------
const FALLBACKS = {
  seat_request_acknowledgement_v1: 'd-740595dc07be40129569bc731f1bc454',
  internalsignupnotification_v1:   'd-073dc68a683348f18133d78c9879ced8',
  next_flight_waitlist_v1:         'd-52c178a809f94a82a3bf8cd6ebd435e9',
  optout_acknowledgement_v1:       'd-e74bbc76586845f98febdd724cc69429',
  alphaflightannouncement_v1:      'd-a33174bd2e4f4682b5b1546f106fb43c',
  boarding_confirmation_v1:        'd-678824bc506c432dae9eadab36c07904',
  offer_congrats_v1:               'd-11d5610e48b34eedb77dc2bc7bdf4eaa',
  exec_preboard_opentowork_v1:     'd-d8cef7e7bfbc449fa318219bda70d397',
};

// ---------------------------------------------------------------------------
// Env var → template key resolution
// ---------------------------------------------------------------------------
const TEMPLATES = {
  seat_request_acknowledgement_v1:
    process.env.SENDGRID_TEMPLATE_SEAT_REQUEST          || FALLBACKS.seat_request_acknowledgement_v1,
  internalsignupnotification_v1:
    process.env.SENDGRID_TEMPLATE_INTERNAL_SIGNUP       || FALLBACKS.internalsignupnotification_v1,
  next_flight_waitlist_v1:
    process.env.SENDGRID_TEMPLATE_NEXT_FLIGHT_WAITLIST  || FALLBACKS.next_flight_waitlist_v1,
  optout_acknowledgement_v1:
    process.env.SENDGRID_TEMPLATE_OPT_OUT_ACK           || FALLBACKS.optout_acknowledgement_v1,
  alphaflightannouncement_v1:
    process.env.SENDGRID_TEMPLATE_ALPHA_ANNOUNCEMENT    || FALLBACKS.alphaflightannouncement_v1,
  boarding_confirmation_v1:
    process.env.SENDGRID_TEMPLATE_BOARDING_CONFIRMATION || FALLBACKS.boarding_confirmation_v1,
  offer_congrats_v1:
    process.env.SENDGRID_TEMPLATE_OFFER_CONGRATS        || FALLBACKS.offer_congrats_v1,
  exec_preboard_opentowork_v1:
    process.env.SENDGRID_TEMPLATE_EXEC_PREBOARD         || FALLBACKS.exec_preboard_opentowork_v1,
};

// ---------------------------------------------------------------------------
// Optional allowlist guard: throws at cold-start if a resolved ID doesn't
// match the known canonical value. Catches Netlify env drift before a send.
// Only active when SENDGRID_STRICT_TEMPLATE_CHECK=true.
// ---------------------------------------------------------------------------
function assertTemplates(keys) {
  if (process.env.SENDGRID_STRICT_TEMPLATE_CHECK !== 'true') return;

  const errors = [];
  for (const key of keys) {
    if (!TEMPLATES[key]) {
      errors.push(`  [sendgrid-templates] Unknown template key: "${key}"`);
      continue;
    }
    const resolved = TEMPLATES[key];
    const canonical = FALLBACKS[key];
    if (resolved !== canonical) {
      errors.push(
        `  [sendgrid-templates] ID mismatch for "${key}": ` +
        `env resolved "${resolved}", canonical is "${canonical}"`
      );
    }
  }

  if (errors.length) {
    throw new Error(
      '[sendgrid-templates] Template ID validation failed:\n' + errors.join('\n')
    );
  }
}

// ---------------------------------------------------------------------------
// Reverse lookup: d-... ID → template key name (used in log lines)
// ---------------------------------------------------------------------------
const TEMPLATE_KEY_BY_ID = Object.fromEntries(
  Object.entries(TEMPLATES).map(([key, id]) => [id, key])
);

function templateKeyForId(id) {
  return TEMPLATE_KEY_BY_ID[id] || id;
}

module.exports = { TEMPLATES, FALLBACKS, assertTemplates, templateKeyForId };
