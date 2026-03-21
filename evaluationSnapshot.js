/**
 * evaluationSnapshot.js  —  F91 Evaluation Audit Snapshots
 * Version: 2.0.0
 *
 * Saves immutable audit records for every scoring run and provides a
 * diffSnapshots utility to surface changes between any two records.
 *
 * Each snapshot includes:
 *   - Contract version and the weights/thresholds config that were active
 *   - SHA-256 hashes of the raw inputs (resume + JD + model)
 *   - The full score payload from engine.js
 *   - A creation timestamp
 *
 * Snapshots are stored in-process (Array) by default.  The same
 * StorageAdapter pattern from contextCache.js is supported.
 *
 * Exports:
 *   saveSnapshot(scoreResult, inputHashes, [options]) → Snapshot
 *   getSnapshot(snapshotId, [adapter])                → Snapshot | null
 *   listSnapshots([adapter])                          → Snapshot[]
 *   diffSnapshots(a, b)                               → SnapshotDiff
 *   createAdapter(readFn, writeFn, listFn)            → StorageAdapter
 */

"use strict";

const { createHash }  = require("crypto");
const {
  VERSION,
  WEIGHTS,
  GATE_THRESHOLDS,
}                     = require("./scoringContract.js");

// ---------------------------------------------------------------------------
// In-process store
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const _snapshotStore = new Map();

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generates a deterministic snapshot ID from the score payload + timestamp.
 *
 * @param {object} scoreResult
 * @param {number} createdAt
 * @returns {string}  16-character hex prefix of SHA-256
 */
