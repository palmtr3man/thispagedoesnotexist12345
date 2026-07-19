-- Migration: single_active_flight_invariant
-- Decision: QA #5 — Single active flight invariant not enforced
-- Applied: 2026-03-31
-- Revised: 2026-03-31 (schema correction — flights table uses status enum, not active boolean)
-- Owner: Kevin / Manus
--
-- Enforces that at most one flight can be in a "live" state at a time.
-- Live states are 'Boarding' and 'In Flight' — both drive the public .com.
-- The flights table has no `active` boolean column; the active-flight concept
-- is expressed via the `status` text enum:
--   Planning | Boarding | In Flight | Landed | Archived
--
-- Implementation: Postgres trigger function + trigger.
-- A simple partial unique index cannot express "count ≤ 1 across a set of values",
-- so a BEFORE INSERT/UPDATE trigger is used instead.
--
-- Layer 1 of 3 — DB constraint (see also: Netlify 409 guard + UI fallback)

-- Drop existing objects if re-running (idempotent)
DROP TRIGGER IF EXISTS enforce_single_active_flight ON flights;
DROP FUNCTION IF EXISTS check_single_active_flight();

-- Trigger function: raise exception if more than one flight is live
CREATE OR REPLACE FUNCTION check_single_active_flight()
RETURNS TRIGGER AS $$
DECLARE
  live_count integer;
BEGIN
  -- Only enforce when the new/updated row is entering a live state
  IF NEW.status IN ('Boarding', 'In Flight') THEN
    SELECT COUNT(*) INTO live_count
    FROM flights
    WHERE status IN ('Boarding', 'In Flight')
      AND id != NEW.id;  -- exclude the row being updated

    IF live_count > 0 THEN
      RAISE EXCEPTION 'SingleActiveFlightViolation: another flight is already in a live state (Boarding or In Flight). Deactivate it before activating a new one.'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to flights table (fires before INSERT or UPDATE)
CREATE TRIGGER enforce_single_active_flight
  BEFORE INSERT OR UPDATE ON flights
  FOR EACH ROW
  EXECUTE FUNCTION check_single_active_flight();

-- Verify (run manually after applying):
-- SELECT tgname, tgenabled FROM pg_trigger
-- WHERE tgrelid = 'flights'::regclass
--   AND tgname = 'enforce_single_active_flight';
