/**
 * normalizeConfig.js
 * Version: 2.0.0
 *
 * Responsible for:
 *   1. Converting raw 0-100 scores to 0-1 scale.
 *   2. Validating that a weight config sums to 1 (±0.001 tolerance).
 *      Falls back to canonical 60/25/15 defaults when validation fails.
 *   3. Validating extraction payloads against the declared shape.
 *   4. Rejecting invalid weight inputs (negative, NaN, missing keys).
 */

"use strict";

const {
  WEIGHTS,
  EXTRACTION_SHAPE_KEYS,
  MATCH_TYPES,
} = require("./scoringContract.js");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tolerance window for sum-to-1 validation. */
const SUM_TOLERANCE = 0.001;

/**
 * Canonical fallback weights (mirrors scoringContract WEIGHTS, expressed
 * as 0-1 values — already normalised since 0.60 + 0.25 + 0.15 = 1.00).
 */
const FALLBACK_WEIGHTS = Object.freeze({
  mustHaveWeight:   WEIGHTS.mustHaveWeight,   // 0.60
  niceToHaveWeight: WEIGHTS.niceToHaveWeight, // 0.25
  contextWeight:    WEIGHTS.contextWeight,    // 0.15
});

const REQUIRED_WEIGHT_KEYS = Object.freeze(Object.keys(FALLBACK_WEIGHTS));

// ---------------------------------------------------------------------------
// 1. Scale Conversion  (0-100 → 0-1)
// ---------------------------------------------------------------------------

/**
 * Converts a single score on the 0-100 scale to the 0-1 scale.
 * Clamps the result to [0, 1] to guard against out-of-range inputs.
 *
 * @param {number} score  Value in [0, 100]
 * @returns {number}      Value in [0, 1]
 */
function normalizeScore(score) {
  if (typeof score !== "number" || isNaN(score)) {
    throw new TypeError(`[normalizeConfig] normalizeScore expects a number, got: ${score}`);
  }
  return Math.min(1, Math.max(0, score / 100));
}

/**
 * Normalises an entire score map from 0-100 to 0-1.
 *
 * @param {{ [key: string]: number }} scoreMap
 * @returns {{ [key: string]: number }}
 */
function normalizeScoreMap(scoreMap) {
  if (!scoreMap || typeof scoreMap !== "object" || Array.isArray(scoreMap)) {
    throw new TypeError("[normalizeConfig] normalizeScoreMap expects a plain object.");
  }
  return Object.fromEntries(
    Object.entries(scoreMap).map(([k, v]) => [k, normalizeScore(v)])
  );
}

// ---------------------------------------------------------------------------
// 2. Weight Validation & Normalisation
// ---------------------------------------------------------------------------

/**
 * Checks that every required weight key is present, finite, and non-negative.
 * Throws a descriptive error on the first violation found.
 *
 * @param {object} weights
 */
function assertWeightInputsValid(weights) {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) {
    throw new TypeError("[normalizeConfig] Weights must be a plain object.");
  }

  for (const key of REQUIRED_WEIGHT_KEYS) {
    if (!(key in weights)) {
      throw new Error(`[normalizeConfig] Weight config is missing required key: "${key}".`);
    }

    const val = weights[key];

    if (typeof val !== "number" || isNaN(val)) {
      throw new TypeError(
        `[normalizeConfig] Weight "${key}" must be a number (got ${val}).`
      );
    }

    if (!isFinite(val)) {
      throw new RangeError(
        `[normalizeConfig] Weight "${key}" must be finite (got ${val}).`
      );
    }

    if (val < 0) {
      throw new RangeError(
        `[normalizeConfig] Weight "${key}" must be >= 0 (got ${val}).`
      );
    }
  }
}

/**
 * Validates that the weights in a config object sum to 1 within the allowed
 * tolerance (±0.001).  If validation passes, returns the config unchanged.
 * If it fails, logs a warning and returns the canonical 60/25/15 fallback.
 *
 * Rejects invalid inputs (negative values, NaN, missing keys) by throwing
 * before the sum check is attempted.
 *
 * @param {object} weights  Object with mustHaveWeight, niceToHaveWeight, contextWeight
 * @returns {object}        Validated (or fallback) weight config
 */
function validateAndNormalizeWeights(weights) {
  // Hard validation — throws on bad inputs before anything else.
  assertWeightInputsValid(weights);

  const sum = REQUIRED_WEIGHT_KEYS.reduce((acc, key) => acc + weights[key], 0);
  const delta = Math.abs(sum - 1);

  if (delta > SUM_TOLERANCE) {
    console.warn(
      `[normalizeConfig] Weight sum ${sum.toFixed(6)} deviates from 1.0 by ${delta.toFixed(6)} ` +
      `(tolerance ±${SUM_TOLERANCE}). Falling back to canonical weights: ` +
      `mustHave=${FALLBACK_WEIGHTS.mustHaveWeight}, ` +
      `niceToHave=${FALLBACK_WEIGHTS.niceToHaveWeight}, ` +
      `context=${FALLBACK_WEIGHTS.contextWeight}.`
    );
    return { ...FALLBACK_WEIGHTS };
  }

  return { ...weights };
}

// ---------------------------------------------------------------------------
// 3. Extraction Payload Validation
// ---------------------------------------------------------------------------

/**
 * Validates a single extraction payload against the contract shape:
 *   { keyword: string, found: boolean, matchType: 'exact' | 'semantic' }
 *
 * Returns true on success; throws a descriptive error on failure.
 *
 * @param {object} extraction
 * @returns {true}
 */
function validateExtractionPayload(extraction) {
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) {
    throw new TypeError("[normalizeConfig] Extraction payload must be a plain object.");
  }

  // Check for missing keys.
  for (const key of EXTRACTION_SHAPE_KEYS) {
    if (!(key in extraction)) {
      throw new Error(
        `[normalizeConfig] Extraction payload is missing required key: "${key}".`
      );
    }
  }

  // Validate keyword.
  if (typeof extraction.keyword !== "string" || extraction.keyword.trim() === "") {
    throw new TypeError(
      '[normalizeConfig] Extraction "keyword" must be a non-empty string.'
    );
  }

  // Validate found.
  if (typeof extraction.found !== "boolean") {
    throw new TypeError(
      '[normalizeConfig] Extraction "found" must be a boolean.'
    );
  }

  // Validate matchType.
  if (!Object.prototype.hasOwnProperty.call(MATCH_TYPES, extraction.matchType)) {
    throw new Error(
      `[normalizeConfig] Extraction "matchType" must be one of: ` +
      `${Object.values(MATCH_TYPES).join(", ")}. Received: "${extraction.matchType}".`
    );
  }

  return true;
}

/**
 * Validates an array of extraction payloads.
 * Throws on the first invalid entry, including its index for debugging.
 *
 * @param {object[]} extractions
 * @returns {true}
 */
function validateExtractionPayloads(extractions) {
  if (!Array.isArray(extractions)) {
    throw new TypeError("[normalizeConfig] Extractions must be an array.");
  }
  extractions.forEach((item, idx) => {
    try {
      validateExtractionPayload(item);
    } catch (err) {
      throw new Error(`[normalizeConfig] Invalid extraction at index ${idx}: ${err.message}`);
    }
  });
  return true;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  SUM_TOLERANCE,
  FALLBACK_WEIGHTS,
  REQUIRED_WEIGHT_KEYS,
  normalizeScore,
  normalizeScoreMap,
  assertWeightInputsValid,
  validateAndNormalizeWeights,
  validateExtractionPayload,
  validateExtractionPayloads,
};
