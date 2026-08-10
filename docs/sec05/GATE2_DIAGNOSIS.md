# Gate 2 / SEC-05 — Operational Status

**Revised statement:** Gate 2 remains **blocked**. Immediate CI failure is lockfile skew (`npm ci`); production credential sync must not be faked with an anon key. See `docs/sec05/CREDENTIAL_POLICY.md`.

| Item | Status | Meaning |
|------|--------|---------|
| SEC-05 / run `31307922277` | **Blocked at install** | Fix lockfile/package manifest coherence first |
| OIDC identity | **Not tested** | Step 6 was skipped |
| Staging vault sync | **Not tested** | Requires nonempty `SUPABASE_SERVICE_ROLE_KEY_STAGING` |
| Production vault sync | **Explicitly blocked until real secret** | `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` — **never** anon placeholder |
| PR #308 / #309 | **Held** | Correct containment |
| Gate 4 apply | **Parked** | Checklist-only; SQL editor stays unexecuted |
| Gate 4 verification | **Ready for review** | `docs/gate4/VERIFICATION_CHECKLIST.md` — no DB mutation |

**Failed run:** https://github.com/palmtr3man/thispagedoesnotexist12345/actions/runs/31307922277  
**Upstream:** `palmtr3man/thispagedoesnotexist12345` (GitHub; OIDC-bound)

---

## Credential gate (binding)

| Decision | Rule |
|----------|------|
| Preferred | Human copies production **service-role/secret** into `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION`, then one complete SEC-05 run |
| Not acceptable | Anon key as placeholder (knowingly failing Vault write / muddy 401 evidence) |
| If prod access unavailable | Leave production sync **blocked/skipped** via credential guard — do not pretend configured |

Staging vs production stay separate:

- Staging → `SUPABASE_SERVICE_ROLE_KEY_STAGING` → `snsxtpdwiclwnfcdpgqv` → Infisical `staging`
- Production → `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` → `dykyabqoilzvuncikzkd` → Infisical `prod`

Do **not** reuse the staging service-role key for production. Do **not** execute the pending production Vault smoke-test `DELETE` in the SQL editor as part of credential remediation.

---

## Diagnostic answer

> Identity failure or secret-path failure?

**Neither (yet).** Earliest failure is step 4 `npm ci`. Staging/production vault checks are **not executed**, not unauthorized.

Under Node 24 (matches CI `node-version: '24'`), the exact error class is:

```text
package.json and package-lock.json are out of sync
Invalid: lock file's vite@7.3.3 does not satisfy vite@5.4.21
(+ missing resolved entries for package.json deps)
```

`package.json` was already coherent; the lockfile was not.

---

## Patch sets for GitHub upstream

This agent cannot push GitHub. Land patches on `palmtr3man/thispagedoesnotexist12345` in order:

### 1) Lockfile-only (install unblock)

- Patch: `patches/sec05/lockfile-only.patch`
- Drop-in: `patches/sec05/files/package-lock.json`
- Regenerated with **Node 24.19.0 / npm 11.17.0** (CI-aligned)
- `package.json` unchanged

```bash
git checkout main && git pull --ff-only
git apply patches/sec05/lockfile-only.patch
# or: cp patches/sec05/files/package-lock.json ./package-lock.json
rm -rf node_modules && npm ci
```

### 2) Credential guard (no anon placeholder; prod fail-closed)

- Patch: `patches/sec05/credential-guard.patch`
- Drop-ins: `patches/sec05/files/sec05-vault-sync.yml`, `patches/sec05/files/sync-infisical-vault.ts`
- Empty production service-role secret → skip Vault call, then fail Gate 2 step with explicit block
- JWT `role === anon` (or non-`service_role`) → refuse **before** Vault write

```bash
git apply patches/sec05/credential-guard.patch
# or copy the two drop-ins into .github/workflows/ and scripts/
```

Policy detail: `docs/sec05/CREDENTIAL_POLICY.md`.

SEC-05 still references `scripts/tuj_infisical_sync_check.ts`, which is **absent on GitHub main** — expect that as the next bootstrap gap after lockfile lands (out of scope for the credential-guard patch).

---

## Rerun decision tree (after patches + secrets)

1. **Step 4 fails again** → stay in dependency/runner territory; do not inspect OIDC yet  
2. **Step 6 fails** → Infisical OIDC trust / audience / identity bindings  
3. **Staging sync fails** → staging service-role secret, path/policy, RPC grants — not “use anon”  
4. **Production step blocked (empty secret)** → human provisions real `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION`; Gate 2 stays blocked  
5. **Production refuses anon / wrong role** → replace with service-role secret; do not proceed on 401 evidence  
6. **Steps 6–9 pass (staging + production)** → Gate 2 clearable; then re-evaluate PR #308/#309  

Gate 4 SQL editor remains **unexecuted** while parked.