function _makeSnapshotId(scoreResult, createdAt) {
  const raw = JSON.stringify(scoreResult) + String(createdAt);
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Input guard helpers
// ---------------------------------------------------------------------------

function assertScoreResult(sr) {
  if (!sr || typeof sr !== "object" || Array.isArray(sr)) {
    throw new TypeError("[evaluationSnapshot] scoreResult must be a plain object.");
  }
  const required = ["version", "mustHaveScore", "niceToHaveScore",
                    "contextQuality", "totalScore", "gate",
                    "missingMustHaves", "weights", "counts"];
  for (const k of required) {
    if (!(k in sr)) {
      throw new Error(`[evaluationSnapshot] scoreResult missing required key: "${k}".`);
    }
  }
}

function assertInputHashes(ih) {
  if (!ih || typeof ih !== "object" || Array.isArray(ih)) {
    throw new TypeError("[evaluationSnapshot] inputHashes must be a plain object.");
  }
  const required = ["resumeHash", "jdHash", "model"];
  for (const k of required) {
    if (!(k in ih) || typeof ih[k] !== "string" || ih[k].trim() === "") {
      throw new Error(`[evaluationSnapshot] inputHashes missing or empty key: "${k}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot operations
// ---------------------------------------------------------------------------

/**
 * Creates and persists an immutable snapshot record.
 *
 * @param {object} scoreResult    Output from engine.scoreExtractions()
 * @param {object} inputHashes    { resumeHash, jdHash, model }
 * @param {object} [options]
 * @param {object} [options.adapter]  StorageAdapter
 * @param {object} [options.meta]     Free-form metadata to attach (e.g. userId, runId)
 *
 * @returns {Promise<object>}  The persisted snapshot
 */
async function saveSnapshot(scoreResult, inputHashes, options = {}) {
  assertScoreResult(scoreResult);
  assertInputHashes(inputHashes);

  const createdAt  = Date.now();
  const snapshotId = _makeSnapshotId(scoreResult, createdAt);

  const snapshot = Object.freeze({
    snapshotId,
    createdAt,
    // Contract metadata
    contractVersion: VERSION,
    weightsConfig:   { ...WEIGHTS },
    gateThresholds:  {
      departure: { ...GATE_THRESHOLDS.departure },
      boarding:  { ...GATE_THRESHOLDS.boarding  },
      security:  { ...GATE_THRESHOLDS.security  },
      checkIn:   { ...GATE_THRESHOLDS.checkIn   },
    },
    // Input provenance (hashed; never stores raw text)
    inputHashes: {
      resumeHash: inputHashes.resumeHash,
      jdHash:     inputHashes.jdHash,
      model:      inputHashes.model,
    },
    // Full score payload (deep copy to ensure immutability)
    scorePayload: JSON.parse(JSON.stringify(scoreResult)),
    // Optional caller metadata
    meta: options.meta ? { ...options.meta } : {},
  });

  if (options.adapter) {
    await options.adapter.write(snapshotId, snapshot);
  } else {
    _snapshotStore.set(snapshotId, snapshot);
  }

  return snapshot;
}

/**
 * Retrieves a single snapshot by ID.
 *
 * @param {string} snapshotId
 * @param {object} [adapter]
 * @returns {Promise<object|null>}
 */
async function getSnapshot(snapshotId, adapter) {
  if (typeof snapshotId !== "string" || snapshotId.trim() === "") {
    throw new TypeError("[evaluationSnapshot] snapshotId must be a non-empty string.");
  }
  if (adapter) return adapter.read(snapshotId);
  return _snapshotStore.get(snapshotId) ?? null;
}

/**
 * Lists all snapshots in chronological order (oldest first).
 *
 * @param {object} [adapter]
 * @returns {Promise<object[]>}
 */
async function listSnapshots(adapter) {
  if (adapter) return adapter.list();
  return [..._snapshotStore.values()].sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------

/**
 * Compares two snapshots and returns a structured diff highlighting every
 * field that changed between evaluation runs.
 *
 * Diff covers:
 *   - Score deltas (mustHave, niceToHave, context, total)
 *   - Gate change
 *   - Weight config change
 *   - Missing must-have keyword changes
 *   - Counts (found/total per category)
 *   - Input hash changes (detects when the resume/JD/model changed)
 *   - Contract version change
 *
 * @param {object} a  Earlier snapshot
 * @param {object} b  Later snapshot
 * @returns {{
 *   snapshotIds:   { from: string, to: string },
 *   timestamps:    { from: number, to: number },
 *   contractVersion: { changed: boolean, from: string, to: string },
 *   inputs:        { resumeChanged: boolean, jdChanged: boolean, modelChanged: boolean },
 *   scores: {
 *     mustHaveScore:    { from: number, to: number, delta: number },
 *     niceToHaveScore:  { from: number, to: number, delta: number },
 *     contextQuality:   { from: number, to: number, delta: number },
 *     totalScore:       { from: number, to: number, delta: number },
 *   },
 *   gate:    { changed: boolean, from: string, to: string },
 *   counts:  object,
 *   missingMustHaves: { added: string[], removed: string[] },
 *   weights: { changed: boolean, from: object, to: object },
 * }}
 */
function diffSnapshots(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    throw new TypeError("[evaluationSnapshot] diffSnapshots requires two snapshot objects.");
  }

  const aP = a.scorePayload;
  const bP = b.scorePayload;

  // Score deltas
  const scoreFields = ["mustHaveScore", "niceToHaveScore", "contextQuality", "totalScore"];
  const scores = {};
  for (const field of scoreFields) {
    const from  = aP[field] ?? 0;
    const to    = bP[field] ?? 0;
    scores[field] = {
      from,
      to,
      delta: parseFloat((to - from).toFixed(4)),
    };
  }

  // Missing must-haves — set diff
  const aMissing = new Set(aP.missingMustHaves ?? []);
  const bMissing = new Set(bP.missingMustHaves ?? []);
  const missingMustHaves = {
    added:   [...bMissing].filter(k => !aMissing.has(k)),   // newly missing
    removed: [...aMissing].filter(k => !bMissing.has(k)),   // no longer missing
  };

  // Count changes
  const counts = {
    mustHave: {
      from: aP.counts?.mustHave   ?? {},
      to:   bP.counts?.mustHave   ?? {},
    },
    niceToHave: {
      from: aP.counts?.niceToHave ?? {},
      to:   bP.counts?.niceToHave ?? {},
    },
  };

  // Weight config change (shallow compare serialised form)
  const aWeights = JSON.stringify(a.weightsConfig);
  const bWeights = JSON.stringify(b.weightsConfig);

  // Input provenance changes
  const aIn = a.inputHashes ?? {};
  const bIn = b.inputHashes ?? {};

  return {
    snapshotIds: { from: a.snapshotId, to: b.snapshotId },
    timestamps:  { from: a.createdAt,  to: b.createdAt  },
    contractVersion: {
      changed: a.contractVersion !== b.contractVersion,
      from:    a.contractVersion,
      to:      b.contractVersion,
    },
    inputs: {
      resumeChanged: aIn.resumeHash !== bIn.resumeHash,
      jdChanged:     aIn.jdHash     !== bIn.jdHash,
      modelChanged:  aIn.model      !== bIn.model,
    },
    scores,
    gate: {
      changed: aP.gate !== bP.gate,
      from:    aP.gate,
      to:      bP.gate,
    },
    counts,
    missingMustHaves,
    weights: {
      changed: aWeights !== bWeights,
      from:    a.weightsConfig,
      to:      b.weightsConfig,
    },
  };
}

// ---------------------------------------------------------------------------
// Storage adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates a storage adapter for external persistence backends.
 *
 * @param {function(id: string): Promise<object|null>}        readFn
 * @param {function(id: string, snap: object): Promise<void>} writeFn
 * @param {function(): Promise<object[]>}                     listFn
 * @returns {{ read: function, write: function, list: function }}
 */
function createAdapter(readFn, writeFn, listFn) {
  if (typeof readFn  !== "function") throw new TypeError("[evaluationSnapshot] readFn must be a function.");
  if (typeof writeFn !== "function") throw new TypeError("[evaluationSnapshot] writeFn must be a function.");
  if (typeof listFn  !== "function") throw new TypeError("[evaluationSnapshot] listFn must be a function.");
  return { read: readFn, write: writeFn, list: listFn };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  saveSnapshot,
  getSnapshot,
  listSnapshots,
  diffSnapshots,
  createAdapter,
  // Exposed for testing only.
  _snapshotStore,
};
