/** Unit tests for Gate 7 drift-check helpers (no live Netlify/Infisical calls). */
import assert from "node:assert/strict";
import {
  assertOfficialNetlifyApiBase,
  digest,
  fingerprint,
  parseSites,
  remapNetlifyKey,
  same,
} from "./gate7-drift-check.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    throw error;
  }
}

test("remapNetlifyKey is a no-op for this repo's target keys", () => {
  assert.equal(remapNetlifyKey("SUPABASE_URL"), "SUPABASE_URL");
  assert.equal(
    remapNetlifyKey("SUPABASE_SERVICE_ROLE_KEY"),
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  assert.equal(remapNetlifyKey("SEC06_INTERNAL_TOKEN"), "SEC06_INTERNAL_TOKEN");
});

test("assertOfficialNetlifyApiBase accepts official host only", () => {
  assert.equal(
    assertOfficialNetlifyApiBase("https://api.netlify.com/api/v1/"),
    "https://api.netlify.com/api/v1",
  );
  assert.throws(
    () => assertOfficialNetlifyApiBase("https://evil.example/api/v1"),
    /Refusing non-official Netlify API host/,
  );
});

test("parseSites prefers NETLIFY_SITE_ID", () => {
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const previousSiteIds = process.env.NETLIFY_SITE_IDS;
  const previousProdSiteId = process.env.NETLIFY_PROD_SITE_ID;
  delete process.env.NETLIFY_SITE_IDS;
  delete process.env.NETLIFY_PROD_SITE_ID;
  process.env.NETLIFY_SITE_ID = "site-abc";
  try {
    assert.deepEqual(parseSites(), [{ name: "Prod", id: "site-abc" }]);
  } finally {
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
    if (previousSiteIds === undefined) delete process.env.NETLIFY_SITE_IDS;
    else process.env.NETLIFY_SITE_IDS = previousSiteIds;
    if (previousProdSiteId === undefined)
      delete process.env.NETLIFY_PROD_SITE_ID;
    else process.env.NETLIFY_PROD_SITE_ID = previousProdSiteId;
  }
});

test("parseSites parses NETLIFY_SITE_IDS JSON", () => {
  const previousSiteIds = process.env.NETLIFY_SITE_IDS;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  delete process.env.NETLIFY_SITE_ID;
  process.env.NETLIFY_SITE_IDS = JSON.stringify([
    { name: "Prod", id: "prod-id" },
    "studio-id",
  ]);
  try {
    assert.deepEqual(parseSites(), [
      { name: "Prod", id: "prod-id" },
      { name: "site-2", id: "studio-id" },
    ]);
  } finally {
    if (previousSiteIds === undefined) delete process.env.NETLIFY_SITE_IDS;
    else process.env.NETLIFY_SITE_IDS = previousSiteIds;
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
  }
});

test("parseSites fails closed when nothing is configured", () => {
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const previousSiteIds = process.env.NETLIFY_SITE_IDS;
  const previousProdSiteId = process.env.NETLIFY_PROD_SITE_ID;
  delete process.env.NETLIFY_SITE_ID;
  delete process.env.NETLIFY_SITE_IDS;
  delete process.env.NETLIFY_PROD_SITE_ID;
  try {
    assert.throws(() => parseSites(), /No Netlify site configured/);
  } finally {
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
    if (previousSiteIds === undefined) delete process.env.NETLIFY_SITE_IDS;
    else process.env.NETLIFY_SITE_IDS = previousSiteIds;
    if (previousProdSiteId === undefined)
      delete process.env.NETLIFY_PROD_SITE_ID;
    else process.env.NETLIFY_PROD_SITE_ID = previousProdSiteId;
  }
});

test("fingerprint never prints full secret values", () => {
  const value = "super-secret-token-value";
  const rendered = fingerprint(value);
  assert.match(rendered, /checksum:/);
  assert.doesNotMatch(rendered, /super-secret-token-value/);
});

test("same uses constant-time comparison semantics", () => {
  assert.equal(same("abc", "abc"), true);
  assert.equal(same("abc", "abd"), false);
  assert.equal(same("abc", "ab"), false);
});

test("digest is stable", () => {
  assert.equal(digest("test"), digest("test"));
  assert.notEqual(digest("test"), digest("test2"));
});

console.log("All gate7-drift-check helper tests passed.");
