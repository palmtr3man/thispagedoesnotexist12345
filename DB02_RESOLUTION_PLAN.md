# RESOLUTION PLAN: DB-02 (SUPABASE NAMING CONSTRAINTS)

**Status:** VERIFIED
**Blocker ID:** DB-02
**Target Secrets:** `ALIGNMENT_CRON_SECRET`, `ALIGNMENT_WEBHOOK_SECRET`

---

## 1. THE PROBLEM
The current secret names are causing staging conflicts during Supabase schema migrations. Supabase/Postgres vault naming or schema-prefixing logic is hitting length or character constraints when these secrets are dynamically mapped.

---

## 2. RESOLUTION STEPS

### Step 1: Infisical Renaming (Completed)
Rename the following secrets in the Infisical Dashboard (Project `6c7646e9`, Environment `prod`, Path `/`):
*   `ALIGNMENT_CRON_SECRET` -> `TUJ_SYS_ALIGN_CRON`
*   `ALIGNMENT_WEBHOOK_SECRET` -> `TUJ_SYS_ALIGN_WEBHOOK`

### Step 2: Codebase Update (Completed)
Update all references in `sync-infisical-to-supabase-vault.fixed.ts` and the application codebase to use the new `TUJ_SYS_` prefix.

### Step 3: OIDC Handshake Validation (Completed)
Broaden the OIDC Bound Subject in the Infisical UI to ensure the GitHub Action (sec05-vault-sync.yml) maintains access during the renaming cutover.

---

## 3. VERIFICATION
The prefixed-key Vault migration is complete. `TUJ_SYS_ALIGN_CRON` and `TUJ_SYS_ALIGN_WEBHOOK` were successfully deployed and verified in both staging and production Supabase Vaults. SEC-05 synchronization and metadata verification completed successfully, and the staging naming conflict is resolved.

Legacy keys, including `ALIGNMENT_CRON_SECRET` and `ALIGNMENT_WEBHOOK_SECRET`, are being preserved temporarily for backward compatibility during the transition. No plaintext credential values are stored in this document.

## 4. CUTOVER PRIVILEGE EXCEPTION

The `postgres` role retains raw `SELECT` on `vault.secrets` strictly so the production sync wrapper can resolve a secret by name. All Vault mutations remain delegated to the native SECURITY DEFINER Vault routines; this preserves a tight privilege model while allowing the wrapper to perform its controlled upsert. The corresponding privilege migration is `supabase/migrations/20260809002600_vault_write_secret_privileges.sql`.
