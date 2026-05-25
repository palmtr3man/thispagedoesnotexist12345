-- File: supabase/migrations/20260515_passengers_boarding_payload_fields.sql
-- Adds all fields collected or generated at boarding confirmation time.
-- Depends on: 20260514_final_mission_control_flight_binding.sql
-- No data mutations. Rollback at bottom.

CREATE TABLE IF NOT EXISTS public.cabin_tiers (
  tier TEXT PRIMARY KEY
);

INSERT INTO public.cabin_tiers (tier) VALUES
  ('alpha'), ('beta'), ('solo'), ('executive'), ('vip'),
  ('corporate_games'), ('millennium'), ('free'), ('plus'),
  ('pro'), ('holiday'), ('Economy'), ('Business'), ('First'),
  ('sponsored'), ('first_class'), ('executive_pre'), ('paid')
ON CONFLICT (tier) DO NOTHING;

ALTER TABLE public.cabin_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cabin_tiers_authenticated_select" ON public.cabin_tiers;
CREATE POLICY "cabin_tiers_authenticated_select"
  ON public.cabin_tiers FOR SELECT
  TO "authenticated" USING (true);

GRANT SELECT ON public.cabin_tiers TO "authenticated";

ALTER TABLE public.passengers
  ADD COLUMN IF NOT EXISTS first_name             TEXT,
  ADD COLUMN IF NOT EXISTS last_name              TEXT,
  ADD COLUMN IF NOT EXISTS cabin_tier             TEXT
    REFERENCES public.cabin_tiers (tier)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS seat_id                TEXT,
  ADD COLUMN IF NOT EXISTS passport_url           TEXT,
  ADD COLUMN IF NOT EXISTS passenger_number       TEXT,
  ADD COLUMN IF NOT EXISTS qr_code_url            TEXT,
  ADD COLUMN IF NOT EXISTS flight_display_name    TEXT,
  ADD COLUMN IF NOT EXISTS signup_date            DATE,
  ADD COLUMN IF NOT EXISTS boarding_pass_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS boarding_email_status  TEXT
    CHECK (boarding_email_status IN ('pending','sent','failed','skipped')),
  ADD COLUMN IF NOT EXISTS entry_status           TEXT
    CHECK (entry_status IN ('pending','active','paused','removed')),
  ADD COLUMN IF NOT EXISTS intake_status          TEXT
    CHECK (intake_status IN ('pending','complete','rejected')),
  ADD COLUMN IF NOT EXISTS ops_status             TEXT
    CHECK (ops_status IN ('active','paused','graduated','removed')),
  ADD COLUMN IF NOT EXISTS lane_assignment        TEXT,
  ADD COLUMN IF NOT EXISTS amount_paid            NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS flight_binding_status  TEXT DEFAULT 'unbound',
  ADD COLUMN IF NOT EXISTS flight_tag             TEXT;

ALTER TABLE public.passengers
  DROP CONSTRAINT IF EXISTS passengers_passenger_number_unique;
ALTER TABLE public.passengers
  ADD CONSTRAINT passengers_passenger_number_unique
    UNIQUE (passenger_number);

DO $func$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.passengers'::regclass
      AND conname = 'passengers_flight_binding_status_check'
  ) THEN
    ALTER TABLE public.passengers
      ADD CONSTRAINT passengers_flight_binding_status_check
        CHECK (flight_binding_status IN ('unbound','bound'));
  END IF;
END;
$func$;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP TABLE IF EXISTS public.cabin_tiers;
-- ALTER TABLE public.passengers
--   DROP COLUMN IF EXISTS first_name,
--   DROP COLUMN IF EXISTS last_name,
--   DROP COLUMN IF EXISTS cabin_tier,
--   DROP COLUMN IF EXISTS seat_id,
--   DROP COLUMN IF EXISTS passport_url,
--   DROP COLUMN IF EXISTS passenger_number,
--   DROP COLUMN IF EXISTS qr_code_url,
--   DROP COLUMN IF EXISTS flight_display_name,
--   DROP COLUMN IF EXISTS signup_date,
--   DROP COLUMN IF EXISTS boarding_pass_sent_at,
--   DROP COLUMN IF EXISTS boarding_email_status,
--   DROP COLUMN IF EXISTS entry_status,
--   DROP COLUMN IF EXISTS intake_status,
--   DROP COLUMN IF EXISTS ops_status,
--   DROP COLUMN IF EXISTS lane_assignment,
--   DROP COLUMN IF EXISTS amount_paid,
--   DROP COLUMN IF EXISTS flight_binding_status,
--   DROP COLUMN IF EXISTS flight_tag;
-- ALTER TABLE public.passengers
--   DROP CONSTRAINT IF EXISTS passengers_passenger_number_unique,
--   DROP CONSTRAINT IF EXISTS passengers_flight_binding_status_check;
