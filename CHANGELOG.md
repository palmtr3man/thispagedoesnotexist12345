# Changelog — The Ultimate Journey (.com)

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [2026-04-12] — F117: Netlify Function /api/seat-status (Carousel + Dock Source of Truth)

### Changed
- `netlify/functions/seat-status.js` — F117 complete. Three additions to the success response path:
  1. **`ok: true`** — canonical success flag added to all 200 responses (was absent; guard responses now also carry `ok: false`).
  2. **`opencount`** — alias for `open_count` added for carousel compatibility (F117 spec requires `opencount` key).
  3. **`seats[]`** — per-seat array added as the canonical source of truth for the carousel seat slide and dock. Built from `BASE44_SEAT_LIST_URL` when set (live Base44 query, 3 s timeout, graceful fallback). When unset, synthesised from `getCohortStatus` aggregate counts (`open_count` + `approved_count`). Always returns exactly 5 seats in stable order (`seat_1` → `seat_5`). Status values: `pending | approved | opened | denied`.
  4. **`timestamp`** — already returned by `getCohortStatus`; now guaranteed present in all success responses (falls back to `new Date().toISOString()` if missing).
- `.env.example` — added `BASE44_SEAT_LIST_URL` (optional) with documentation.

### Notes
- `BASE44_SEAT_LIST_URL` is optional. When not set, `seats[]` is synthesised — no new required env var for existing deployments.
- All guard responses (VIP 451, QA isolation 422, conflict 409, catch block) now carry `ok: false` for consistency.

---

## [2026-04-12] — F143: Non-Selected Passenger Experience — Next Flight Waitlist

### Changed
- `netlify/functions/seat-request.js` — F143 complete. Three targeted changes to the waitlist path:
  1. **Beehiiv `waitlist` tag** — `subscribeToBeehiiv()` now returns the beehiiv `sub_id`. New `applyBeehiivWaitlistTag(subId, apiKey, pubId)` function calls `POST /v2/publications/:pubId/subscriptions/:subId/tags` with `{ tags: ['waitlist'] }` immediately after subscribe. Fails gracefully — a tag failure does not block the waitlist response.
  2. **BCC** — `next_flight_waitlist_v1` SendGrid send now includes `bcc: [{ email: 'support@thispagedoesnotexist12345.com' }]` in `personalizations`, matching the universal BCC rule from `sendgrid-integration.js`.
  3. **`BCC_EMAIL` constant** — Added module-level `const BCC_EMAIL = 'support@thispagedoesnotexist12345.com'` mirroring the convention in `sendgrid-integration.js`.
- `gate-contract.js` — `SeatRequestResponse` typedef updated to document `waitlisted`, `duplicate`, `status`, and `message` fields. Version bumped to v1d.

### Notes
- In-app confirmation state (`#seat-request-waitlisted`) and form submission handler were already correct — no changes to `index.html`.
- Template ID `d-52c178a809f94a82a3bf8cd6ebd435e9` (set Apr 1, 2026) is the live canonical ID; Notion spec draft shows an earlier ID (`d-54d82aa3007c43e0bd22a5a5ae8c36c4`) from Mar 23, 2026 — codebase value retained.

---

## [2026-04-08] — Feat: Studio Mission Control Gateway Wiring (tuj_code passthrough)

### Added
- `Studio/index.html` — Mission Control Gateway wiring script (Addendum Apr 7, 2026). Injects a self-contained IIFE before `</body>` that reads `seat_id` and `tuj_code` from the incoming URL query string and dynamically sets three CTA hrefs via `data-cta` attribute selectors (`boarding-signal`, `operator-trace`, `studio-entry`). Implements the CTA destination contract from the Wiring Addendum spec: with `seat_id` present, all three CTAs carry both `seat_id` and `tuj_code` params; without `seat_id`, CTAs fall back to bare URLs. Existing `seat_id` parsing in `initDepartureSelector()` is preserved and unmodified.

---

## [2026-04-05] — Fix: Alpha Cohort Seat ID Reassignment (Regex Compliance)

