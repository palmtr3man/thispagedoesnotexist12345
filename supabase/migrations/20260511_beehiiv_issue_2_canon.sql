-- Beehiiv Issue 2 Canon Migration (2026-05-11)
--
-- Scope:
--   1. Create the canonical Beehiiv sync audit log.
--   2. Lock the flight identity pairing used by the Beehiiv sync edge function.
--   3. Preserve a durable row per sync attempt for dry runs and live runs.
--
-- Canonical identity rule:
--   flight_key is the machine identifier: uppercase, underscore-delimited, no spaces.
--     Example: FL_051126
--   flight_id is the display identifier used in Beehiiv copy: uppercase, space-delimited.
--     Example: FL 051126
--   The pair is valid only when flight_key equals upper(trim(flight_id)) with whitespace
--   collapsed to underscores. Example: FL 051126 -> FL_051126.

CREATE TABLE IF NOT EXISTS public.beehiiv_sync_log (
  id                   BIGSERIAL PRIMARY KEY,
  request_id            UUID NOT NULL DEFAULT gen_random_uuid(),
  flight_key            TEXT NOT NULL,
  flight_id             TEXT NOT NULL,
  cohort_id             TEXT NOT NULL,
  segment_key           TEXT,
  dry_run               BOOLEAN NOT NULL DEFAULT TRUE,
  status                TEXT NOT NULL DEFAULT 'started'
                         CHECK (status IN ('started', 'completed', 'failed', 'skipped')),
  matched               INTEGER NOT NULL DEFAULT 0 CHECK (matched >= 0),
  updated               INTEGER NOT NULL DEFAULT 0 CHECK (updated >= 0),
  failed                INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  skipped               INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  boarding_opened_at    TIMESTAMPTZ,
  boarding_closed_at    TIMESTAMPTZ,
  error_message         TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,

  CONSTRAINT beehiiv_sync_log_flight_key_format
    CHECK (flight_key ~ '^[A-Z0-9_]+$'),
  CONSTRAINT beehiiv_sync_log_flight_id_format
    CHECK (flight_id ~ '^[A-Z0-9 ]+$'),
  CONSTRAINT beehiiv_sync_log_flight_pair_canonical
    CHECK (flight_key = regexp_replace(upper(trim(flight_id)), '\\s+', '_', 'g')),
  CONSTRAINT beehiiv_sync_log_completed_when_terminal
    CHECK (
      (status IN ('completed', 'failed', 'skipped') AND completed_at IS NOT NULL)
      OR (status = 'started')
    )
);

CREATE INDEX IF NOT EXISTS beehiiv_sync_log_request_id_idx
  ON public.beehiiv_sync_log (request_id);

CREATE INDEX IF NOT EXISTS beehiiv_sync_log_flight_key_created_at_idx
  ON public.beehiiv_sync_log (flight_key, created_at DESC);

CREATE INDEX IF NOT EXISTS beehiiv_sync_log_cohort_id_created_at_idx
  ON public.beehiiv_sync_log (cohort_id, created_at DESC);

CREATE INDEX IF NOT EXISTS beehiiv_sync_log_status_created_at_idx
  ON public.beehiiv_sync_log (status, created_at DESC);

CREATE INDEX IF NOT EXISTS beehiiv_sync_log_metadata_gin_idx
  ON public.beehiiv_sync_log USING GIN (metadata);

ALTER TABLE public.beehiiv_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_beehiiv_sync_log"
  ON public.beehiiv_sync_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.beehiiv_sync_log IS
  'Durable audit log for Beehiiv flight/cohort sync attempts. One row per dry-run or live sync invocation.';

COMMENT ON COLUMN public.beehiiv_sync_log.flight_key IS
  'Canonical machine identifier, uppercase with underscores, e.g. FL_051126.';

COMMENT ON COLUMN public.beehiiv_sync_log.flight_id IS
  'Canonical display identifier for Beehiiv copy, uppercase with spaces, e.g. FL 051126.';

COMMENT ON COLUMN public.beehiiv_sync_log.metadata IS
  'Non-secret sync metadata such as edge-function input shape, normalized counts, and Beehiiv response summaries. Never store API keys or raw subscriber PII beyond operationally necessary identifiers.';
