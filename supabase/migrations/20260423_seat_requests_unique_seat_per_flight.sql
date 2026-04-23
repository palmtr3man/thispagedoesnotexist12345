-- Migration: seat_requests_unique_seat_per_flight
-- Flag 3 of 9 — Supabase backfill: unique constraint keyed by seat_id per flight
-- Applied: 2026-04-23
-- Owner: Kevin / Manus
--
-- Adds a unique partial index on (seat_id, flight_id) to the seat_requests table.
-- This enforces the invariant that a given seat code (TUJ-XXXXXX) can only appear
-- once per flight, preventing duplicate seat assignments at the DB layer.
--
-- The index is partial (WHERE status != 'cancelled') so that a cancelled seat
-- record does not block re-issuance of the same seat code on the same flight
-- in edge-case recovery scenarios.
--
-- Idempotency: uses CREATE UNIQUE INDEX IF NOT EXISTS — safe to re-run.
--
-- Companion to:
--   20260412_seat_requests_cohorts.sql  — creates seat_requests table
--   base44/functions/patchAlphaSeats    — backfills seats 2–5 + deduplicates seat_1
-- ============================================================

-- Step 1: Remove any existing duplicate (seat_id, flight_id) rows before
-- applying the constraint, keeping the most recently created record.
-- This is a safety net for the alpha cohort where a seat_1 duplicate
-- may have been written before the constraint existed.
DELETE FROM public.seat_requests
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY seat_id, flight_id
        ORDER BY created_at DESC  -- keep the newest row
      ) AS rn
    FROM public.seat_requests
    WHERE status != 'cancelled'
  ) ranked
  WHERE rn > 1
);

-- Step 2: Add the unique partial index.
-- Keyed by (seat_id, flight_id) — one TUJ-XXXXXX code per flight.
-- Excludes cancelled rows so recovery re-issuance is not blocked.
CREATE UNIQUE INDEX IF NOT EXISTS seat_requests_unique_seat_per_flight
  ON public.seat_requests (seat_id, flight_id)
  WHERE status != 'cancelled';

-- Step 3: Add a secondary unique partial index on (email, flight_id)
-- to prevent a passenger from holding two active seat records on the
-- same flight (belt-and-suspenders alongside the seat_id constraint).
CREATE UNIQUE INDEX IF NOT EXISTS seat_requests_unique_email_per_flight
  ON public.seat_requests (email, flight_id)
  WHERE status != 'cancelled';
