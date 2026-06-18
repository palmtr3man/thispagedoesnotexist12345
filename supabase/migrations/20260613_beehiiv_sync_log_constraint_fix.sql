-- Fix beehiiv_sync_log_flight_pair_canonical constraint
--
-- The original constraint used '\\s+' (PostgreSQL POSIX regex) which does NOT
-- match whitespace — POSIX requires '[[:space:]]' for whitespace character class.
-- As a result, any flight_id containing spaces (e.g. 'FL CG 001') failed the
-- constraint because regexp_replace did not transform spaces to underscores.
--
-- This migration drops the broken constraint and re-adds it using '[[:space:]]+'
-- which is the correct POSIX character class for whitespace.
--
-- No data migration required: the table was empty when this was discovered.

ALTER TABLE public.beehiiv_sync_log
  DROP CONSTRAINT IF EXISTS beehiiv_sync_log_flight_pair_canonical;

ALTER TABLE public.beehiiv_sync_log
  ADD CONSTRAINT beehiiv_sync_log_flight_pair_canonical
    CHECK (
      flight_key = regexp_replace(upper(trim(flight_id)), '[[:space:]]+', '_', 'g')
    );
