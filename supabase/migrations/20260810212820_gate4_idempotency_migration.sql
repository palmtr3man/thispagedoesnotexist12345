-- Gate 4: SendGrid intake idempotency and seat-request deduplication.
-- Applied to the tuj-backend-staging Supabase project as migration
-- 20260810212820 (gate4_idempotency_migration).

BEGIN;

-- The seat_requests base schema supplies passenger_id, cohort_id, seat_id,
-- status, source, rpc_status, and metadata. Gate 4 adds the caller key and
-- enforces uniqueness for non-null keys.
ALTER TABLE public.seat_requests
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS seat_requests_idempotency_key_uidx
  ON public.seat_requests (idempotency_key);

COMMENT ON COLUMN public.seat_requests.idempotency_key IS
  'Caller-supplied key used to prevent duplicate seat-request intake.';

CREATE TABLE IF NOT EXISTS public.sendgrid_intake_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text,
  idempotency_key text NOT NULL,
  event_type text NOT NULL DEFAULT 'seat_request',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'duplicate', 'failed')),
  error_message text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sendgrid_intake_events_event_id_uidx
  ON public.sendgrid_intake_events (event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sendgrid_intake_events_idempotency_key_idx
  ON public.sendgrid_intake_events (idempotency_key);

CREATE INDEX IF NOT EXISTS sendgrid_intake_events_received_at_idx
  ON public.sendgrid_intake_events (received_at DESC);

COMMENT ON TABLE public.sendgrid_intake_events IS
  'Gate 4 audit ledger for idempotent SendGrid intake processing.';

COMMIT;
