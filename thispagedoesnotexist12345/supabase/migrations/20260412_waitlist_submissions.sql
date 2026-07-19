-- Migration: waitlist_submissions
-- BLOCKER-04 — Custom Supabase Waitlist Form
-- Applied: 2026-04-12
-- Owner: Kevin / Manus
--
-- Creates the waitlist_submissions table for the Path A intake chain.
-- This table is the Supabase persistence layer for seat requests received
-- via the Custom Waitlist Form on thispagedoesnotexist12345.com / .us.
--
-- Status lifecycle:
--   pending   → submitted, awaiting Admin Tower review (BLOCKER-03)
--   approved  → Admin Tower approved; handleSeatOpened (BLOCKER-09) will fire
--   denied    → Admin Tower denied; next_flight_waitlist_v1 sent
--   waitlisted → cohort full or underage; next_flight_waitlist_v1 sent
--
-- Idempotency: unique constraint on email prevents duplicate rows.
-- On conflict (same email), update source, referral, and updated_at only —
-- do not reset status if already approved or denied.

CREATE TABLE IF NOT EXISTS waitlist_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  first_name      text,
  seat_id         text,                          -- TUJ-XXXXXX token, set after seat-request succeeds
  source          text DEFAULT 'landing',        -- 'landing' | 'newsletter' | 'mission_control'
  referral_code   text UNIQUE,                   -- stable share token for this record
  referred_by     uuid REFERENCES waitlist_submissions(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','denied','waitlisted')),
  age_verified    boolean NOT NULL DEFAULT false, -- true when age_token validated server-side
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one row per email
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_submissions_email_idx
  ON waitlist_submissions (lower(email));

-- Index for Admin Tower queries by status
CREATE INDEX IF NOT EXISTS waitlist_submissions_status_idx
  ON waitlist_submissions (status);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_waitlist_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_waitlist_updated_at ON waitlist_submissions;
CREATE TRIGGER trg_waitlist_updated_at
  BEFORE UPDATE ON waitlist_submissions
  FOR EACH ROW EXECUTE FUNCTION update_waitlist_updated_at();

-- RLS: only service role can write; anon can insert (for public form submissions)
ALTER TABLE waitlist_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_public_insert" ON waitlist_submissions
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "allow_service_all" ON waitlist_submissions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
