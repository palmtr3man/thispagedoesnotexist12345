const INFISICAL_PROJECT_ID = "6c7646e9-04dd-484a-a5d1-612b9582da15";
const STAGING_PROJECT_ID = "snsxtpdwiclwnfcdpgqv";
const PRODUCTION_PROJECT_ID = "dykyabqoilzvuncikzkd";
const ALIASES: Record<string, string> = {
  TUJ_SYS_ALIGN_CRON: "ALIGNMENT_CRON_SECRET",
  TUJ_SYS_ALIGN_WEBHOOK: "ALIGNMENT_WEBHOOK_SECRET",
};

const ALLOWLIST = [
  "BASE44_API_KEY",
  "BASE44_AUTH_JSON",
  "BEEHIIV_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NOTION_API_KEY",
  "SENDGRID_API_KEY",
  "CLICKUP_API_TOKEN",
  "PASSENGER_AUTH_TOKEN",
  "SEC06_INTERNAL_TOKEN",
  "SEC06_SCHEDULER_SECRET",
  "TUJ_SYS_ALIGN_CRON",
  "TUJ_SYS_ALIGN_WEBHOOK",
  "BMAC_WEBHOOK_SECRET",
  "GREEN_WREATH_CRON_SECRET",
  "SEAT_API_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_EMAIL",
  "resume_fit_check_status",
  "INVITE_TEMPLATE_ID",
  "MIGRATE_SEAT_IDS_MAP",
  "TASK_FAILURE_EMAIL",
  "NOTION_PIPELINE_DATABASE_ID",
  "BMAC_ALPHA_PRODUCT_ID",
  "BMAC_BETA_PRODUCT_ID",
  "SENDGRID_TEMPLATE_ALPHA_FLIGHT_ANNOUNCEMENT",
  "SENDGRID_TEMPLATE_EXEC_PREBOARD",
  "SENDGRID_TEMPLATE_INSTRUCTIONS_FREE",
  "SENDGRID_TEMPLATE_SOLO_FLIGHT_ANNOUNCEMENT",
  "SENDGRID_TEMPLATE_BOARDING_CONFIRMATION",
  "GPG_PRIVATE_KEY",
] as const;

function getSecrets(): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of ALLOWLIST) {
    const value = process.env[key] || (ALIASES[key] ? process.env[ALIASES[key]] : undefined);
    if (value !== undefined && value !== "") result[key] = value;
  }

  if (!result.MIGRATE_SEAT_IDS_MAP) result.MIGRATE_SEAT_IDS_MAP = "{}";
  return result;
}

function getConfig() {
  const projectId = process.env.SUPABASE_PROJECT_ID;
  const serviceRoleKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.SUPABASE_URL || (projectId ? `https://${projectId}.supabase.co` : undefined);

  if (!projectId) throw new Error("SUPABASE_PROJECT_ID is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY is required");
  if (!url) throw new Error("SUPABASE_URL could not be determined");

  return { projectId, serviceRoleKey, url: url.replace(/\/$/, "") };
}

function getTargetEnvironment(projectId: string): "staging" | "production" {
  if (projectId === STAGING_PROJECT_ID) return "staging";
  if (projectId === PRODUCTION_PROJECT_ID) return "production";
  throw new Error(`Unsupported SUPABASE_PROJECT_ID: ${projectId}`);
}

export async function runSync(): Promise<string> {
  const config = getConfig();
  const environment = getTargetEnvironment(config.projectId);
  const secrets = getSecrets();
  const entries = Object.entries(secrets);

  if (entries.length === 0) {
    throw new Error("No allowlisted secrets found; refusing silent no-op");
  }

  let count = 0;
  for (const [key, value] of entries) {
    const description = `Synced from Infisical project ${INFISICAL_PROJECT_ID} on ${new Date().toISOString()}`;
    const payload = {
      p_name: key,
      p_description: description,
      p_value: value,
    };

    let response: Response;
    try {
      response = await fetch(`${config.url}/rest/v1/rpc/vault_write_secret`, {
        method: "POST",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new Error(`vault_write_secret request failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`vault_write_secret failed for ${key} in ${environment}: HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    }

    count++;
  }

  return `Sync complete: ${count} secrets upserted from Infisical project ${INFISICAL_PROJECT_ID} into ${environment}.`;
}

runSync()
  .then((message) => {
    console.log(message);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : `Vault sync failed: ${String(error)}`;
    console.error(message);
    throw error instanceof Error ? error : new Error(message);
  });
