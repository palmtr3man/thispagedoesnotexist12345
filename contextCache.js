/**
 * contextCache.js  —  F91 Context Quality Cache
 * Version: 2.0.0
 *
 * Caches contextQuality scores (0-100) keyed by a stable SHA-256 hash of
 * (resumeText + jdText + model).  TTL: 90 days.
 *
 * The cache is in-process (Map-backed) by default.  A storage adapter
 * interface is exposed so callers can swap in a persistent backend
 * (Redis, DynamoDB, filesystem, etc.) without changing call sites.
 *
 * Exports:
 *   buildCacheKey(resumeText, jdText, model)  → string (hex SHA-256)
 *   set(key, contextQuality, [adapterOrTTL])  → CacheEntry
 *   get(key, [adapter])                       → number | null
 *   invalidate(key, [adapter])                → boolean
 *   purgeExpired([adapter])                   → number  (entries removed)
 *   createAdapter(readFn, writeFn, deleteFn)  → StorageAdapter
 *   DEFAULT_TTL_MS                            → number
 */

"use strict";

const { createHash } = require("crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 90 days expressed in milliseconds. */
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Default in-process storage (Map)
// ---------------------------------------------------------------------------

/** @type {Map<string, { contextQuality: number, expiresAt: number }>} */
const _inProcessStore = new Map();

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/**
 * Builds a stable, deterministic cache key by SHA-256 hashing the
 * concatenation of resumeText, jdText, and model.  The three fields are
 * delimited by a null byte to prevent boundary-collision attacks.
 *
 * @param {string} resumeText
 * @param {string} jdText
 * @param {string} model       Model identifier, e.g. "gpt-4o" or "v2.0.0"
 * @returns {string}           64-character lowercase hex string
 */
function buildCacheKey(resumeText, jdText, model) {
  if (typeof resumeText !== "string") throw new TypeError("[contextCache] resumeText must be a string.");
  if (typeof jdText     !== "string") throw new TypeError("[contextCache] jdText must be a string.");
  if (typeof model      !== "string" || model.trim() === "") {
    throw new TypeError("[contextCache] model must be a non-empty string.");
  }

  const payload = `${resumeText}\x00${jdText}\x00${model}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertValidContextQuality(value) {
  if (typeof value !== "number" || isNaN(value)) {
    throw new TypeError(`[contextCache] contextQuality must be a number (got ${value}).`);
  }
  if (value < 0 || value > 100) {
    throw new RangeError(`[contextCache] contextQuality must be in [0, 100] (got ${value}).`);
  }
}

function assertValidKey(key) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("[contextCache] Cache key must be a non-empty string.");
  }
}

// ---------------------------------------------------------------------------
// Storage adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates a storage adapter that wraps arbitrary async read/write/delete
 * functions.  All functions receive and return plain JS objects.
 *
 * @param {function(key: string): Promise<object|null>}         readFn
 * @param {function(key: string, entry: object): Promise<void>} writeFn
 * @param {function(key: string): Promise<void>}                deleteFn
 * @returns {{ read: function, write: function, delete: function }}
 */
function createAdapter(readFn, writeFn, deleteFn) {
  if (typeof readFn   !== "function") throw new TypeError("[contextCache] readFn must be a function.");
  if (typeof writeFn  !== "function") throw new TypeError("[contextCache] writeFn must be a function.");
  if (typeof deleteFn !== "function") throw new TypeError("[contextCache] deleteFn must be a function.");
  return { read: readFn, write: writeFn, delete: deleteFn };
}

// ---------------------------------------------------------------------------
// Core cache operations
// ---------------------------------------------------------------------------

/**
 * Writes a contextQuality score to the cache.
 *
 * @param {string}  key
 * @param {number}  contextQuality   Score in [0, 100]
 * @param {object}  [options]
 * @param {object}  [options.adapter]  StorageAdapter (defaults to in-process Map)
 * @param {number}  [options.ttlMs]    Override TTL in milliseconds
 * @returns {{ key: string, contextQuality: number, expiresAt: number, createdAt: number }}
 */
async function set(key, contextQuality, options = {}) {
  assertValidKey(key);
  assertValidContextQuality(contextQuality);

  const ttlMs    = (typeof options.ttlMs === "number" && options.ttlMs > 0)
    ? options.ttlMs
    : DEFAULT_TTL_MS;
  const now      = Date.now();
  const entry    = {
    key,
    contextQuality: parseFloat(contextQuality.toFixed(4)),
    createdAt:  now,
    expiresAt:  now + ttlMs,
  };

  if (options.adapter) {
    await options.adapter.write(key, entry);
  } else {
    _inProcessStore.set(key, entry);
  }

  return entry;
}

/**
 * Reads a contextQuality score from the cache.
 * Returns null on cache miss or if the entry has expired (and auto-deletes it).
 *
 * @param {string}  key
 * @param {object}  [adapter]  StorageAdapter (defaults to in-process Map)
 * @returns {Promise<number|null>}
 */
async function get(key, adapter) {
  assertValidKey(key);

  let entry;

  if (adapter) {
    entry = await adapter.read(key);
  } else {
    entry = _inProcessStore.get(key) ?? null;
  }

  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    // Auto-evict expired entry.
    if (adapter) {
      await adapter.delete(key);
    } else {
      _inProcessStore.delete(key);
    }
    return null;
  }

  return entry.contextQuality;
}

/**
 * Removes a single entry from the cache.
 *
 * @param {string}  key
 * @param {object}  [adapter]
 * @returns {Promise<boolean>}  true if the key existed and was removed
 */
async function invalidate(key, adapter) {
  assertValidKey(key);

  if (adapter) {
    await adapter.delete(key);
    return true;
  }

  return _inProcessStore.delete(key);
}

/**
 * Scans the in-process store and removes all expired entries.
 * Only meaningful for the default Map adapter; custom adapters should
 * implement their own TTL eviction.
 *
 * @returns {number}  Number of entries removed
 */
function purgeExpired() {
  const now     = Date.now();
  let   removed = 0;
  for (const [k, entry] of _inProcessStore.entries()) {
    if (now > entry.expiresAt) {
      _inProcessStore.delete(k);
      removed++;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  DEFAULT_TTL_MS,
  buildCacheKey,
  set,
  get,
  invalidate,
  purgeExpired,
  createAdapter,
  // Exposed for testing only.
  _inProcessStore,
};
