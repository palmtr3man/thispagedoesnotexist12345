# TUJ .com Active-Flight Module — Hierarchy & Clarity Upgrade

**Scope:** Targeted refinement of the `#loading-dock` section in `index.html`.
**Type:** Evolution of the current window — not a redesign.
**Repo:** `palmtr3man/thispagedoesnotexist12345`
**Date:** May 2026

---

## 1. What This Update Is

This is a **hierarchy and clarity upgrade** to the existing active-flight display block on the TUJ `.com` public window. The page structure, voice, carousel/slides, lower navigation, and all existing JS state machine logic are preserved. Only the flight module's internal layout and content priority are changed.

The goal is to make the flight block read like a **passenger-facing departure board**, not an operational status dump. The canonical flight name leads. The flight code is metadata. Dates and times are paired and complete. The primary action — boarding — is visually dominant.

---

## 2. Current State (Audit Findings)

The current `#loading-dock` block has the following issues:

| Issue | Current Behavior | Impact |
|---|---|---|
| Flight identity is ambiguous | `Flight:` label shows a single badge driven by `flight_label` — no distinction between name and code | Passengers see either a human name or an operational code depending on what Base44 returns — naming drift risk |
| Arrival date is missing | Only `Arrival Time` is shown; no arrival date field exists in the DOM | Incomplete timing information |
| Departure date and time are separate rows | `Departure Date` and `Departure Time` are listed as independent rows with no visual pairing | Harder to read as a unified departure window |
| "Book a Consultation" competes with "Request a Seat" | Both CTAs are rendered at similar visual weight inside the flight block | Dilutes the primary boarding action |
| No naming guardrail | `flight_label` is the only source for the flight badge; `admin-approve.js` synthesizes `flight_display_name` as `TUJ ${flight_id}` when no name is set | Stale internal labels can surface publicly |

---

## 3. Updated Active-Flight Module — Content Hierarchy

The revised module renders the following fields in this order:

```
┌─────────────────────────────────────────────┐
│  ✈️ Active Flight          [eyebrow label]  │
│  Solo Flight 1             [PRIMARY TITLE]  │
│  Flight Code  FL032126     [secondary meta] │
├─────────────────────────────────────────────┤
│  Arrival                  Departure         │
│  [May 1] [8:34 AM ET]    [Apr 3] [2:01 AM] │
├─────────────────────────────────────────────┤
│  Status: [DELAYED]   Loading Dock: [GATE OPEN] │
├─────────────────────────────────────────────┤
│  [00 Hours : 00 Minutes : 00 Seconds]       │
├─────────────────────────────────────────────┤
│                                             │
│       ✈️  REQUEST A SEAT  [PRIMARY CTA]     │
│                                             │
│  ─────────────────────────────────────────  │
│  📅 Book a Consultation   [secondary, muted]│
└─────────────────────────────────────────────┘
```

### Field-by-field spec

| Field | Role | DOM ID | Data Source | Notes |
|---|---|---|---|---|
| Flight Name | **Primary identity** | `#flight-name-primary` (new) | `status.flight_name` → `status.flight_label` → `'Next Departure'` | Must use canonical passenger-facing name. Never the raw flight code. |
| Flight Code | Secondary metadata | `#flight-number` (existing) | `status.flight_code` → `status.flight_id` → hidden | Rendered as a small muted badge below the name. Hidden if no code. |
| Arrival Date | Paired with Arrival Time | `#arrival-date-text` (new) | `fmtDate(status.nextflightarrivaldate)` | New field — currently missing from the DOM. |
| Arrival Time | Paired with Arrival Date | `#arrival-text` (existing) | `fmtTime(status.nextflightarrivaldate)` | Existing field, no change to JS logic. |
| Departure Date | Paired with Departure Time | `#departure-date` (existing) | `fmtDate(status.nextflightdeparturedate)` | Existing field, moved into paired layout. |
| Departure Time | Paired with Departure Date | `#departure-time-badge` (existing) | `fmtTime(status.nextflightdeparturedate)` | Existing field, moved into paired layout. |
| Status | Flight status badge | `#dock-status-badge` (existing) | `status.nextflightstatus` | No change to logic or color coding. |
| Loading Dock | Gate state badge | `#dock-status` (existing) | `status.gate_status` | No change to logic. |
| Countdown | Time to departure | `#countdown-wrap` (existing) | `window.__seatStatusReady.departureDate` | No change. |
| Request a Seat | **Primary CTA** | `#waitlistBtn` (existing) | `intake_mode` / `open_count` | Full-width, high-contrast. Dominant action. |
| Join the Waitlist | Primary CTA (flight full) | `#joinWaitlistBtn` (existing) | `open_count >= max_seats` | Shown when flight is full. Same visual weight as Request a Seat. |
| Book a Consultation | Secondary CTA | `data-umami-event="Book a Consultation Click"` (existing) | `intake_mode === 'CALENDARJET'` | Muted by default. Becomes primary only in CALENDARJET intake mode (existing JS logic preserved). |

