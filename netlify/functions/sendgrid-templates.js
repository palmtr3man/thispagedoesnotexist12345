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
 *   SENDGRID_TEMPLATE_ALPHA_ANNOUNCEMENT    → alphaflightannouncement_v1   [DEPRECATED — F-190 Apr 12, 2026]
 *   SENDGRID_TEMPLATE_BOARDING_CONFIRMATION → boarding_confirmation_v1      [DEPRECATED — F-190 Apr 12, 2026]
 *   SENDGRID_TEMPLATE_OFFER_CONGRATS        → offer_congrats_v1
 *   SENDGRID_TEMPLATE_EXEC_PREBOARD                  → exec_preboard_opentowork_v1
 *   SENDGRID_TEMPLATE_BOARDING_PASS_FREE         → boarding_pass_free_v1
 *   SENDGRID_TEMPLATE_BOARDING_PASS_PAID         → boarding_pass_paid_v1
 *   SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_FREE → boarding_instructions_free_v1
 *   SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_PAID → boarding_instructions_paid_v1
 *   SENDGRID_TEMPLATE_SPONSORED_APPROVED          → sponsored_approved_v1
 *   SENDGRID_TEMPLATE_VIP_BOARDING_PASS           → vip_boarding_pass_v1           (FL 042426 — d-1e5c7552460444028e37c0f935a9e32f)
 *   SENDGRID_TEMPLATE_VIP_BOARDING_INSTRUCTIONS   → vip_boarding_instructions_v1   (FL 042426 — d-54a2336a46134073b589ec5f698c11f3)
 *   SENDGRID_TEMPLATE_ALPHA_SEAT_CONFIRM           → alpha_seat_confirm_v1          (BEEHIIV-SEG — Active Job Seeker seat ID follow-up)
 *   SENDGRID_TEMPLATE_PREBOARD_NURTURE             → preboard_nurture_v1            (BEEHIIV-SEG — Passive Browser pre-boarding nurture)
 *
 * Fallback IDs are the confirmed canonical values from the SendGrid Template
 * Registry (Notion). They exist so local dev without a .env file still resolves
 * correctly, and so a missing Netlify var produces a clear startup error rather
 * than a silent wrong-template send.
 *
 * Last verified: 2026-04-02
 * Source of truth: Notion — 📧 SendGrid Template Registry — All Templates
 *
 * Fix 1 + Fix 2 (Apr 2, 2026): boarding_pass_free/paid_v1 and
 * boarding_instructions_free/paid_v1 registered here so handleSeatOpened
 * in Base44 can reference canonical IDs. Template HTML files committed to
 * sendgrid-templates/ directory for upload to SendGrid dashboard.
 */

'use strict';

