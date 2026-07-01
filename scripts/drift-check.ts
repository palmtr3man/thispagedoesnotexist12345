import { InfisicalSDK } from "@infisical/sdk";
import { ALIAS_GROUPS, P0_KEYS, P1_KEYS } from "./parity-manifest.js";

const INFISICAL_PROJECT_ID = "6c7646e9-04dd-484a-a5d1-612b9582da15";
const INFISICAL_SITE_URL = "https://us.infisical.com";
const INFISICAL_ENV = "staging";
const INFISICAL_PATH = "/tuj";

interface NetlifyEnvVar {
  key?: string;
}

function isKeyPresent(key: string, present: Set<string>): boolean {
  if (present.has(key)) return true;
  const group = ALIAS_GROUPS.find((aliases) => aliases.includes(key));
  return group ? group.some((alias) => present.has(alias)) : false;
}

async function fetchInfisicalKeys(token: string): Promise<Set<string>> {
  const client = new InfisicalSDK({ siteUrl: INFISICAL_SITE_URL });
  await client.auth().accessToken(token);

  const response = await client.secrets().listSecrets({
    projectId: INFISICAL_PROJECT_ID,
    environment: INFISICAL_ENV,
    secretPath: INFISICAL_PATH,
    viewSecretValue: false,
  });

  const keys = (response.secrets ?? [])
    .map((secret) => secret.secretKey)
    .filter((key): key is string => Boolean(key));

  return new Set(keys);
}

async function fetchNetlifyKeys(
  authToken: string,
  siteId: string
): Promise<Set<string>> {
  const url = new URL(`https://api.netlify.com/api/v1/sites/${siteId}/env`);
  url.searchParams.set("context_name", "production");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Netlify API HTTP ${response.status}: ${body}`);
  }

  const envVars = (await response.json()) as NetlifyEnvVar[];
  return new Set(
    envVars.map((entry) => entry.key).filter((key): key is string => Boolean(key))
  );
}

function reportDrift(
  strictness: string,
  missingOnNetlify: string[],
  missingInInfisical: string[]
): void {
  const issues: string[] = [];

  if (missingOnNetlify.length > 0) {
    issues.push(`missing on Netlify: ${missingOnNetlify.join(", ")}`);
  }
  if (missingInInfisical.length > 0) {
    issues.push(`missing in Infisical ${INFISICAL_PATH}: ${missingInInfisical.join(", ")}`);
  }

  if (issues.length === 0) {
    console.log("✅ No drift detected. Netlify production matches Infisical staging manifest.");
    return;
  }

  const message = `[Drift Detected] ${issues.join("; ")}`;

  if (strictness === "fail") {
    console.error(`❌ FATAL: ${message}`);
    process.exit(1);
  }

  console.warn(`⚠️ WARNING: ${message}`);
}

async function runDriftCheck(): Promise<void> {
  const strictness = process.env.STRICTNESS || "warn";
  const infisicalToken = process.env.INFISICAL_TOKEN;
  const netlifyAuthToken = process.env.NETLIFY_AUTH_TOKEN;
  const netlifySiteId = process.env.NETLIFY_SITE_ID;

  console.log(`[Guardrails] Starting drift check with strictness: ${strictness}`);

  if (!infisicalToken) {
    throw new Error("INFISICAL_TOKEN is not set");
  }
  if (!netlifyAuthToken) {
    throw new Error("NETLIFY_AUTH_TOKEN is not set");
  }
  if (!netlifySiteId) {
    throw new Error("NETLIFY_SITE_ID is not set");
  }

  const [infisicalKeys, netlifyKeys] = await Promise.all([
    fetchInfisicalKeys(infisicalToken),
    fetchNetlifyKeys(netlifyAuthToken, netlifySiteId),
  ]);

  const manifestKeys = [...new Set([...P0_KEYS, ...P1_KEYS])];
  const expectedOnNetlify = new Set([...infisicalKeys, ...manifestKeys]);

  const missingOnNetlify = [...expectedOnNetlify].filter(
    (key) => !isKeyPresent(key, netlifyKeys)
  );
  const missingInInfisical = manifestKeys.filter(
    (key) => !isKeyPresent(key, infisicalKeys)
  );

  reportDrift(strictness, missingOnNetlify, missingInInfisical);
}

runDriftCheck().catch((error) => {
  console.error(error);
  process.exit(1);
});
