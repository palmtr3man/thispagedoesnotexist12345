/** Verify required TUJ secrets directly against the OIDC-provided Infisical credential. */
const INFISICAL_WORKSPACE = process.env.INFISICAL_PROJECT_ID ?? "6c7646e9-04dd-484a-a5d1-612b9582da15";
const INFISICAL_DOMAIN = process.env.INFISICAL_DOMAIN ?? "https://us.infisical.com";
const REQUIRED_KEYS = ["TUJ_SYS_ALIGN_CRON", "TUJ_SYS_ALIGN_WEBHOOK"];
const OPTIONAL_KEYS = ["ALIGNMENT_CRON_SECRET", "ALIGNMENT_WEBHOOK_SECRET"];

function token(): string {
  const value = process.env.INFISICAL_TOKEN ?? process.env.INFISICAL_SERVICE_TOKEN;
  if (!value?.trim()) throw new Error("No Infisical credential was provided by the OIDC authentication step.");
  return value.trim();
}

async function main(): Promise<void> {
  const response = await fetch(`${INFISICAL_DOMAIN}/api/v3/secrets/raw?workspaceId=${encodeURIComponent(INFISICAL_WORKSPACE)}&environment=prod&secretPath=/`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!response.ok) throw new Error(`Infisical API error ${response.status}: ${await response.text()}`);
  const payload: unknown = await response.json();
  const secrets = typeof payload === "object" && payload !== null && "secrets" in payload && Array.isArray(payload.secrets) ? payload.secrets : [];
  const keys = new Set(secrets.map((x: unknown) => typeof x === "object" && x !== null && "secretKey" in x && typeof x.secretKey === "string" ? x.secretKey : undefined).filter((x): x is string => typeof x === "string"));
  const missingRequired = REQUIRED_KEYS.filter((key) => !keys.has(key));
  for (const key of REQUIRED_KEYS) console.log(`${keys.has(key) ? "✅" : "❌"} ${key} ${keys.has(key) ? "present" : "MISSING"}`);
  for (const key of OPTIONAL_KEYS) console.log(`${keys.has(key) ? "✅" : "ℹ️"} ${key} ${keys.has(key) ? "present (compatibility)" : "not present (optional)"}`);
  if (missingRequired.length) throw new Error(`Required Infisical keys are missing: ${missingRequired.join(", ")}`);
  console.log("All required TUJ Infisical keys are present.");
}

console.log("Starting Infisical validation check...");
main()
  .then(() => {
    console.log("Validation script completed successfully.");
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("Validation script failed:");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