### Changed
- Alpha cohort seat IDs reassigned to comply with `SEAT_ID_REGEX` (`^TUJ-[A-Z2-9]{6}$` — excludes `0`, `1`, `O`, `I` for visual clarity). Previous IDs used `0` and `1` which failed the format check and would have caused all cohort passengers to land on the invalid-seat recovery screen instead of Mission Control.
  - Seat 1 Kevin Clark: `TUJ-KC0001` → `TUJ-KC2222`
  - Seat 2 Clarence Clark: `TUJ-CC0001` → `TUJ-CC2222`
  - Seat 3 Jo Ann Clark: `TUJ-JC0001` → `TUJ-JC2222`
  - Seat 4 Janelle Asumang: `TUJ-JA0001` → `TUJ-JA2222`
  - Seat 5 Monica Nadute: `TUJ-MN0001` → `TUJ-MN2222`
- Notion Alpha Launch cohort manifest updated with new IDs.
- Base44 Seat records require manual update (seat_id field on each of the 5 records).

---

## [2026-04-05] — Fix: resolveState() seat_id Server-Side Validation (Mission Control State 2)

### Added
- `netlify/functions/seat.js` — New `/api/seat?id=TUJ-XXXXXX` Netlify function. Validates a seat ID against Base44 (`BASE44_SEAT_URL/{id}`). Returns `{ valid: true, seat_id, status }` on success; `{ valid: false, reason: 'not_found' | 'inactive' }` on rejection; `{ valid: true, _unchecked: true }` as fail-open when `BASE44_SEAT_URL` is unset or Base44 is unreachable. Accepts `opened` and `approved` Base44 statuses as valid; rejects `pending` and all others.
- `netlify.toml` — `/api/seat` redirect wired to `/.netlify/functions/seat`.
- `#seat-invalid-notice` HTML element — inline recovery notice shown in landing state when a seat_id is rejected. Links to Signal newsletter for re-entry.

### Changed
- `index.html` — `getSeatId()` split into `getSeatIdRaw()` (sync, format-only) and `validateSeatId(id)` (async, calls `/api/seat`). `rerender()` now runs `fetchStatus()` and `validateSeatId()` in parallel via `Promise.all()`. On explicit rejection (`valid: false`), strips `seat_id` from URL via `history.replaceState` and surfaces `#seat-invalid-notice`. Fail-open on network error or timeout preserves existing behaviour when Base44 is unconfigured.
- `index.html` — Seat ID Entry Modal confirm handler upgraded to call `/api/seat` before navigating. Shows server-side error message on `valid: false`; fails open on network error.
- `gate-contract.js` — `resolveState()` upgraded to v1c. Now calls `GATE.VALIDATE_SEAT` after regex validation. Same fail-open contract. Accepts `{ skipSeatValidation: true }` opt for test environments.

## [2026-04-05] — Fix 3a + 3b: Mission Control CTA URL Canonicalization

### Fixed
- `netlify/functions/sendgrid-integration.js` — Fix 3b: `passport_url` corrected from `${siteUrl}/Studio?seat_id=...` to `${siteUrl}/?seat_id=...` (was landing on `/Studio` instead of Mission Control root). `encodeURIComponent` removed from `passportUrl`, `firstTaskUrl`, and `secondaryUrl` construction — seat_id chars (A–Z, 2–9, hyphen) are URL-safe; encoding was a no-op but violated the canonical spec.
- `netlify/functions/seat-request.js` — Fix 3b: `encodeURIComponent` removed from `passportUrl` construction. Canonical form locked: `https://www.thispagedoesnotexist12345.com/?seat_id=TUJ-XXXXXX`.
- Fix 3a: `?status=boarded` param confirmed absent from all templates and server-side URL construction. No changes required.

### Changed
- `sendgrid-templates/boarding_pass_free_v1.html` — Fix log updated; last-updated date bumped to 2026-04-05.
- `sendgrid-templates/boarding_pass_paid_v1.html` — Fix log updated; last-updated date bumped to 2026-04-05.
- `sendgrid-templates/boarding_instructions_free_v1.html` — Fix log updated; last-updated date bumped to 2026-04-05.
- `sendgrid-templates/boarding_instructions_paid_v1.html` — Fix log updated; last-updated date bumped to 2026-04-05.

---

## [2026-04-02] — Sprint 2 Completion

