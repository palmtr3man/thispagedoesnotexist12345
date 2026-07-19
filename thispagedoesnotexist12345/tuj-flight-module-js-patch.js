/**
 * TUJ ACTIVE-FLIGHT MODULE — JS Patch for applySeatGate()
 *
 * These additions go inside window.__applySeatGate (the existing IIFE in index.html),
 * immediately after the existing DOM refs block (after line ~2404).
 *
 * WHAT THIS PATCH ADDS:
 *   1. Reads #flight-name-primary (new element) and populates it with the
 *      canonical passenger-facing flight name.
 *   2. Reads #arrival-date-text (new element) and populates it with the
 *      arrival date (currently only arrival TIME was shown; date was missing).
 *   3. The existing #flight-number element is retained as the flight code badge.
 *
 * NAMING GUARDRAIL (from spec):
 *   The public flight header MUST use the canonical passenger-facing flight
 *   display name, not just the operational flight code or any stale internal label.
 *
 *   Priority order for flight name:
 *     1. status.flight_name         (new dedicated field — add to Base44 schema)
 *     2. status.flight_label        (existing field — current source of truth)
 *     3. 'Next Departure'           (safe fallback)
 *
 *   Priority order for flight code (secondary metadata):
 *     1. status.flight_code         (operational code — e.g. FL032126)
 *     2. status.flight_id           (legacy alias)
 *     3. '' (empty — hide the badge if no code available)
 */

// ── PATCH: Add these lines to the DOM refs block ──────────────────────────
var flightNamePrimaryEl  = document.getElementById('flight-name-primary');
var flightCodeBadgeEl    = document.getElementById('flight-number');        // existing
var arrivalDateTextEl    = document.getElementById('arrival-date-text');    // new

// ── PATCH: Replace the existing "1. Flight label badge" block ─────────────
// OLD (lines ~2417-2424):
//   if (flightEl) {
//     var label = status.flight_label && status.flight_label.trim()
//       ? status.flight_label.trim() + ' ✈️'
//       : 'Next Departure ✈️';
//     flightEl.textContent = label;
//   }
//
// NEW:
if (flightNamePrimaryEl) {
  // Primary: canonical passenger-facing name
  var flightName = (status.flight_name && status.flight_name.trim())
    || (status.flight_label && status.flight_label.trim())
    || 'Next Departure';
  flightNamePrimaryEl.textContent = flightName;
}

if (flightCodeBadgeEl) {
  // Secondary: operational flight code (metadata only)
  var flightCode = (status.flight_code && status.flight_code.trim())
    || (status.flight_id && status.flight_id.trim())
    || '';
  if (flightCode) {
    flightCodeBadgeEl.textContent = flightCode;
    flightCodeBadgeEl.closest('.flight-code-secondary').style.display = '';
  } else {
    // No code available — hide the secondary row entirely
    var codeRow = flightCodeBadgeEl.closest('.flight-code-secondary');
    if (codeRow) codeRow.style.display = 'none';
  }
}

// ── PATCH: Add arrival DATE population (after existing arrival TIME block) ─
// Existing block (lines ~2526-2529) sets #arrival-text with fmtTime().
// This patch adds #arrival-date-text with fmtDate() from the same field.
if (arrivalDateTextEl) {
  var arrivalDate = fmtDate(status.nextflightarrivaldate || status.next_flight_arrival_date);
  arrivalDateTextEl.textContent = arrivalDate || '—';
}

/**
 * SUMMARY OF CHANGES TO index.html:
 *
 * 1. In the <style> block:
 *    → Add all rules from tuj-flight-module-styles.css
 *
 * 2. In the #loading-dock section (lines ~1893-2148):
 *    → Replace with tuj-flight-module-update.html
 *
 * 3. In window.__applySeatGate (lines ~2386-2695):
 *    → Add the DOM refs from this file (flightNamePrimaryEl, arrivalDateTextEl)
 *    → Replace the "1. Flight label badge" block with the new dual-field logic above
 *    → Add the arrival date population block after the existing arrival time block
 *
 * NO OTHER CHANGES to index.html are required.
 * All existing JS state machine logic, countdown, puzzle tracker, and
 * lower navigation remain untouched.
 */
