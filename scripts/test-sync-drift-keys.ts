/** Unit tests for sync-drift-keys helpers (no live Netlify/Infisical calls). */
import assert from "node:assert/strict";
import { buildNetlifyValuesPayload, upsertNetlifySecret } from "./sync-drift-keys.js";

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    throw error;
  }
}

interface RecordedCall {
  url: string;
  method?: string;
  body?: unknown;
}

async function withMockFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

async function main(): Promise<void> {
  await test("buildNetlifyValuesPayload defaults to a single 'all' context when none exists", () => {
    assert.deepEqual(buildNetlifyValuesPayload("v1", undefined), [
      { context: "all", value: "v1" },
    ]);
    assert.deepEqual(buildNetlifyValuesPayload("v1", []), [
      { context: "all", value: "v1" },
    ]);
  });

  await test("buildNetlifyValuesPayload preserves every existing context, including branch overrides", () => {
    const result = buildNetlifyValuesPayload("new-value", [
      { context: "production", value: "old-prod" },
      { context: "deploy-preview", value: "old-preview" },
      { context: "branch-deploy", context_parameter: "staging", value: "old-branch" },
    ]);

    assert.deepEqual(result, [
      { context: "production", value: "new-value" },
      { context: "deploy-preview", value: "new-value" },
      { context: "branch-deploy", context_parameter: "staging", value: "new-value" },
    ]);
  });

  await test("upsertNetlifySecret PATCHes all existing contexts instead of clobbering them", async () => {
    const calls: RecordedCall[] = [];

    await withMockFetch(
      (url, init) => {
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return new Response(JSON.stringify({}), { status: 200 });
      },
      () =>
        upsertNetlifySecret("token", "account-1", "site-1", "SUPABASE_URL", "new-value", {
          key: "SUPABASE_URL",
          scopes: ["builds", "functions", "runtime"],
          values: [
            { context: "production", value: "old-prod" },
            { context: "deploy-preview", value: "old-preview" },
            { context: "branch-deploy", context_parameter: "staging", value: "old-branch" },
          ],
        })
    );

    assert.equal(calls.length, 1, "expected exactly one PATCH request for an existing var");
    assert.equal(calls[0].method, "PATCH");
    const sentValues = (calls[0].body as { values: Array<Record<string, string>> }).values;
    assert.equal(sentValues.length, 3, "all three contexts must be preserved, not just the first");

    const byContext = new Map(sentValues.map((entry) => [entry.context, entry]));
    assert.equal(byContext.get("production")?.value, "new-value");
    assert.equal(byContext.get("deploy-preview")?.value, "new-value");
    assert.equal(byContext.get("branch-deploy")?.value, "new-value");
    assert.equal(byContext.get("branch-deploy")?.context_parameter, "staging");
  });

  await test("upsertNetlifySecret creates a single 'all' context value when the key is new", async () => {
    const calls: RecordedCall[] = [];

    await withMockFetch(
      (url, init) => {
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return new Response(JSON.stringify({}), { status: 200 });
      },
      () => upsertNetlifySecret("token", "account-1", "site-1", "NEW_KEY", "v1", undefined)
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    const body = calls[0].body as Array<{ values: Array<Record<string, string>> }>;
    assert.deepEqual(body[0].values, [{ context: "all", value: "v1" }]);
  });

  console.log("All sync-drift-keys helper tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