### Added
- `sendgrid-templates/boarding_pass_free_v1.html` — Corrected boarding pass template with `{{passport_url}}` CTA (Fix 1)
- `sendgrid-templates/boarding_pass_paid_v1.html` — First Class boarding pass variant with `{{passport_url}}` CTA (Fix 1)
- `sendgrid-templates/boarding_instructions_free_v1.html` — Boarding instructions template with `{{first_task_url}}` CTA (Fix 2)
- `sendgrid-templates/boarding_instructions_paid_v1.html` — First Class boarding instructions variant with `{{first_task_url}}` CTA (Fix 2)
- `sendgrid-templates/internalsignupnotification_v1.html` — Corrected internal signup notification template aligned to Spark/newsletter canon
- Four new boarding template env vars documented in `.env.example`

### Changed
- Mission Control nav button row reordered: `Studio → Signal → Systems → Support` (Support moved to last position)
- Mission Control tile "Resources" rebranded to "Field Guide" (🗺️) — aligns with `.info` Field Guide rebrand
- `netlify/functions/sendgrid-templates.js` — All four boarding template IDs registered in FALLBACKS + TEMPLATES maps

---

## [2026-04-01] — Gate Contract v1b + QA Sprint

### Added
- `gate-contract.js` — Shared interface constants: GATE object, `resolveState()`, `requestSeat()` (Gate Contract v1b, 4-P1)
- Age Gate UI — DOB collection + signed age_token (4-P2)
- Mission Control seat counter widget (4-P3)
- Structured `tuj_sendgrid_send` log shape across all SendGrid sends (observability)
- `/api/verify-age` redirect in `netlify.toml`
- Single-source-of-truth SendGrid template registry (`sendgrid-templates.js`)

### Fixed
- QA #1 + #6: `PUBLIC_GATE_STATE` override injected into seat-status proxy; hold state handler added to `applySeatGate`
- QA #2: `status.max_seats` wired into `resolveGateState()` — replaced hardcoded `MAX=5`
- QA #5: Single active flight invariant enforced — 3-layer fix
- QA #7: Flight isolation index enforced — DB + API + UI
- QA #5 + #7: Supabase migrations rewritten to match real flights schema
- `exec_preboard_opentowork_v1` template wired end-to-end
- `/api/verify-age` redirect added to `netlify.toml`
- 1-seat-per-email dedup + boarding sequence navigation CTAs
- Step 05 consultation CTA restricted to `CALENDARJET` intake_mode only
- Mission Control: bottom spacing, nav button, seat ID gating
- Confirmation email link: `passport_url` now points to `.com` Mission Control
- Scroll reset, Mission Control row, false code message
- `padInternalAlertValue` removed; `first_name` added to internal alert (Bug-003)
- `seatreference` and `seat_id` added to boarding template `dynamicData` payload
- `next_flight_waitlist_v1` template ID corrected + env-var-driven ASM group
- SendGrid integration: decoded base64 blob — plain JS source now readable by Netlify bundler
- Full env var audit — all gaps in `.env.example` closed

### Changed
- Support the Journey ☕ moved to first position in button row (later corrected to last)

---

## [2026-03-27] — Gate Contract v1.0 + Routing

### Added
- `gate-contract.js` v1.0 — initial GATE constants + `resolveState()` two-state machine
- `/CommandCenter` → `/Tower` redirect registered in `App.jsx` (CC-P3-ROUTE)
- `.tech` www → apex redirect (path-preserving, commit `d46c5d0`)

### Fixed
- Domain routing integrity verified: Signal → `.us` Beehiiv, Systems → `.tech`, `.info` About ✅

---

## [2026-03-12] — Alpha Launch Baseline

### Added
- Initial landing page with gate state machine
- SendGrid integration: `seat-request.js`, `sendgrid-integration.js`
- Netlify functions: `/api/seat-request`, `/api/seat-status`, `/api/seat`
- Mission Control dashboard (authenticated view)
- Studio, Signal, Systems, Support navigation
- Age gate (Gate Contract §5, `MIN_AGE: 21`)
- Beehiiv newsletter integration (`pub_e3dd6c0b-979c-464c-a7ee-c146e912aadf`)
- Umami analytics
