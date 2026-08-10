# Gate 4 — Migration Verification Checklist

**Status:** PREP ONLY — **do not apply** until SEC-05 authenticated sync is green.  
**Depends on:** Gate 2 (SEC-05) green auth + staging/prod vault sync.  
**Related PRs:** #308 / #309 — **hold** (do not merge/run apply).  
**SQL editor:** keep vault smoke-test queries **unexecuted** while Gate 4 is parked (no production mutation).  
**Pending DELETE:** https://supabase.com/dashboard/project/dykyabqoilzvuncikzkd/sql/fac8cdde-2b5e-4c77-a8c6-833c7ab862b3 — **do not execute** for credential remediation (keys belong in GitHub Actions secrets).  
**Credentials:** see `docs/sec05/CREDENTIAL_POLICY.md` — never use anon as a production service-role placeholder.

---

## Entry criteria (must all be true)

- [ ] SEC-05 workflow run reaches **Authenticate with Infisical (OIDC)** and succeeds
- [ ] SEC-05 **Sync staging secrets** succeeds (`SUPABASE_SERVICE_ROLE_KEY_STAGING`, project `snsxtpdwiclwnfcdpgqv`)
- [ ] SEC-05 **Sync production secrets** succeeds (`SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` real service-role — **not** anon, **not** staging reuse; project `dykyabqoilzvuncikzkd`)
- [ ] No unresolved identity vs path ambiguity on the latest SEC-05 run
- [ ] PR #308 / #309 still unmerged; apply deferred

If any box is unchecked → **stop**. Do not open the SQL apply path. Gate 2 remains blocked.

---

## Dry-run plan (SQL Editor — read-only / idempotency check)

When (and only when) entry criteria pass, verify in Supabase SQL Editor **without** applying destructive changes:

### Staging (`snsxtpdwiclwnfcdpgqv`) then Production (`dykyabqoilzvuncikzkd`)

1. **Extension presence**
   ```sql
   SELECT extname, extversion
   FROM pg_extension
   WHERE extname IN ('supabase_vault', 'pgsodium');
   ```
2. **RPC signature / grants** (path-layer proof for SEC-05 writes)
   ```sql
   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
          r.rolname AS grantee, privilege_type
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   LEFT JOIN information_schema.routine_privileges rp
     ON rp.routine_schema = n.nspname AND rp.routine_name = p.proname
   LEFT JOIN pg_roles r ON r.rolname = rp.grantee
   WHERE n.nspname = 'public' AND p.proname = 'vault_write_secret';
   ```
3. **Secret inventory (names only — no values)**
   ```sql
   SELECT name, updated_at
   FROM vault.secrets
   ORDER BY name;
   ```
4. **Idempotency dry-run** of the Gate 4 migration text:
   - Paste migration into editor
   - Confirm statements are re-runnable (`IF EXISTS` / `ON CONFLICT` / conditional blocks)
   - **Do not execute** until the Gate 4 apply window is explicitly opened

---

## Apply gate (later)

Only after dry-run sign-off:

- [ ] Snapshot / backup note recorded
- [ ] Staging apply + smoke
- [ ] Production apply + smoke
- [ ] Then consider merging PR #308 / #309

---

## Explicit non-goals right now

- Do not merge PR #308 / #309
- Do not run Gate 4 apply SQL
- Do not execute the pending production Vault smoke-test `DELETE` while remediating credentials
- Do not treat SEC-05 `npm ci` failure as an Infisical path ACL issue
- Do not place anon keys (or any secret material) into Actions secrets “just to unblock” production sync
