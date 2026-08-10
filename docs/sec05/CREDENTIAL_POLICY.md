# SEC-05 — Credential policy (staging vs production)

**Status:** Binding for Gate 2. Gate 2 stays **blocked** until lockfile install passes **and** SEC-05 completes the intended staging **and** production credential-sync flow without exposing secret material.

## Non-negotiables

1. **Never** use the Supabase **anon** (or publishable) key as a placeholder for `SUPABASE_SERVICE_ROLE_KEY_*`.
   - An anon key cannot authorize a privileged Vault write.
   - Using it creates a knowingly failing production path and muddies SEC-05 evidence (deliberate 401 noise).
2. **Never** put the production service-role/secret key in chat, terminal history, a PR, commit, patch, or CI debug output.
3. Staging and production credentials stay **separate** and **explicitly mapped**. Do **not** reuse `SUPABASE_SERVICE_ROLE_KEY_STAGING` for production.

## Explicit secret mapping (GitHub Actions)

| GitHub Actions secret | Supabase project | Infisical env | Role required |
|-----------------------|------------------|---------------|---------------|
| `SUPABASE_SERVICE_ROLE_KEY_STAGING` | `snsxtpdwiclwnfcdpgqv` | `staging` | `service_role` |
| `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | `dykyabqoilzvuncikzkd` | `prod` | `service_role` |
| `INFISICAL_MACHINE_IDENTITY_ID` | (OIDC identity) | — | machine identity |

Workflow: `palmtr3man/thispagedoesnotexist12345` → `.github/workflows/sec05-vault-sync.yml`

## Correct provisioning (human-only)

1. An authorized human opens the target project’s Supabase **API settings**.
2. Copies the current **service-role / secret** key **directly** into the matching GitHub Actions secret above.
3. Confirms both environment secrets are **nonempty** and correctly scoped.
4. Dispatches **one** complete SEC-05 run.
5. Validates success via workflow status and **non-sensitive** metadata only (counts, HTTP ok/fail class, step names). Never log key material.

## If production service-role access is unavailable

**Preferred:** Populate the real production service-role secret, then run SEC-05 once.

**Not acceptable:** Anon key (or any non-`service_role` JWT) as a placeholder.

**Required fallback:** Leave production sync **explicitly blocked** with a clear guard (no Vault call, no deliberate 401). Do not pretend production is configured.

Apply the guard patch set:

- `patches/sec05/credential-guard.patch`
- Drop-ins under `patches/sec05/files/` (`sec05-vault-sync.yml`, `sync-infisical-vault.ts`)

Behavior after apply:

- Empty/missing `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` → production sync step is **skipped**; a following **Gate 2 production credential requirement** step **fails closed** with an explicit block message.
- Present key whose JWT `role` is `anon` (or not `service_role`) → sync **refuses before** any Vault write.
- Staging and production continue to use **distinct** secret names / project IDs.

## Production SQL editor

Dashboard project `dykyabqoilzvuncikzkd` may have a pending Vault smoke-test `DELETE` in the SQL editor. **Do not execute** that query as part of credential remediation. Key provisioning belongs in GitHub Actions secrets, not ad hoc production SQL.

Editor (leave unexecuted): https://supabase.com/dashboard/project/dykyabqoilzvuncikzkd/sql/fac8cdde-2b5e-4c77-a8c6-833c7ab862b3

## Gate 2 clear criteria

All must be true:

- [ ] Lockfile install (`npm ci`) succeeds on SEC-05
- [ ] Infisical OIDC auth succeeds
- [ ] Staging vault sync succeeds with `SUPABASE_SERVICE_ROLE_KEY_STAGING`
- [ ] Production vault sync succeeds with real `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` (not anon; not staging reuse)
- [ ] No secret material in logs/PR/chat

Until then: **Gate 2 blocked**.
