import { InfisicalSDK } from "@infisical/sdk";
import { ALIAS_GROUPS, P0_KEYS, P1_KEYS } from "./parity-manifest.js";

const INFISICAL_PROJECT_ID = "6c7646e9-04dd-484a-a5d1-612b9582da15";
const INFISICAL_SITE_URL = "https://us.infisical.com";
const INFISICAL_ENV = "staging";
const INFISICAL_PATH = "/";

const MANIFEST_KEYS = [...new Set([...P0_KEYS, ...P1_KEYS])];

/** Canonical values not present on either side yet. */
const CANONICAL_VALUES: Record<string, string> = {
  NOTION_SEAT_DB_ID: "d758a4fd54814ea9b036eeae34586f11",
  NOTION_JD_PIPELINE_DB_ID: "2dbbc9d7-494c-803d-9670-ec7be3598789",
  NOTION_DRIFT_REPORT_DB_ID: "398bc9d7494c819494cfdb5b41de8f6d",
};

interface NetlifyEnvVar {
  id?: string;
  key?: string;
  scopes?: string[];
  values?: { context?: string; value?: string }[];
}

function resolveAlias(key: string, keys: Set<string>): string | null {
  if (keys.has(key)) return key;
  const group = ALIAS_GROUPS.find((aliases) => aliases.includes(key));
  if (!group) return null;
  return group.find((alias) => keys.has(alias)) ?? null;
}

async function fetchInfisicalMap(
  client: InfisicalSDK
): Promise<Map<string, string>> {
  const response = await client.secrets().listSecrets({
    projectId: INFISICAL_PROJECT_ID,
    environment: INFISICAL_ENV,
    secretPath: INFISICAL_PATH,
    viewSecretValue: true,
  });

  return new Map(
    (response.secrets ?? [])
      .filter((secret) => secret.secretKey && secret.secretValue !== undefined)
      .map((secret) => [secret.secretKey as string, secret.secretValue as string])
  );
}

async function fetchNetlifyMap(
  authToken: string,
  siteId: string
): Promise<{ accountId: string; vars: Map<string, NetlifyEnvVar> }> {
  const siteRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
  });
  if (!siteRes.ok) {
    throw new Error(`Netlify site lookup failed: ${siteRes.status}`);
  }
  const site = (await siteRes.json()) as { account_id?: string };
  if (!site.account_id) throw new Error("Netlify account_id missing from site response");

  const envRes = await fetch(
    `https://api.netlify.com/api/v1/sites/${siteId}/env?context_name=production`,
    { headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" } }
  );
  if (!envRes.ok) {
    throw new Error(`Netlify env lookup failed: ${envRes.status}`);
  }
  const envVars = (await envRes.json()) as NetlifyEnvVar[];
  const vars = new Map<string, NetlifyEnvVar>();
  for (const entry of envVars) {
    if (entry.key) vars.set(entry.key, entry);
  }
  return { accountId: site.account_id, vars };
}

function netlifyValue(entry: NetlifyEnvVar | undefined): string | undefined {
  if (!entry?.values?.length) return undefined;
  return (
    entry.values.find((v) => v.context === "production" || v.context === "all")
      ?.value ?? entry.values[0]?.value
  );
}

async function upsertInfisicalSecret(
  client: InfisicalSDK,
  key: string,
  value: string,
  existing: Set<string>
): Promise<void> {
  if (existing.has(key)) {
    await client.secrets().updateSecret(key, {
      projectId: INFISICAL_PROJECT_ID,
      environment: INFISICAL_ENV,
      secretPath: INFISICAL_PATH,
      secretValue: value,
    });
    console.log(`  ↻ Infisical updated ${key}`);
    return;
  }

  await client.secrets().createSecret(key, {
    projectId: INFISICAL_PROJECT_ID,
    environment: INFISICAL_ENV,
    secretPath: INFISICAL_PATH,
    secretValue: value,
  });
  console.log(`  + Infisical created ${key}`);
}