---

## 4. What Stays, What Moves, What Is Newly Added

### Stays (no change)
- All carousel/slides content and behavior
- Page `<h1>`, subtitle, and lede text
- Info modal (What is TUJ?)
- Age gate overlay
- Seat ID gate overlay
- Mission Control dashboard (`#dashboard-view`)
- All JS state machine logic (`window.__TUJ`, `rerender()`, countdown, puzzle tracker)
- Lower navigation row: Studio / Signal / Systems / Support the Journey
- Mission Control nav button (`#mc-nav-btn`)
- Puzzle tracker (`#puzzleTracker`)
- Next step guidance text
- Footer links and copyright
- All Umami analytics event attributes
- All `data-show-state` attributes
- All existing DOM IDs (no renames, no removals)

### Moves (repositioned within the flight block)
- `Departure Date` and `Departure Time` — moved from separate rows into a **paired two-column layout** alongside `Arrival Date` and `Arrival Time`
- `Book a Consultation` — moved from equal-weight position to a **visually subordinate secondary CTA row** with reduced opacity and smaller type

### Newly Added
- `#flight-name-primary` — new `<h2>` element for the canonical passenger-facing flight name (primary title)
- `.flight-name-eyebrow` — small "✈️ Active Flight" label above the name
- `.flight-code-secondary` — wrapper row for the flight code badge (secondary metadata)
- `#arrival-date-text` — new `<span>` inside `#arrival-date` for the arrival date (currently missing)
- `.status-row--paired` — CSS grid layout for the paired Arrival / Departure columns
- `.status-row--strip` — flex row for Status + Loading Dock side-by-side
- `.secondary-cta-row` — wrapper for the subordinate consultation CTA
- `.btn--secondary-cta` — CSS class for the muted consultation button style

---

## 5. Naming Guardrail

> **Important:** The public flight header must use the canonical passenger-facing flight display name, not just the operational flight code or any stale internal label.

### Implementation

The JS patch reads fields in this priority order:

1. `status.flight_name` — a new dedicated field to add to the Base44 `NextFlightConfig` schema. This is the cleanest long-term solution.
2. `status.flight_label` — the existing field currently used. If this contains the correct human-facing name (e.g. "Solo Flight 1"), no schema change is needed.
3. `'Next Departure'` — safe fallback if neither field is populated.

The flight code badge reads:
1. `status.flight_code` — new dedicated field (recommended to add to Base44)
2. `status.flight_id` — legacy alias
3. Hidden — if no code is available, the secondary row is hidden entirely

### Recommended Base44 schema addition

Add a `flight_name` field to `NextFlightConfig` (or the active `cohorts` record) that stores the canonical human-facing name separately from the operational `flight_id` / `flight_code`. The Supabase `cohorts` table already has `flight_label` — this can serve as `flight_name` if it is kept up to date with the passenger-facing name.

---

## 6. Files Delivered

| File | Purpose |
|---|---|
| `tuj-flight-module-spec.md` | This document — full spec, change notes, and implementation guide |
| `tuj-flight-module-update.html` | Drop-in replacement for the `#loading-dock` section (lines ~1893–2148 of `index.html`) |
| `tuj-flight-module-styles.css` | New/updated CSS rules to add inside the `<style>` block in `index.html` |
| `tuj-flight-module-js-patch.js` | Annotated JS additions for `window.__applySeatGate()` in `index.html` |

---

## 7. Implementation Steps

1. **Add CSS** — Copy all rules from `tuj-flight-module-styles.css` into the `<style>` block in `index.html`, after the existing `.badge--highlight` rule (around line 170).

2. **Replace the flight block HTML** — In `index.html`, replace lines ~1893–2148 (from `<!-- CYBERPUNK STATUS SECTION -->` to the closing `</div>` before `<!-- BLACK GLASS BUTTONS -->`) with the contents of `tuj-flight-module-update.html`.

3. **Patch the JS** — In `window.__applySeatGate()` in `index.html`:
   - Add the three new DOM ref variables from `tuj-flight-module-js-patch.js` to the existing DOM refs block
   - Replace the "1. Flight label badge" block with the new dual-field name/code logic
   - Add the arrival date population block after the existing arrival time block (step 5)

4. **Optional: Add `flight_name` to Base44** — Add a `flight_name` field to `NextFlightConfig` in Base44 and populate it with the canonical passenger-facing name for the active flight. If `flight_label` already contains the correct name, this step can be deferred.

5. **Test** — Verify the following states render correctly:
   - Gate open with active flight: name + code + paired dates + Request a Seat dominant
   - Gate closed / departed: name + code + paired dates + Join Waitlist dominant, consultation muted
   - CALENDARJET intake mode: consultation CTA becomes primary (existing JS logic)
   - No flight data: fallback "Next Departure" name, hidden code badge
