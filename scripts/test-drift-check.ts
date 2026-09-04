/** Unit tests for drift-check helpers (no live Netlify/Infisical calls). */
import assert from "node:assert/strict";
import { isKeyPresent, requireEnv } from "./drift-check.js";

/**
 * Runs a test function and logs the result with a checkmark or error indicator.
 * @param name - The descriptive name of the test
 * @param fn - The test function to execute
 */
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    throw error;
  }
}

/**
 * Temporarily sets an environment variable for the duration of a test function,
 * then restores the original value.
 * @param name - The environment variable name
 * @param value - The value to set (undefined to delete the variable)
 * @param fn - The test function to execute with the modified environment
 */
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

test("isKeyPresent treats BASE44_AUTH_JSON and BASE44_API_KEY as an alias group", () => {
  assert.equal(isKeyPresent("BASE44_AUTH_JSON", new Set(["BASE44_API_KEY"])), true);
  assert.equal(isKeyPresent("BASE44_AUTH_JSON", new Set(["BASE44APIKEY"])), true);
  assert.equal(isKeyPresent("BASE44_API_KEY", new Set(["BASE44_AUTH_JSON"])), true);
  assert.equal(isKeyPresent("BASE44_AUTH_JSON", new Set(["BASE44_AUTH_JSON"])), true);
});

test("isKeyPresent still reports drift when every Base44 alias is missing", () => {
  assert.equal(isKeyPresent("BASE44_AUTH_JSON", new Set(["BASE44_APP_ID"])), false);
  assert.equal(isKeyPresent("BASE44_AUTH_JSON", new Set()), false);
});

console.log("All drift-check helper tests passed.");
