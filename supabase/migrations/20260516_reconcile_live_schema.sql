-- File: supabase/migrations/20260516_reconcile_live_schema.sql
-- Reconciles migration tree against actual live DB schema.
-- Applied via Supabase SQL editor in two phases (dashboard $$ injection workaround).
-- All ALTER TABLE statements use IF NOT EXISTS guards.
-- Depends on: 20260514_* and 20260515_* applied first.
-- APPLY METHOD: Use psql -f or split at Phase 2 boundary for dashboard apply.
-- Rollback at bottom.

ALTER TABLE public.passengers
  ADD COLUMN IF NOT EXISTS email TEXT;

-- NOTE: No UNIQUE constraint on email.
-- Identity is keyed by user_id (auth.users). Multi-seat-per-person model
-- unresolved for Beta; constraint deferred until product decision is made.

-- All other columns added by 20260515_*. This migration documents
-- the live schema reconciliation performed on 2026-05-16 and serves
-- as the audit record for the dashboard-applied changes.

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- ALTER TABLE public.passengers DROP COLUMN IF EXISTS email;
