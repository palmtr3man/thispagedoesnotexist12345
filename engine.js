/**
 * engine.js  —  F91 Pass-2 Scoring Engine
 * Version: 2.0.0
 *
 * Implements deterministic, contract-bound scoring for the two-pass match
 * pipeline.  Pass 1 (extraction) must have already produced an array of
 * extraction objects conforming to the { keyword, found, matchType } shape
 * declared in scoringContract.js before this module is called.
 *
 * Exports:
 *   scoreExtractions(mustHaves, niceToHaves, contextQuality) → ScoreResult
 *   scoreFromRawExtraction(rawMustHaves, rawNiceToHaves, contextQuality) → ScoreResult
 */

"use strict";

const {
  WEIGHTS,
  GATE_THRESHOLDS,
  validateExtraction,
  resolveGate,
} = require("./scoringContract.js");

const { validateAndNormalizeWeights } = require("./normalizeConfig.js");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Counts found / total across a validated extraction array.
 *
 * @param {Array<{keyword:string, found:boolean, matchType:string}>} extractions
 * @returns {{ found: number, total: number, missing: string[] }}
 */
function countFound(extractions) {
  let found = 0;
  const missing = [];

  for (const item of extractions) {
    if (item.found) {
      found++;
    } else {
      missing.push(item.keyword);
    }
  }

  return { found, total: extractions.length, missing };
}

/**
 * Computes a sub-score on the 0-100 scale.
 * Returns 0 when total is 0 (no keywords defined → no penalty, no credit).
 *
 * @param {number} found
 * @param {number} total
 * @returns {number}
 */
function subScore(found, total) {
  if (total === 0) return 0;
  return (found / total) * 100;
}

// ---------------------------------------------------------------------------
// Core scoring function
// ---------------------------------------------------------------------------

/**
 * Runs Pass-2 scoring against pre-validated extraction arrays.
 *
 * @param {Array<{keyword:string,found:boolean,matchType:string}>} mustHaves
 *   Validated extraction results for must-have keywords.
 *
 * @param {Array<{keyword:string,found:boolean,matchType:string}>} niceToHaves
 *   Validated extraction results for nice-to-have keywords.
 *
 * @param {number} contextQuality
 *   Context quality score on the 0-100 scale, typically sourced from the
 *   context cache (contextCache.js).
 *
 * @param {object} [weightsOverride]
 *   Optional weight override.  If provided it is validated and normalised
 *   through normalizeConfig; falls back to canonical 60/25/15 on bad input.
 *   Defaults to WEIGHTS from scoringContract.
 *
 * @returns {{
 *   version: string,
 *   mustHaveScore:    number,
 *   niceToHaveScore:  number,
 *   contextQuality:   number,
 *   totalScore:       number,
 *   gate:             string,
 *   missingMustHaves: string[],
 *   weights:          object,
 *   counts: {
 *     mustHave:    { found: number, total: number },
 *     niceToHave:  { found: number, total: number },
 *   }
 * }}
 */
function scoreExtractions(mustHaves, niceToHaves, contextQuality, weightsOverride) {
  // ── Input guards ──────────────────────────────────────────────────────────
  if (!Array.isArray(mustHaves)) {
    throw new TypeError("[engine] mustHaves must be an array.");
  }
  if (!Array.isArray(niceToHaves)) {
    throw new TypeError("[engine] niceToHaves must be an array.");
  }
  if (typeof contextQuality !== "number" || isNaN(contextQuality)) {
    throw new TypeError("[engine] contextQuality must be a number.");
  }

  // Validate every extraction item via contract.
  mustHaves.forEach((item, i) => {
    try { validateExtraction(item); }
    catch (e) { throw new Error(`[engine] mustHaves[${i}]: ${e.message}`); }
  });
  niceToHaves.forEach((item, i) => {
    try { validateExtraction(item); }
    catch (e) { throw new Error(`[engine] niceToHaves[${i}]: ${e.message}`); }
  });

  // ── Resolve weights ───────────────────────────────────────────────────────
  const weights = validateAndNormalizeWeights(
    weightsOverride ?? { ...WEIGHTS }
  );

  // ── Sub-scores (0-100 scale) ───────────────────────────────────────────────
  const mhCounts  = countFound(mustHaves);
  const nthCounts = countFound(niceToHaves);

  const mustHaveScore   = subScore(mhCounts.found,  mhCounts.total);
  const niceToHaveScore = subScore(nthCounts.found, nthCounts.total);

  // Clamp contextQuality to [0, 100] defensively.
  const cq = Math.min(100, Math.max(0, contextQuality));

  // ── Composite score (formula from spec) ───────────────────────────────────
  //   totalScore = (mustHave * 0.60) + (niceToHave * 0.25) + (contextQuality * 0.15)
  const totalScore =
    mustHaveScore   * weights.mustHaveWeight   +
    niceToHaveScore * weights.niceToHaveWeight +
    cq              * weights.contextWeight;

  // ── Gate resolution ───────────────────────────────────────────────────────
  const gate = resolveGate(totalScore, mustHaveScore, mhCounts.missing.length);

  return {
    version:          "2.0.0",
    mustHaveScore:    parseFloat(mustHaveScore.toFixed(4)),
    niceToHaveScore:  parseFloat(niceToHaveScore.toFixed(4)),
    contextQuality:   parseFloat(cq.toFixed(4)),
    totalScore:       parseFloat(totalScore.toFixed(4)),
    gate,
    missingMustHaves: mhCounts.missing,
    weights:          { ...weights },
    counts: {
      mustHave:   { found: mhCounts.found,  total: mhCounts.total  },
      niceToHave: { found: nthCounts.found, total: nthCounts.total },
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper: validates raw extractions before scoring
// ---------------------------------------------------------------------------

/**
 * Identical to scoreExtractions but accepts unvalidated raw arrays and
 * validates them in full before scoring.  Useful when the caller cannot
 * guarantee pre-validation.
 *
 * @param {unknown[]} rawMustHaves
 * @param {unknown[]} rawNiceToHaves
 * @param {number}    contextQuality
 * @param {object}    [weightsOverride]
 * @returns {object}  Same shape as scoreExtractions return value.
 */
function scoreFromRawExtraction(rawMustHaves, rawNiceToHaves, contextQuality, weightsOverride) {
  if (!Array.isArray(rawMustHaves) || !Array.isArray(rawNiceToHaves)) {
    throw new TypeError("[engine] rawMustHaves and rawNiceToHaves must both be arrays.");
  }
  // validateExtraction is called again inside scoreExtractions — this wrapper
  // just surfaces errors with a clearer "raw" prefix for debugging.
  return scoreExtractions(rawMustHaves, rawNiceToHaves, contextQuality, weightsOverride);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  scoreExtractions,
  scoreFromRawExtraction,
  // Expose internals for unit testing
  _subScore:  subScore,
  _countFound: countFound,
};
