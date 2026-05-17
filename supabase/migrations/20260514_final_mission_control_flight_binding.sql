-- File: supabase/migrations/20260514_final_mission_control_flight_binding.sql
-- Creates the flight binding RPC, audit view, and binding protection trigger.
-- Depends on: existing public.flights and public.passengers tables.
-- No live bind calls in this migration — see finalmissioncontrolbindinghandoff.md
-- for the five-seat manual bind sequence.
-- Rollback at bottom.

-- ---------------------------------------------------------------------------
-- 0. Flight binding columns
--    These must exist before functions, triggers, and the audit view reference
--    them. The guards make this safe for the live schema and for replay.
-- ---------------------------------------------------------------------------
ALTER TABLE public.passengers
  ADD COLUMN IF NOT EXISTS flight_id UUID
    REFERENCES public.flights (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS flight_tag TEXT,
  ADD COLUMN IF NOT EXISTS flight_binding_status TEXT DEFAULT 'unbound';

-- ---------------------------------------------------------------------------
-- 1. bind_subject_at_mission_control()
--    Uses live PK: passengers.id (uuid).
--    Targets FL051126 — update flight_code value for future flights.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bind_subject_at_mission_control(
  p_passenger_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  UPDATE public.passengers
  SET
    flight_id             = (SELECT id FROM public.flights
                             WHERE flight_code = 'FL051126'),
    flight_tag            = 'FL051126',
    flight_binding_status = 'bound'
  WHERE id = p_passenger_id;
END;
$func$;

REVOKE ALL ON FUNCTION public.bind_subject_at_mission_control(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_subject_at_mission_control(UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 2. passengers_protect_flight_binding_columns trigger
--    Blocks non-admin roles from setting binding fields directly.
--    Admins: service_role (jwt) or postgres/supabase_admin (current_user).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.passengers_protect_flight_binding_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $func$
DECLARE
  v_escalated BOOLEAN;
BEGIN
  SELECT (auth.jwt() ->> 'role') = 'service_role'
      OR CURRENT_USER IN ('postgres', 'supabase_admin')
    INTO v_escalated;

  IF NOT v_escalated THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.flight_id IS NOT NULL
        OR NEW.flight_tag IS NOT NULL
        OR NEW.flight_binding_status IS DISTINCT FROM 'unbound' THEN
        RAISE EXCEPTION 'flight binding columns are restricted to admins';
      END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
      IF NEW.flight_id IS DISTINCT FROM OLD.flight_id
        OR NEW.flight_tag IS DISTINCT FROM OLD.flight_tag
        OR NEW.flight_binding_status IS DISTINCT FROM OLD.flight_binding_status THEN
        RAISE EXCEPTION 'flight binding columns are restricted to admins';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS passengers_protect_flight_binding_trg
  ON public.passengers;
DROP TRIGGER IF EXISTS trg_protect_flight_binding
  ON public.passengers;
CREATE TRIGGER passengers_protect_flight_binding_trg
  BEFORE INSERT OR UPDATE ON public.passengers
  FOR EACH ROW
  EXECUTE FUNCTION public.passengers_protect_flight_binding_columns();

-- ---------------------------------------------------------------------------
-- 3. Audit view
--    Uses confirmed live column names: flight_name, f.status AS flight_status.
--    security_invoker = true requires PostgreSQL 15+.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_passenger_flight_binding_audit;
CREATE VIEW public.v_passenger_flight_binding_audit AS
SELECT
  p.id                    AS passenger_id,
  p.flight_id,
  p.flight_tag,
  p.flight_binding_status,
  f.flight_code,
  f.flight_name,
  f.status                AS flight_status
FROM public.passengers p
LEFT JOIN public.flights f ON f.id = p.flight_id;

GRANT SELECT ON public.v_passenger_flight_binding_audit TO "authenticated";

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP TRIGGER IF EXISTS passengers_protect_flight_binding_trg ON public.passengers;
-- DROP TRIGGER IF EXISTS trg_protect_flight_binding ON public.passengers;
-- DROP FUNCTION IF EXISTS public.passengers_protect_flight_binding_columns();
-- DROP FUNCTION IF EXISTS public.bind_subject_at_mission_control(UUID);
-- DROP VIEW IF EXISTS public.v_passenger_flight_binding_audit;
-- ALTER TABLE public.passengers
--   DROP COLUMN IF EXISTS flight_id,
--   DROP COLUMN IF EXISTS flight_tag,
--   DROP COLUMN IF EXISTS flight_binding_status;
