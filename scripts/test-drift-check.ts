/** Unit tests for drift-check helpers (no live Netlify/Infisical calls). */
import assert from "node:assert/strict";
import { requireEnv } from "./drift-check.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    throw error;
  }
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("requireEnv returns the trimmed value when set", () => {
  withEnv("TEST_DRIFT_CHECK_VAR", "  a-real-token  ", () => {
    assert.equal(requireEnv("TEST_DRIFT_CHECK_VAR"), "a-real-token");
  });
});

test("requireEnv rejects a missing variable", () => {
  withEnv("TEST_DRIFT_CHECK_MISSING", undefined, () => {
    assert.throws(
      () => requireEnv("TEST_DRIFT_CHECK_MISSING"),
      /TEST_DRIFT_CHECK_MISSING is not set/
    );
  });
});

test("requireEnv rejects an empty string", () => {
  withEnv("TEST_DRIFT_CHECK_EMPTY", "", () => {
    assert.throws(
      () => requireEnv("TEST_DRIFT_CHECK_EMPTY"),
      /TEST_DRIFT_CHECK_EMPTY is not set/
    );
  });
});

test("requireEnv rejects a whitespace-only string", () => {
  withEnv("TEST_DRIFT_CHECK_WHITESPACE", "   \t\n  ", () => {
    assert.throws(
      () => requireEnv("TEST_DRIFT_CHECK_WHITESPACE"),
      /TEST_DRIFT_CHECK_WHITESPACE is not set/
    );
  });
});

console.log("All drift-check helper tests passed.");
