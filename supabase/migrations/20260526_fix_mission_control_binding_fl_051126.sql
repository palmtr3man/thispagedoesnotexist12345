-- File: supabase/migrations/20260526_fix_mission_control_binding_fl_051126.sql
-- Purpose: Correct the Mission Control binding RPC to target the canonical
--          Gemini Alpha flight code FL_051126 (with underscore).
--
-- Background:
--   The original 20260514 RPC targeted FL051126 and wrote flight_tag = FL051126.
--   Current operational doctrine and flight specs require FL_051126. This patch
--   replaces the RPC only; it does not perform live passenger binding. Use the
--   operational SQL in docs/runbooks/fl_051126_alpha_binding_repair.sql after
--   this migration is applied with a service-role/database connection.

CREATE OR REPLACE FUNCTION public.bind_subject_at_mission_control(
  p_passenger_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_flight_id UUID;
  v_flight_count INTEGER;
BEGIN
  SELECT count(*), min(id)
    INTO v_flight_count, v_flight_id
  FROM public.flights
  WHERE flight_code = 'FL_051126';

  IF v_flight_count <> 1 THEN
    RAISE EXCEPTION 'Cannot bind passenger %. Expected exactly one FL_051126 flight row; found %.', p_passenger_id, v_flight_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  UPDATE public.passengers
  SET
    flight_id             = v_flight_id,
    flight_tag            = 'FL_051126',
    flight_binding_status = 'bound'
  WHERE id = p_passenger_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot bind passenger %. Passenger row does not exist in public.passengers.', p_passenger_id
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$func$;

REVOKE ALL ON FUNCTION public.bind_subject_at_mission_control(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_subject_at_mission_control(UUID)
  TO service_role;

COMMENT ON FUNCTION public.bind_subject_at_mission_control(UUID) IS
  'Binds a passenger to canonical flight FL_051126 at Mission Control. Corrected from FL051126 on 2026-05-26.';
