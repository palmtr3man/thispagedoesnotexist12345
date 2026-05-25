# SEC-03 · RLS Acceptance Tests

## Purpose

SEC-03 defines the acceptance checks that must pass before SEC-02 can be marked complete. The test scaffold lives at `supabase/sec03_rls_acceptance_tests.sql` and is designed to run against a Supabase/Postgres environment after the SEC-02 RLS migrations have been applied.

The scaffold is intentionally rollback-only. It creates temporary helper functions and a temporary results table, attempts the required reads and writes under `authenticated`, `anon`, and admin-shaped JWT claim contexts, prints the result matrix, and raises an exception if any acceptance criterion fails.

## Required Fixtures

The script requires three UUID fixtures supplied through `psql` variables. `user_a_id` and `user_b_id` represent ordinary authenticated users. `admin_id` represents an authenticated admin user whose JWT app/user metadata should satisfy admin policies. Before running the scaffold, seed real rows for both ordinary users in each configured owner-scoped table. The scaffold intentionally refuses to manufacture minimalist fixture rows because production tables may have required columns beyond the owner column, and swallowing those fixture-shape errors can create false-positive RLS results.

| Variable | Meaning |
|---|---|
| `user_a_id` | Authenticated non-admin fixture A. |
| `user_b_id` | Authenticated non-admin fixture B. |
| `admin_id` | Authenticated admin fixture. |

## Default Table Targets

The acceptance tests target the table names listed in SEC-02. If SEC-02 maps any of these entities to different concrete table names, update the `sec03_config` insert defaults in the SQL scaffold before running it.

| Acceptance Area | Default Table |
|---|---|
| User-owned Resume rows | `public."Resume"` |
| User-owned Application rows | `public."Application"` |
| User-owned Subscription rows | `public."Subscription"` |
| Operational email audit rows | `public."EmailLog"` |
| Public loading-dock messages | `public."LoadingDockMessage"` |

## Covered Acceptance Criteria

The scaffold encodes the SEC-03 task requirements as explicit checks. It first proves real fixture rows exist for both ordinary users in owner-scoped tables, then verifies User A cannot read User B rows and User B cannot read User A rows. `WITH CHECK` policy behavior must prevent User A from inserting a row owned by User B, and the scaffold now distinguishes RLS/check denials from fixture-shape failures such as missing required columns. Admin-shaped JWT claims must be able to select operational tables. Non-admin users must not see `EmailLog`. Anonymous users must not be able to write `LoadingDockMessage`. `EmailLog` must expose an insert policy surface for the approved service-role/server-side path.

| Test Group | Expected Result |
|---|---|
| Table existence and RLS | Each configured table exists and has `relrowsecurity = true`. |
| Fixture integrity | Real fixture rows exist for User A and User B before cross-user checks run. |
| Cross-user SELECT denial | User-owned tables hide other users’ rows. |
| Owner spoof prevention | Inserts that set the owner column to another user fail specifically because of RLS or `WITH CHECK`, not unrelated fixture-shape errors. |
| Admin operational access | Admin-shaped JWT context can read operational tables. |
| EmailLog non-admin denial | Non-admin authenticated users see zero `EmailLog` rows. |
| LoadingDock public write denial | `anon` cannot insert `LoadingDockMessage`. |
| EmailLog service path | `EmailLog` has an INSERT policy for the approved server-side/service-role path. |

## Run Command

Run the script after applying SEC-02 policies in a disposable branch database, staging database, or local Supabase instance. Seed real fixture rows for `user_a_id` and `user_b_id` in the configured owner-scoped tables before running. Do not run it against production until the fixture IDs are known safe and the operator intends to validate production policy posture.

```bash
psql "$DATABASE_URL" \
  -v user_a_id='00000000-0000-0000-0000-0000000000a1' \
  -v user_b_id='00000000-0000-0000-0000-0000000000b2' \
  -v admin_id='00000000-0000-0000-0000-0000000000ad' \
  -f supabase/sec03_rls_acceptance_tests.sql
```

## Interpretation

A passing run prints all rows from `sec03_results` with `passed = true` and then rolls back. A failing run prints the same matrix and raises `SEC-03 RLS acceptance tests failed`, including the number of failing checks. Any failure should block SEC-02 closure until the relevant table policy is corrected.

## Known Limits

This scaffold validates the database policy surface and simulated JWT claim behavior. The final `EmailLog` service-role requirement also depends on SEC-06 and SEC-09 function-level hardening, because database RLS alone cannot prove that only an approved server function invoked the service-role path. The scaffold therefore checks the database insert-policy surface now and documents the required pairing with approved server-side token/signature checks.
