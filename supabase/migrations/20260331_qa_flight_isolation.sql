-- Migration: qa_flight_isolation
-- Decision: QA #7 — QA flight isolation not enforced
-- Applied: 2026-03-31
-- Owner: Manus
--
-- Enforces that flights with flight_mode = 'qa' can never be set active = true.
-- This prevents a QA flight from accidentally becoming the public activeFlight
-- and driving .com seat counts, copy, or gate state.
--
-- Works in concert with the one_active_non_qa_flight index from
-- 20260331_single_active_flight_invariant.sql (QA #5), which prevents
-- multiple active non-QA flights. Together these two constraints fully
-- isolate QA flights from production.

-- Drop if re-running (idempotent)
DROP INDEX IF EXISTS no_active_qa_flight;

-- Partial unique index: a QA flight (flight_mode = 'qa') can never have
-- active = true. The index covers only rows where flight_mode = 'qa',
-- and within that set enforces that active is always false.
-- Attempting to set active = true on a QA flight raises a unique violation.
CREATE UNIQUE INDEX no_active_qa_flight
  ON flights (active)
  WHERE flight_mode = 'qa'
    AND active = true;

-- Verify (run manually after applying):
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'flights'
--   AND indexname = 'no_active_qa_flight';
