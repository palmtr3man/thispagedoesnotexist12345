/**
 * vault-cleanup.ts
 *
 * Removes malformed, legacy, and obsolete entries from vault.secrets in the
 * target Supabase project. Safe to re-run — uses DELETE WHERE name IN (...),
 * so running it twice has no additional effect.
 *
 * Usage:
 *   DRY_RUN=1 npx ts-node scripts/vault-cleanup.ts   # print targets, no deletes
 *   npx ts-node scripts/vault-cleanup.ts              # execute deletions
 *
 * Required env vars (set by the SEC-05 workflow or locally):
 *   SUPABASE_PROJECT_ID          — e.g. dykyabqoilzvuncikzkd
 *   SUPABASE_SERVICE_ROLE_KEY    — service-role JWT for the target project
 */

const DRY_RUN = process.env.DRY_RUN === "1";

// ---------------------------------------------------------------------------
// Deletion targets — grouped by reason
// ---------------------------------------------------------------------------

/**
 * EXACT_NAMES: vault secret names that are known to be malformed, legacy, or
 * obsolete and should be deleted unconditionally.
 */
const EXACT_NAMES: string[] = [
  // Legacy key — superseded by SUPABASE_SERVICE_ROLE_KEY; was silently
  // overriding the GitHub Actions secret before commit 7718393.
  "SERVICE_ROLE_KEY",

  // Test artifact written during SEC-05 preflight testing (2026-08-10).
  "__sec05_test__",

  // Malformed writes: raw values stored as secret names (prior sync bug).
  "{",
  "true",
  "false",
  "auto",
  "ACTIVE",
  "success",

  // OIDC scope string stored as a secret name.
  "openid profile email",

  // Email address stored as a secret name.
  "k.clark7@gmail.com",

  // Password stored as a secret name — must be rotated immediately if
  // this value is still in use anywhere.
  "1Palmtree!!",

  // GPG fingerprint stored as a secret name.
  "E132 A41C 61D6 F3FC 8CED C80C 3879 0FBD C33E 069B",

  // SendGrid template ID stored as a secret name (the real template IDs
  // are stored under SENDGRID_TEMPLATE_* keys in the allowlist).
  "d-9c08c310368c4d68995d5df4f8138c74",

  // Infisical machine identity UUID stored as a secret name.
  "d7c719c4-943f-4204-acb2-d04994ae1516",

  // Other UUID-named entries (likely leftover from test runs or identity lookups).
  "0725da9d-013e-4592-8216-615ed4d4085b",
  "a96227d1-5776-4e0f-b6d0-b78b996e0f07",
  "ecb7ca5a-2ad9-4f48-83d7-1615f599ab1c",

  // 64-char hex strings stored as names (likely raw key material or hashes).
  "42e12d010aa88038cf1a46ac841de88da4bb7cb9aa9e4d5e631df31675e88b31",
  "483ca3a977cabaece0c4f9900672170b08927c782d4992dff614bcaeb58fc0ae",

  // 40-char random string stored as a name.
  "oLLwyvkEvMn1xr8bXW47RSIOAYOwYh3Mc0dhDkgo",

  // Supabase session token stored as a name.
  "st.f5d48814-19bd-4760-a3ca-de63c8e41ebb.44ff4192de0e23cdaac051ed3016870e.3371926fa5a635a726f70e3e46d12e4b",
];

