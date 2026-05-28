-- File: docs/runbooks/fl_051126_alpha_binding_repair.sql
-- Purpose: One-time operational repair for the June 1 FL_051126 gate.
--
-- Preconditions:
--   1. Apply supabase/migrations/20260526_fix_mission_control_binding_fl_051126.sql.
--   2. Run this SQL only with a service-role/postgres-equivalent connection.
--   3. Confirm public.flights contains exactly one row with flight_code = 'FL_051126'.
--
-- Expected Alpha seats:
--   Seat 1: Kevin Clark      / TUJ-KC2222 / k.clark7@gmail.com
--   Seat 2: Janelle Asumang  / TUJ-JA2222 / janelle.jclark@gmail.com
--   Seat 3: Jo Ann Clark     / TUJ-JC2222 / clark.joann@gmail.com
--   Seat 4: Clarence Clark   / TUJ-CC2222 / clark.clarence@gmail.com
--   Seat 5: Monica Nadute    / TUJ-MN2222 / maclark81@gmail.com

BEGIN;

-- 1) Confirm the canonical flight exists exactly once.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.flights
  WHERE flight_code = 'FL_051126';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one public.flights row for FL_051126; found %.', v_count;
  END IF;
END $$;

-- 2) Bind the five Alpha seats through the Mission Control RPC.
WITH expected_seats(seat_id, email, full_name, expected_seat_number) AS (
  VALUES
    ('TUJ-KC2222', 'k.clark7@gmail.com',        'Kevin Clark',     1),
    ('TUJ-JA2222', 'janelle.jclark@gmail.com',  'Janelle Asumang', 2),
    ('TUJ-JC2222', 'clark.joann@gmail.com',     'Jo Ann Clark',    3),
    ('TUJ-CC2222', 'clark.clarence@gmail.com',  'Clarence Clark',  4),
    ('TUJ-MN2222', 'maclark81@gmail.com',       'Monica Nadute',   5)
), matched_passengers AS (
  SELECT
    e.seat_id AS expected_seat_id,
    e.email AS expected_email,
    e.full_name AS expected_full_name,
    e.expected_seat_number,
    p.id AS passenger_id,
    p.seat_id AS actual_seat_id,
    p.email AS actual_email,
    p.seat_number AS actual_seat_number
  FROM expected_seats e
  LEFT JOIN public.passengers p
    ON p.seat_id = e.seat_id
    OR lower(p.email) = lower(e.email)
), missing_or_ambiguous AS (
  SELECT expected_seat_id, expected_email, count(passenger_id) AS match_count
  FROM matched_passengers
  GROUP BY expected_seat_id, expected_email
  HAVING count(passenger_id) <> 1
), bind_calls AS (
  SELECT public.bind_subject_at_mission_control(passenger_id) AS bound
  FROM matched_passengers
  WHERE passenger_id IS NOT NULL
)
SELECT * FROM bind_calls;

-- 3) Fail if any expected passenger row was missing or matched more than once.
DO $$
DECLARE
  v_problem_count INTEGER;
BEGIN
  WITH expected_seats(seat_id, email) AS (
    VALUES
      ('TUJ-KC2222', 'k.clark7@gmail.com'),
      ('TUJ-JA2222', 'janelle.jclark@gmail.com'),
      ('TUJ-JC2222', 'clark.joann@gmail.com'),
      ('TUJ-CC2222', 'clark.clarence@gmail.com'),
      ('TUJ-MN2222', 'maclark81@gmail.com')
  ), match_counts AS (
    SELECT e.seat_id, e.email, count(p.id) AS match_count
    FROM expected_seats e
    LEFT JOIN public.passengers p
      ON p.seat_id = e.seat_id
      OR lower(p.email) = lower(e.email)
    GROUP BY e.seat_id, e.email
  )
  SELECT count(*) INTO v_problem_count
  FROM match_counts
  WHERE match_count <> 1;

  IF v_problem_count <> 0 THEN
    RAISE EXCEPTION 'Binding aborted: % expected Alpha seat(s) are missing or ambiguous in public.passengers.', v_problem_count;
  END IF;
END $$;

-- 4) Verify all five expected passengers audit as bound to FL_051126.
DO $$
DECLARE
  v_bad_count INTEGER;
BEGIN
  WITH expected_seats(seat_id, email) AS (
    VALUES
      ('TUJ-KC2222', 'k.clark7@gmail.com'),
      ('TUJ-JA2222', 'janelle.jclark@gmail.com'),
      ('TUJ-JC2222', 'clark.joann@gmail.com'),
      ('TUJ-CC2222', 'clark.clarence@gmail.com'),
      ('TUJ-MN2222', 'maclark81@gmail.com')
  ), passenger_ids AS (
    SELECT DISTINCT p.id
    FROM expected_seats e
    JOIN public.passengers p
      ON p.seat_id = e.seat_id
      OR lower(p.email) = lower(e.email)
  ), audit AS (
    SELECT a.*
    FROM public.v_passenger_flight_binding_audit a
    JOIN passenger_ids x ON x.id = a.passenger_id
  )
  SELECT count(*) INTO v_bad_count
  FROM audit
  WHERE flight_code IS DISTINCT FROM 'FL_051126'
     OR flight_tag IS DISTINCT FROM 'FL_051126'
     OR flight_binding_status IS DISTINCT FROM 'bound'
     OR flight_id IS NULL;

  IF v_bad_count <> 0 THEN
    RAISE EXCEPTION 'Binding verification failed: % Alpha passenger(s) are not bound cleanly to FL_051126.', v_bad_count;
  END IF;
END $$;

-- 5) Final human-readable audit output.
WITH expected_seats(seat_id, email, expected_seat_number) AS (
  VALUES
    ('TUJ-KC2222', 'k.clark7@gmail.com',        1),
    ('TUJ-JA2222', 'janelle.jclark@gmail.com',  2),
    ('TUJ-JC2222', 'clark.joann@gmail.com',     3),
    ('TUJ-CC2222', 'clark.clarence@gmail.com',  4),
    ('TUJ-MN2222', 'maclark81@gmail.com',       5)
)
SELECT
  e.expected_seat_number,
  e.seat_id,
  e.email,
  a.passenger_id,
  a.flight_id,
  a.flight_code,
  a.flight_tag,
  a.flight_binding_status,
  a.flight_name,
  a.flight_status
FROM expected_seats e
JOIN public.passengers p
  ON p.seat_id = e.seat_id
  OR lower(p.email) = lower(e.email)
JOIN public.v_passenger_flight_binding_audit a
  ON a.passenger_id = p.id
ORDER BY e.expected_seat_number;

COMMIT;