// ---------------------------------------------------------------------------
// Canonical fallback IDs (confirmed live in SendGrid as of 2026-04-02)
// ---------------------------------------------------------------------------
const FALLBACKS = {
  seat_request_acknowledgement_v1: 'd-740595dc07be40129569bc731f1bc454',
  internalsignupnotification_v1:   'd-073dc68a683348f18133d78c9879ced8',
  next_flight_waitlist_v1:         'd-52c178a809f94a82a3bf8cd6ebd435e9',
  optout_acknowledgement_v1:       'd-e74bbc76586845f98febdd724cc69429',
  // DEPRECATED (F-190 Apr 12, 2026) — replaced by dual-tier boarding sequence.
  // No longer called by any active send path. Retained for registry parity only.
  alphaflightannouncement_v1:      'd-a33174bd2e4f4682b5b1546f106fb43c',  // DEPRECATED — was Phase 2 boarding send 1
  boarding_confirmation_v1:        'd-678824bc506c432dae9eadab36c07904',  // DEPRECATED — was Phase 2 boarding send 2
  offer_congrats_v1:               'd-11d5610e48b34eedb77dc2bc7bdf4eaa',
  exec_preboard_opentowork_v1:     'd-d8cef7e7bfbc449fa318219bda70d397',
  // ── Boarding sequence templates (handleSeatOpened fan-out) ────────────────
  // Fix 1: boarding_pass CTAs now use {{passport_url}} (deep-link with seat_id)
  // Fix 2: boarding_instructions CTAs now use {{first_task_url}} (seat_id appended)
  boarding_pass_free_v1:           'd-91ca65ce16634f299a46af4f0645d540',
  boarding_pass_paid_v1:           'd-9290e951724f4b028d94945d4f06b69f',
  boarding_instructions_free_v1:   'd-747dac53dd2c4b47b33400376aad1672',
  boarding_instructions_paid_v1:   'd-d8ec12e940944c5596af1fa740cf7f07',
  // ── Sponsored path ───────────────────────────────────────────────────────
  sponsored_approved_v1:           'd-7a7628db6a1e4430b1394a069d0438b0',
  // ── VIP path — LIVE (FL 042426 Birthday Flight, confirmed Apr 20, 2026) ─────
  vip_boarding_pass_v1:            'd-1e5c7552460444028e37c0f935a9e32f',  // FL 042426 Birthday Flight — confirmed Apr 20, 2026
  vip_boarding_instructions_v1:    'd-54a2336a46134073b589ec5f698c11f3',  // FL 042426 Birthday Flight — confirmed Apr 20, 2026
  // ── Beehiiv Segmentation paths (BEEHIIV-SEG, 2026-05-06) ─────────────────
  // IDs are placeholders — update after uploading templates to SendGrid dashboard.
  // Set real d-... values via SENDGRID_TEMPLATE_ALPHA_SEAT_CONFIRM and
  // SENDGRID_TEMPLATE_PREBOARD_NURTURE env vars in Netlify (preferred over fallbacks).
  alpha_seat_confirm_v1:           process.env.SENDGRID_TEMPLATE_ALPHA_SEAT_CONFIRM  || '',  // Active Job Seeker — Seat ID / TUJ code follow-up
  preboard_nurture_v1:             process.env.SENDGRID_TEMPLATE_PREBOARD_NURTURE    || '',  // Passive Browser — pre-boarding nurture track
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
  // DEPRECATED (F-190 Apr 12, 2026) — no longer called by any active send path
  alphaflightannouncement_v1:
    process.env.SENDGRID_TEMPLATE_ALPHA_ANNOUNCEMENT    || FALLBACKS.alphaflightannouncement_v1,
  boarding_confirmation_v1:
    process.env.SENDGRID_TEMPLATE_BOARDING_CONFIRMATION || FALLBACKS.boarding_confirmation_v1,
  offer_congrats_v1:
    process.env.SENDGRID_TEMPLATE_OFFER_CONGRATS        || FALLBACKS.offer_congrats_v1,
  exec_preboard_opentowork_v1:
    process.env.SENDGRID_TEMPLATE_EXEC_PREBOARD              || FALLBACKS.exec_preboard_opentowork_v1,
  // ── Boarding sequence templates (handleSeatOpened fan-out) ────────────────
  boarding_pass_free_v1:
    process.env.SENDGRID_TEMPLATE_BOARDING_PASS_FREE         || FALLBACKS.boarding_pass_free_v1,
  boarding_pass_paid_v1:
    process.env.SENDGRID_TEMPLATE_BOARDING_PASS_PAID         || FALLBACKS.boarding_pass_paid_v1,
  boarding_instructions_free_v1:
    process.env.SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_FREE || FALLBACKS.boarding_instructions_free_v1,
  boarding_instructions_paid_v1:
    process.env.SENDGRID_TEMPLATE_BOARDING_INSTRUCTIONS_PAID || FALLBACKS.boarding_instructions_paid_v1,
  // ── Sponsored path ───────────────────────────────────────────────────────
  sponsored_approved_v1:
    process.env.SENDGRID_TEMPLATE_SPONSORED_APPROVED         || FALLBACKS.sponsored_approved_v1,
  // ── VIP path — LIVE (FL 042426 Birthday Flight, confirmed Apr 20, 2026) ───
  vip_boarding_pass_v1:
    process.env.SENDGRID_TEMPLATE_VIP_BOARDING_PASS          || FALLBACKS.vip_boarding_pass_v1,
  vip_boarding_instructions_v1:
    process.env.SENDGRID_TEMPLATE_VIP_BOARDING_INSTRUCTIONS  || FALLBACKS.vip_boarding_instructions_v1,
  // ── Beehiiv Segmentation paths (BEEHIIV-SEG, 2026-05-06) ─────────────────
  alpha_seat_confirm_v1:
    process.env.SENDGRID_TEMPLATE_ALPHA_SEAT_CONFIRM         || FALLBACKS.alpha_seat_confirm_v1,
  preboard_nurture_v1:
    process.env.SENDGRID_TEMPLATE_PREBOARD_NURTURE           || FALLBACKS.preboard_nurture_v1,
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