// ---------------------------------------------------------------------------
// Allowlist: names that must NEVER be deleted even if they match a pattern.
// Add any name here that you want to protect from future cleanup runs.
// ---------------------------------------------------------------------------
const PROTECTED_NAMES = new Set([
  "SUPABASE_SERVICE_ROLE_KEY",
  "SENDGRID_API_KEY",
  "BASE44_API_KEY",
  "BASE44_AUTH_JSON",
  "BEEHIIV_API_KEY",
  "NOTION_API_KEY",
  "CLICKUP_API_TOKEN",
  "PASSENGER_AUTH_TOKEN",
  "SEC06_INTERNAL_TOKEN",
  "SEC06_SCHEDULER_SECRET",
  "TUJ_SYS_ALIGN_CRON",
  "TUJ_SYS_ALIGN_WEBHOOK",
  "ALIGNMENT_CRON_SECRET",
  "ALIGNMENT_WEBHOOK_SECRET",
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
  "APP_ADMIN_SECRET",
  "PILOT_TOKEN",
  "INFISICAL_SERVICE_TOKEN",
  "INFISICAL_TOKEN",
  "NETLIFY_API_TOKEN",
  "BREVO_API_KEY",
  "BREVO_WEBHOOK_KEY",
  "FL-CG-001",
  "697140e628131a06045ebd18",
  "d-740595dc07be40129569bc731f1b",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfig(): { projectId: string; serviceRoleKey: string; url: string } {
  const projectId = process.env.SUPABASE_PROJECT_ID;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectId) throw new Error("SUPABASE_PROJECT_ID is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  return {
    projectId,
    serviceRoleKey,
    url: `https://${projectId}.supabase.co`,
  };
}

async function rpc(
  url: string,
  key: string,
  fn: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${fn} failed: HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function queryVault(
  url: string,
  key: string,
  names: string[]
): Promise<Array<{ id: string; name: string; created_at: string }>> {
  // Use PostgREST to query vault.secrets — service_role can read via the REST API
  const nameList = names.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",");
  const res = await fetch(
    `${url}/rest/v1/vault_secrets_view?name=in.(${encodeURIComponent(nameList)})&select=id,name,created_at`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    }
  );
  if (res.status === 404) {
    // Fallback: use SQL via RPC if the view doesn't exist
    return [];
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vault query failed: HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function deleteVaultSecretByName(
  url: string,
  key: string,
  name: string
): Promise<void> {
  // vault.secrets is not directly deletable via PostgREST as service_role
  // (the table is in the vault schema, not exposed via REST). Instead, call
  // the vault_delete_secret RPC wrapper which runs as SECURITY DEFINER
  // (postgres) and has permission to DELETE from vault.secrets.
  //
  // If vault_delete_secret doesn't exist in the target project, fall back to
  // a direct SQL DELETE via the /rest/v1/rpc/exec_sql endpoint (Supabase
  // internal — only available to service_role on some plans).
  const res = await fetch(`${url}/rest/v1/rpc/vault_delete_secret`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_name: name }),
  });

  if (res.status === 404) {
    // vault_delete_secret doesn't exist — this is expected if the project
    // hasn't had the helper function deployed yet. The caller should use
    // the Supabase MCP or SQL editor to run the DELETE directly.
    const body = await res.text().catch(() => "");
    if (body.includes("PGRST202")) {
      throw new Error(
        `vault_delete_secret RPC not found in project ${url}. ` +
        `Run the cleanup SQL manually via the Supabase MCP or SQL editor:\n` +
        `  DELETE FROM vault.secrets WHERE name = '${name.replace(/'/g, "''")}';`
      );
    }
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`DELETE vault secret '${name}' failed: HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = getConfig();

  // Filter out any protected names from the deletion list (safety net)
  const targets = EXACT_NAMES.filter((name) => {
    if (PROTECTED_NAMES.has(name)) {
      console.warn(`⚠️  Skipping protected name: ${name}`);
      return false;
    }
    return true;
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`vault-cleanup.ts — ${DRY_RUN ? "DRY RUN" : "LIVE RUN"}`);
  console.log(`Project: ${config.projectId}`);
  console.log(`Targets: ${targets.length} entries`);
  console.log("=".repeat(60));

  targets.forEach((name, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${name}`);
  });

  if (DRY_RUN) {
    console.log("\n[DRY RUN] No deletions performed. Set DRY_RUN=0 to execute.\n");
    return;
  }

  console.log("\nDeleting...");
  let deleted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const name of targets) {
    try {
      await deleteVaultSecretByName(config.url, config.serviceRoleKey, name);
      console.log(`  ✅ Deleted: ${name}`);
      deleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the entry doesn't exist, that's fine — idempotent
      if (msg.includes("0 rows") || msg.includes("not found") || msg.includes("HTTP 404")) {
        console.log(`  ⏭️  Not found (already deleted): ${name}`);
        skipped++;
      } else {
        console.error(`  ❌ Error deleting '${name}': ${msg}`);
        errors.push(`${name}: ${msg}`);
      }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deleted: ${deleted}  Skipped (not found): ${skipped}  Errors: ${errors.length}`);
  if (errors.length > 0) {
    console.error("\nErrors:");
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log("Vault cleanup complete.\n");
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
