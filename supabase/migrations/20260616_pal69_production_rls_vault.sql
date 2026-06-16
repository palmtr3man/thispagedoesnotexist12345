-- PAL-69 PRODUCTION FIX MIGRATION — Jun 16, 2026
-- Applied to: tuj-backend (dykyabqoilzvuncikzkd)
--
-- Three fixes:
--   1. Store SERVICE_ROLE_KEY in Vault (secret value loaded from Infisical/env at apply time)
--   2. Fix waitlist_submissions anon INSERT policy (broken WITH CHECK was blocking client inserts)
--   3. Apply PAL-69 RLS lockdown to five operational tables missing from SEC-02
--
-- NOTE: The SERVICE_ROLE_KEY value is NOT stored in this file.
--       Apply via Supabase SQL editor with the secret substituted, or use:
--         SELECT vault.create_secret('<key>', 'SERVICE_ROLE_KEY', 'description');
--       The key is stored in Infisical under SUPABASE_SERVICE_ROLE_KEY.

-- ── 1. Store SERVICE_ROLE_KEY in Vault ──────────────────────────────────────
-- Run this block manually with the actual key value from Infisical.
-- vault.create_secret(secret text, name text, description text)
-- vault.update_secret(id uuid, secret text, name text, description text)
DO $$
DECLARE
  existing_id uuid;
  v_key text := '<SUPABASE_SERVICE_ROLE_KEY_FROM_INFISICAL>';
  v_name text := 'SERVICE_ROLE_KEY';
  v_desc text := 'Supabase service_role JWT for fire_positioning_brief trigger';
BEGIN
  SELECT id INTO existing_id FROM vault.secrets WHERE name = v_name LIMIT 1;
  IF existing_id IS NULL THEN
    PERFORM vault.create_secret(v_key, v_name, v_desc);
    RAISE NOTICE 'Vault: SERVICE_ROLE_KEY created';
  ELSE
    PERFORM vault.update_secret(existing_id, v_key, v_name, v_desc);
    RAISE NOTICE 'Vault: SERVICE_ROLE_KEY updated (id=%)', existing_id;
  END IF;
END $$;

-- ── 2. Fix waitlist_submissions anon INSERT policy ───────────────────────────
-- The previous policy waitlist_submissions_service_insert used
-- WITH CHECK (jwt role = 'service_role') which can never be true for
-- anon/authenticated roles, silently blocking all client-side submissions.
-- Replaced with a clean open-insert policy for anon + authenticated.
ALTER TABLE public.waitlist_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist_submissions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS waitlist_submissions_service_insert ON public.waitlist_submissions;
DROP POLICY IF EXISTS pal69_waitlist_anon_insert ON public.waitlist_submissions;
DROP POLICY IF EXISTS pal69_waitlist_service_all ON public.waitlist_submissions;

-- Anon + authenticated: INSERT only (public intake form)
CREATE POLICY pal69_waitlist_anon_insert
  ON public.waitlist_submissions
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- service_role: full access (reads, writes, deletes for backend operations)
CREATE POLICY pal69_waitlist_service_all
  ON public.waitlist_submissions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── 3. PAL-69 RLS lockdown — five operational tables ────────────────────────
-- These tables were missing from SEC-02 (20260511_sec02_rls_flagged_tables.sql).
-- All five are server-side operational tables — no direct user access.
-- Policy class: admin_service (admin SELECT + service_role ALL).
DO $$
DECLARE
  admin_pred constant text :=
    'coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', '
    'auth.jwt() -> ''user_metadata'' ->> ''role'', '''') = ''admin''';
  t text;
  toid regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.cohorts',
    'public.seat_requests',
    'public.cohort_open_count_events',
    'public.boarding_email_send_ledger',
    'public.seat_opened_events'
  ] LOOP
    toid := to_regclass(t);
    IF toid IS NULL THEN
      RAISE NOTICE 'PAL-69 skip: % not found in this environment', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', toid);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', toid);

    EXECUTE format('DROP POLICY IF EXISTS pal69_admin_select ON %s', toid);
    EXECUTE format('DROP POLICY IF EXISTS pal69_service_all ON %s', toid);

    EXECUTE format(
      'CREATE POLICY pal69_admin_select ON %s FOR SELECT TO authenticated USING (%s)',
      toid, admin_pred
    );
    EXECUTE format(
      'CREATE POLICY pal69_service_all ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)',
      toid
    );

    RAISE NOTICE 'PAL-69 applied: %', t;
  END LOOP;
END $$;