async function upsertNetlifySecret(
  authToken: string,
  accountId: string,
  siteId: string,
  key: string,
  value: string,
  existing: NetlifyEnvVar | undefined
): Promise<void> {
  const scopes = existing?.scopes ?? ["builds", "functions", "runtime"];
  const context = existing?.values?.[0]?.context ?? "all";
  const envVar = {
    key,
    scopes,
    values: [{ context, value }],
  };

  if (existing?.id) {
    const res = await fetch(
      `https://api.netlify.com/api/v1/accounts/${accountId}/env/${encodeURIComponent(key)}?site_id=${siteId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify([envVar]),
      }
    );
    if (!res.ok) {
      throw new Error(`Netlify update ${key} failed: ${res.status} ${await res.text()}`);
    }
    console.log(`  ↻ Netlify updated ${key}`);
    return;
  }

  const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/${accountId}/env?site_id=${siteId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([envVar]),
    }
  );
  if (!res.ok) {
    throw new Error(`Netlify create ${key} failed: ${res.status} ${await res.text()}`);
  }
  console.log(`  + Netlify created ${key}`);
}

async function main(): Promise<void> {
  const infisicalToken = process.env.INFISICAL_TOKEN;
  const netlifyAuthToken =
    process.env.NETLIFY_AUTH_TOKEN ?? process.env.NETLIFY_API_TOKEN;
  const netlifySiteId = process.env.NETLIFY_SITE_ID;

  if (!infisicalToken) throw new Error("INFISICAL_TOKEN is not set");
  if (!netlifyAuthToken) throw new Error("NETLIFY_AUTH_TOKEN is not set");
  if (!netlifySiteId) throw new Error("NETLIFY_SITE_ID is not set");

  const client = new InfisicalSDK({ siteUrl: INFISICAL_SITE_URL });
  await client.auth().accessToken(infisicalToken);

  const infisicalMap = await fetchInfisicalMap(client);
  const infisicalKeys = new Set(infisicalMap.keys());
  const { accountId, vars: netlifyVars } = await fetchNetlifyMap(
    netlifyAuthToken,
    netlifySiteId
  );
  const netlifyKeys = new Set(netlifyVars.keys());

  const expectedOnNetlify = new Set([...infisicalKeys, ...MANIFEST_KEYS]);
  const missingOnNetlify = [...expectedOnNetlify].filter(
    (key) => !resolveAlias(key, netlifyKeys)
  );
  const missingInInfisical = MANIFEST_KEYS.filter(
    (key) => !resolveAlias(key, infisicalKeys)
  );

  console.log("[sync] Applying canonical values…");
  for (const [key, value] of Object.entries(CANONICAL_VALUES)) {
    if (!infisicalMap.has(key)) {
      await upsertInfisicalSecret(client, key, value, infisicalKeys);
      infisicalMap.set(key, value);
      infisicalKeys.add(key);
    }
    if (!netlifyVars.has(key)) {
      await upsertNetlifySecret(
        netlifyAuthToken,
        accountId,
        netlifySiteId,
        key,
        value,
        netlifyVars.get(key)
      );
      netlifyKeys.add(key);
    }
  }

  console.log("[sync] Infisical → Netlify");
  for (const key of missingOnNetlify) {
    if (CANONICAL_VALUES[key]) continue;
    const value = infisicalMap.get(key);
    if (!value) continue;
    await upsertNetlifySecret(
      netlifyAuthToken,
      accountId,
      netlifySiteId,
      key,
      value,
      netlifyVars.get(key)
    );
  }

  console.log("[sync] Netlify → Infisical");
  for (const key of missingInInfisical) {
    if (CANONICAL_VALUES[key]) continue;
    const alias = resolveAlias(key, netlifyKeys);
    if (!alias) continue;
    const value = netlifyValue(netlifyVars.get(alias));
    if (!value) continue;
    await upsertInfisicalSecret(client, key, value, infisicalKeys);
  }

  console.log("[sync] Done. Re-run npm run drift-check to verify.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
