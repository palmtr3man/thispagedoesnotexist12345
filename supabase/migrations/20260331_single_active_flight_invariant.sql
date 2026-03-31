-- Migration: single_active_flight_invariant
-- Decision: QA #5 — Single active flight invariant not enforced
-- Applied: 2026-03-31
-- Owner: Kevin / Manus
--
-- Enforces that at most one non-QA flight can be active at a time.
-- QA flights (flight_mode = 'qa') are excluded from this constraint
-- so they can coexist with a production active flight during testing.
--
-- Layer 1 of 3 — DB constraint (see also: Netlify 409 guard + UI fallback)

-- Drop if re-running (idempotent)
DROP INDEX IF EXISTS one_active_non_qa_flight;

-- Partial unique index: only one row may have active = true
-- where flight_mode is not 'qa'.
-- If a second non-QA flight is set active, Postgres raises a unique
-- violation before the row is written — no application-level race condition.
CREATE UNIQUE INDEX one_active_non_qa_flight
  ON flights (active)
  WHERE active = true
    AND (flight_mode IS NULL OR flight_mode != 'qa');

-- Verify (run manually after applying):
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'flights'
--   AND indexname = 'one_active_non_qa_flight';
