/**
 * Gate 7 pre-flight: compare Infisical-injected values with Netlify site environments.
 *
 * Ported from career-navigator MR !73 (`scripts/drift-check.ts`) and adapted to this
 * repo's env-var conventions (`NETLIFY_SITE_ID`, matching `.github/workflows/drift-check.yml`
 * and `scripts/sync-drift-keys.ts`). Unlike `scripts/drift-check.ts` / `sync-drift-keys.ts`
 * (which only check *presence* of keys), this checker verifies the Infisical-injected value
 * and the Netlify-stored value are byte-for-byte identical, without ever logging the raw value.
 */
import { pathToFileURL } from "node:url";

const OFFICIAL_NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

const TARGET_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SEC06_INTERNAL_TOKEN",
  "SENDGRID_API_KEY",
] as const;

type TargetKey = (typeof TARGET_KEYS)[number];

type Site = { name: string; id: string };

type NetlifyEnvItem = {
  key?: string;
  value?: string | null;
  values?: Array<{ value?: string | null; context?: string }>;
};

/** This repo does not remap any of the target keys on Netlify; kept for parity with upstream. */
const RESERVED_PREFIX_REMAP: Record<string, string> = {};

export function remapNetlifyKey(sourceKey: string): string {
  return RESERVED_PREFIX_REMAP[sourceKey] ?? sourceKey;
}

export function assertOfficialNetlifyApiBase(apiBase: string): string {
  const normalized = apiBase.replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`NETLIFY_API_URL is not a valid URL: ${apiBase}`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.netlify.com") {
    throw new Error(`Refusing non-official Netlify API host: ${normalized}`);
  }
  return normalized;
}

function fail(message: string): never {
  throw new Error(message);
}

function resolveApiToken(): string {
  const token =
    process.env.NETLIFY_ACCESS_TOKEN?.trim() ||
    process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!token) {
    fail("NETLIFY_ACCESS_TOKEN (or NETLIFY_AUTH_TOKEN) is not set");
  }
  return token;
}

export function parseSites(): Site[] {
  const configured = process.env.NETLIFY_SITE_IDS?.trim();
  if (configured) {
    try {
      const parsed: unknown = JSON.parse(configured);
      if (!Array.isArray(parsed)) {
        fail("NETLIFY_SITE_IDS must be a JSON array");
      }
      return parsed.flatMap((site, index): Site[] => {
        if (typeof site === "string" && site.trim()) {
          return [{ name: `site-${index + 1}`, id: site.trim() }];
        }
        if (typeof site !== "object" || site === null) return [];
        const record = site as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const name =
          typeof record.name === "string" && record.name.trim()
            ? record.name.trim()
            : `site-${index + 1}`;
        return id ? [{ name, id }] : [];
      });
    } catch (error) {
      fail(
        `NETLIFY_SITE_IDS must be valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const singleSiteId =
    process.env.NETLIFY_SITE_ID?.trim() ||
    process.env.NETLIFY_PROD_SITE_ID?.trim();
  if (singleSiteId) {
    return [{ name: "Prod", id: singleSiteId }];
  }

  fail(
    "No Netlify site configured: set NETLIFY_SITE_ID, NETLIFY_PROD_SITE_ID, or NETLIFY_SITE_IDS",
  );
}

export function digest(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fingerprint(value: string | undefined): string {
  if (!value) return "MISSING";
  const preview =
    value.length <= 8 ? "**" : `${value.slice(0, 4)}…${value.slice(-4)}`;
  return `${preview} [checksum:${digest(value)}]`;
}

export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function resolveNetlifyValue(
  item: NetlifyEnvItem,
  context: string,
): string | undefined {
  const scoped =
    item.values?.find((entry) => entry.context === context)?.value ??
    item.values?.find((entry) => entry.context === "production")?.value ??
    item.values?.[0]?.value;
  const value = item.value ?? scoped;
  return value == null ? undefined : value;
}

export async function getNetlifyEnv(
  site: Site,
  apiBase: string,
  apiToken: string,
  context: string,
): Promise<Map<string, string>> {
  const response = await fetch(
    `${apiBase}/sites/${encodeURIComponent(site.id)}/env`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `${site.name} (${site.id}) returned HTTP ${response.status}`,
    );
  }

  const body: unknown = await response.json();
  let items: NetlifyEnvItem[] = [];
  if (Array.isArray(body)) {
    items = body.filter(
      (item): item is NetlifyEnvItem =>
        typeof item === "object" && item !== null,
    );
  } else if (
    typeof body === "object" &&
    body !== null &&
    "variables" in body &&
    Array.isArray((body as { variables: unknown }).variables)
  ) {
    items = (body as { variables: unknown[] }).variables.filter(
      (item): item is NetlifyEnvItem =>
        typeof item === "object" && item !== null,
    );
  }

  const result = new Map<string, string>();
  for (const item of items) {
    if (!item.key) continue;
    const value = resolveNetlifyValue(item, context);
    if (value != null) result.set(item.key, value);
  }
  return result;
}

export async function runDriftCheck(): Promise<boolean> {
  const apiBase = assertOfficialNetlifyApiBase(
    process.env.NETLIFY_API_URL ?? OFFICIAL_NETLIFY_API_BASE,
  );
  const apiToken = resolveApiToken();
  const context = process.env.NETLIFY_CONTEXT?.trim() || "production";
  const sites = parseSites();
  const started = Date.now();

  console.log("Gate 7 | Netlify ↔ Infisical environment parity pre-flight");
  if (!sites.length) fail("No Netlify sites configured");
  console.log(
    `Telemetry | targets=${TARGET_KEYS.length} sites=${sites.length} api=${apiBase} context=${context}`,
  );

  const envBySite = await Promise.all(
    sites.map(async (site) => [site, await getNetlifyEnv(site, apiBase, apiToken, context)] as const),
  );

  let passed = true;
  for (const key of TARGET_KEYS) {
    const source = process.env[key]?.trim();
    if (!source) passed = false;

    const netlifyKey = remapNetlifyKey(key);
    const statuses = envBySite.map(([site, env]) => {
      const remote = env.get(netlifyKey);
      const ok = Boolean(source) && remote !== undefined && same(source!, remote);
      passed &&= ok;
      const label =
        remote === undefined
          ? "MISSING"
          : ok
            ? `MATCH ${fingerprint(remote)}`
            : `DRIFT ${fingerprint(remote)}`;
      const keyLabel = netlifyKey === key ? key : `${key}→${netlifyKey}`;
      return `${site.name}:${keyLabel}:${label}`;
    });

    console.log(
      `${key} | Infisical: ${fingerprint(source)} | ${statuses.join(" | ")}`,
    );
  }

  console.log(
    `Gate 7 summary | ${passed ? "PASS" : "FAIL"} | durationMs=${Date.now() - started}`,
  );
  if (!passed) fail("Gate 7 failed: environment drift or missing keys detected");
  return passed;
}

async function main(): Promise<void> {
  await runDriftCheck();
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(
      `ERROR: Netlify parity check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
