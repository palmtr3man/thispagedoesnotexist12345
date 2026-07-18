# Corrected Audit: tuj-backend Supabase (Jul 18, 2026)

**Project:** `tuj-backend` (production) · `dykyabqoilzvuncikzkd`  
**Date:** Saturday, July 18, 2026  
**Method:** Read-only visual check in Supabase dashboard  
**Changes made:** None

This document replaces the Jul 18 maintenance checklist claims for production schema items 2–4 below. Treat this as the source of truth until a later verified check supersedes it.

---

## Verified findings

### 1. Triggers — naming mismatch, logic present

| | |
|---|---|
| **Checklist claim** | Missing `tr_seat_passenger_alignment` |
| **Actual** | No trigger with that exact name. `trg_validate_seat_alignment` exists on `seats` (`BEFORE INSERT/UPDATE`), calling `validate_seat_passenger…` |
| **Verdict** | Seat/passenger alignment validation is present under a different name |
| **Disposition** | **KEEP** existing trigger. Do **not** create a duplicate `tr_seat_passenger_alignment` unless the spec author documents a behavioral gap vs `trg_validate_seat_alignment` |

### 2. RLS on `optimization_logs` — already protected

| | |
|---|---|
| **Checklist claim** | Missing RLS / RISK |
| **Actual** | RLS **enabled**. Active policies: authenticated `SELECT` (“Allow authenticated users to view logs”); `optimization_logs_insert` (`INSERT`) |
| **Verdict** | Table is not unprotected |
| **Disposition** | **CLOSED — no action** |

### 3. Supabase Vault / extensions — not installed

| | |
|---|---|
| **Checklist claim** | `supabase_vault` active at v0.3.1; Error 42501 on `ALTER EXTENSION supabase_vault UPDATE` |
| **Actual** | `supabase_vault` does **not** exist in this project. `pgsodium` is listed but **not installed/enabled** |
| **Verdict** | Vault is not configured. The 42501 item is a ghost (wrong env, stale, or fabricated) |
| **Disposition** | **CLOSED as ghost.** Do **not** enable Vault or “fix” 42501 under checklist/Monday-block pressure. Separate Pilot KC decision required if this project should ever use Vault |

---

## Repo drift: PAL-69 vs live

Repo file `supabase/migrations/20260616_pal69_production_rls_vault.sql` is labeled as applied to `tuj-backend` and assumes Vault (`vault.create_secret` / `vault.secrets`).

Live production (Jul 18, 2026) has **no** `supabase_vault` extension.

**Implication:** Either the Vault block never landed on prod, or it targeted a different project/environment. Until reconciled with evidence (SQL editor query of `pg_extension` / `vault.secrets`), do not treat PAL-69 Vault apply or TC-01-style vault permission fixes as production blockers.

---

## Ghost checklist kill list

Items from the Jul 18 “outstanding maintenance” checklist that are **killed or reclassified** for `tuj-backend` production:

| Checklist item | Status | Notes |
|---|---|---|
| Missing `tr_seat_passenger_alignment` | **KILLED** | Covered by `trg_validate_seat_alignment` pending behavioral confirmation only |
| Missing RLS / `enforce_rls_policy` on `optimization_logs` | **KILLED** | RLS enabled + two policies live |
| Error 42501 / `ALTER EXTENSION supabase_vault UPDATE` (TC-01) | **KILLED** | Extension not present; nothing to update |
| Claim: vault active at v0.3.1 | **KILLED** | False for this project |
| “DNS Write token already in production Vault; clear 42501 so scripts can fetch it” | **REJECTED** | Premised on non-existent Vault; do not loosen DB permissions for agent DNS automation |

**Still open (out of scope of this read-only schema check):** Cloudflare integration/auth (use only `dash.cloudflare.com` / official APIs — never third-party “re-auth” links), SEC-08 staging secret scrub, BMAC webhook / `BMAC_WEBHOOK_SECRET` staging sync. Those need their own verified evidence, not this audit’s schema claims.

---

## Pilot KC decisions (optional follow-ups)

1. Confirm with trigger/spec author whether `trg_validate_seat_alignment` fully satisfies the intended seat↔passenger invariant.
2. Decide whether `tuj-backend` should ever enable Vault; if yes, plan install deliberately (not as a “42501 fix”).
3. Reconcile PAL-69 migration header vs live `pg_extension` state and annotate or split the Vault block if it never applied.

---

Kevin Clark · Jul 18, 2026
