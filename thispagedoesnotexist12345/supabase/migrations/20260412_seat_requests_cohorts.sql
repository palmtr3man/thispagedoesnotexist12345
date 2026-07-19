-- BLOCKER-09 (2026-04-12): seat_requests + cohorts tables
-- F148-B — handleSeatOpened: SeatRequest + Cohort open_count + Dual Boarding Sequence
--
-- seat_requests: canonical record of every approved seat assignment.
--   Linked to waitlist_submissions via waitlist_submission_id.
--   Created by admin-approve.js when a seat request is approved.
--
-- cohorts: tracks the active flight cohort and its open_count.
--   open_count is incremented atomically on each approval.
--   Hard cap: open_count must not exceed max_seats (default 5 for alpha).

-- ============================================================
-- Table: seat_requests
-- ============================================================
CREATE TABLE IF NOT EXISTS public.seat_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_submission_id  UUID REFERENCES public.waitlist_submissions(id) ON DELETE SET NULL,
  seat_id                 TEXT NOT NULL,                -- TUJ-XXXXXX canonical seat code
  email                   TEXT NOT NULL,
  first_name              TEXT,
  last_name               TEXT,
  cabin_class             TEXT NOT NULL DEFAULT 'Economy',  -- 'Economy' | 'First' | 'Sponsored'
  flight_id               TEXT NOT NULL DEFAULT 'FL032126',
  status                  TEXT NOT NULL DEFAULT 'opened'
                            CHECK (status IN ('opened', 'boarded', 'departed', 'cancelled')),
  boarding_emails_sent    BOOLEAN NOT NULL DEFAULT FALSE,
  boarding_sent_at        TIMESTAMPTZ,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast email lookups (idempotency checks)
CREATE INDEX IF NOT EXISTS seat_requests_email_idx ON public.seat_requests (email);
CREATE INDEX IF NOT EXISTS seat_requests_seat_id_idx ON public.seat_requests (seat_id);
CREATE INDEX IF NOT EXISTS seat_requests_flight_id_idx ON public.seat_requests (flight_id);

-- RLS: service role can read/write; no public access
ALTER TABLE public.seat_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_seat_requests"
  ON public.seat_requests
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- Table: cohorts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cohorts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id         TEXT NOT NULL UNIQUE,               -- e.g. 'FL032126'
  flight_label      TEXT,                               -- e.g. 'TUJ Alpha Flight 1'
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'boarding', 'departed', 'closed')),
  open_count        INTEGER NOT NULL DEFAULT 0,         -- incremented on each approval
  max_seats         INTEGER NOT NULL DEFAULT 5,         -- hard cap for alpha cohort
  departure_date    DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the alpha cohort (FL032126) — idempotent
INSERT INTO public.cohorts (flight_id, flight_label, status, open_count, max_seats)
VALUES ('FL032126', 'TUJ Alpha Flight 1', 'active', 0, 5)
ON CONFLICT (flight_id) DO NOTHING;

-- RLS: service role can read/write; no public access
ALTER TABLE public.cohorts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_cohorts"
  ON public.cohorts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- Function: increment_cohort_open_count(flight_id TEXT)
-- Atomically increments open_count, capped at max_seats.
-- Returns the new open_count. Safe for concurrent calls.
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_cohort_open_count(p_flight_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  UPDATE public.cohorts
  SET
    open_count = LEAST(open_count + 1, max_seats),
    updated_at = NOW()
  WHERE flight_id = p_flight_id
    AND status = 'active'
  RETURNING open_count INTO v_new_count;

  RETURN COALESCE(v_new_count, -1);  -- -1 = cohort not found or not active
END;
$$;
