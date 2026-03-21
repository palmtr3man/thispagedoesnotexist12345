/**
 * scoringContract.js
 * Version: 2.0.0
 *
 * Defines the canonical scoring weights, gate thresholds, and extraction shape
 * for the match engine. Internal key mappings prevent type drift between the
 * public-facing matchType values and the engine's internal representations.
 */

"use strict";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------
const VERSION = "2.0.0";

// ---------------------------------------------------------------------------
// Scoring Weights
// ---------------------------------------------------------------------------
const WEIGHTS = Object.freeze({
  mustHaveWeight:    0.60,
  niceToHaveWeight:  0.25,
  contextWeight:     0.15,
});

// ---------------------------------------------------------------------------
// Gate Thresholds
// ---------------------------------------------------------------------------
/**
 * Each gate defines the minimum composite score (0–100) required to reach
 * that stage, plus any additional hard constraints.
 *
 * Gates in ascending order of score requirement:
 *   check-in  → score < 60
 *   security  → score >= 60
 *   boarding  → score >= 75  AND  mustHaveScore >= 70
 *   departure → score >= 85  AND  missingMustHaves === 0
 */
const GATE_THRESHOLDS = Object.freeze({
  departure: Object.freeze({
    minScore:          85,
    missingMustHaves:  0,   // hard constraint: zero missing must-haves allowed
  }),
  boarding: Object.freeze({
    minScore:          75,
    minMustHaveScore:  70,  // must-have sub-score must meet this floor
  }),
  security: Object.freeze({
    minScore: 60,
  }),
  checkIn: Object.freeze({
    maxScore: 59,           // scores strictly below 60 land here
  }),
});

// ---------------------------------------------------------------------------
// Extraction Shape
// ---------------------------------------------------------------------------
/**
 * Expected shape of each extraction result produced by the match engine.
 *
 * {
 *   keyword:   string   — the term that was searched for
 *   found:     boolean  — whether the keyword was located in the target
 *   matchType: 'exact' | 'semantic'
 * }
 */
const EXTRACTION_SHAPE_KEYS = Object.freeze(["keyword", "found", "matchType"]);

const MATCH_TYPES = Object.freeze({
  exact:    "exact",
  semantic: "semantic",
});

// ---------------------------------------------------------------------------
// Internal Key Mapping  (public matchType  →  engine-internal key)
// Avoids type drift between the contract surface and engine internals.
// ---------------------------------------------------------------------------
const INTERNAL_MATCH_KEY_MAP = Object.freeze({
  exact:    "matched_exact",
  semantic: "matched_semantic",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the internal engine key for a given public matchType string.
 * Throws if the matchType is not recognised.
 *
 * @param {string} matchType
 * @returns {string}
 */
function toInternalKey(matchType) {
  const key = INTERNAL_MATCH_KEY_MAP[matchType];
  if (!key) {
    throw new Error(
      `[scoringContract] Unknown matchType "${matchType}". ` +
      `Valid values: ${Object.keys(MATCH_TYPES).join(", ")}`
    );
  }
  return key;
}

/**
 * Validates that an extraction result conforms to the declared shape.
 * Returns true if valid, throws a descriptive error if not.
 *
 * @param {object} extraction
 * @returns {true}
 */
function validateExtraction(extraction) {
  if (!extraction || typeof extraction !== "object") {
    throw new TypeError("[scoringContract] Extraction must be a non-null object.");
  }

  for (const key of EXTRACTION_SHAPE_KEYS) {
    if (!(key in extraction)) {
      throw new Error(`[scoringContract] Extraction is missing required key: "${key}".`);
    }
  }

  if (typeof extraction.keyword !== "string" || extraction.keyword.trim() === "") {
    throw new TypeError('[scoringContract] "keyword" must be a non-empty string.');
  }

  if (typeof extraction.found !== "boolean") {
    throw new TypeError('[scoringContract] "found" must be a boolean.');
  }

  if (!Object.prototype.hasOwnProperty.call(MATCH_TYPES, extraction.matchType)) {
    throw new Error(
      `[scoringContract] "matchType" must be one of: ${Object.values(MATCH_TYPES).join(", ")}. ` +
      `Received: "${extraction.matchType}".`
    );
  }

  return true;
}

/**
 * Resolves the gate label for a given composite score and hard constraints.
 *
 * @param {number}  score             Composite score (0–100)
 * @param {number}  mustHaveScore     Must-have sub-score (0–100)
 * @param {number}  missingMustHaves  Count of unmatched must-have keywords
 * @returns {'departure'|'boarding'|'security'|'checkIn'}
 */
function resolveGate(score, mustHaveScore, missingMustHaves) {
  if (
    score >= GATE_THRESHOLDS.departure.minScore &&
    missingMustHaves === GATE_THRESHOLDS.departure.missingMustHaves
  ) {
    return "departure";
  }
  if (
    score >= GATE_THRESHOLDS.boarding.minScore &&
    mustHaveScore >= GATE_THRESHOLDS.boarding.minMustHaveScore
  ) {
    return "boarding";
  }
  if (score >= GATE_THRESHOLDS.security.minScore) {
    return "security";
  }
  return "checkIn";
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  VERSION,
  WEIGHTS,
  GATE_THRESHOLDS,
  MATCH_TYPES,
  EXTRACTION_SHAPE_KEYS,
  INTERNAL_MATCH_KEY_MAP,
  toInternalKey,
  validateExtraction,
  resolveGate,
};
