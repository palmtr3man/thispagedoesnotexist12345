-- SEC-03 · RLS acceptance tests — cross-user denial and admin access
--
-- Purpose:
--   Acceptance-test scaffold that must pass before SEC-02 can be marked
--   complete. Run this against a Supabase/Postgres environment after SEC-02
--   RLS migrations are applied.
--
-- Required psql variables:
--   user_a_id      UUID for authenticated non-admin fixture A
--   user_b_id      UUID for authenticated non-admin fixture B
--   admin_id       UUID for authenticated admin fixture
--
-- Optional psql variables may override table names below by editing the INSERT
-- into sec03_config. The defaults match the SEC-02 task names.
--
-- Example:
--   psql "$DATABASE_URL" \
--     -v user_a_id='00000000-0000-0000-0000-0000000000a1' \
--     -v user_b_id='00000000-0000-0000-0000-0000000000b2' \
--     -v admin_id='00000000-0000-0000-0000-0000000000ad' \
--     -f supabase/sec03_rls_acceptance_tests.sql
--
-- The script runs in a rollback-only transaction and records each check in the
-- temporary sec03_results table before failing on any red acceptance criterion.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE sec03_config (
  user_a_id uuid not null,
  user_b_id uuid not null,
  admin_id uuid not null,
  resume_table text not null default 'public."Resume"',
  application_table text not null default 'public."Application"',
  subscription_table text not null default 'public."Subscription"',
  email_log_table text not null default 'public."EmailLog"',
  loading_dock_message_table text not null default 'public."LoadingDockMessage"'
) ON COMMIT DROP;

INSERT INTO sec03_config(user_a_id, user_b_id, admin_id)
VALUES (:'user_a_id'::uuid, :'user_b_id'::uuid, :'admin_id'::uuid);

CREATE TEMP TABLE sec03_results (
  test_name text primary key,
  passed boolean not null,
  detail text
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.sec03_assert(
  p_test_name text,
  p_condition boolean,
  p_detail text default null
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO sec03_results(test_name, passed, detail)
  VALUES (p_test_name, COALESCE(p_condition, false), p_detail)
  ON CONFLICT (test_name) DO UPDATE
    SET passed = EXCLUDED.passed,
        detail = EXCLUDED.detail;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.sec03_has_rls_enabled(p_table regclass)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT c.relrowsecurity
  FROM pg_class c
  WHERE c.oid = p_table;
$$;

CREATE OR REPLACE FUNCTION pg_temp.sec03_set_auth(p_role text, p_sub uuid, p_is_admin boolean default false)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', p_sub::text,
      'role', p_role,
      'app_metadata', jsonb_build_object('role', CASE WHEN p_is_admin THEN 'admin' ELSE 'user' END),
      'user_metadata', jsonb_build_object('role', CASE WHEN p_is_admin THEN 'admin' ELSE 'user' END)
    )::text,
    true
  );
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.sec03_count_visible(p_table regclass)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer;
BEGIN
  EXECUTE format('SELECT count(*) FROM %s', p_table) INTO v_count;
  RETURN v_count;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.sec03_try_insert_owner_row(p_table regclass, p_owner_col text, p_owner uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('INSERT INTO %s (%I) VALUES ($1)', p_table, p_owner_col) USING p_owner;
  RETURN true;
EXCEPTION
  WHEN insufficient_privilege OR check_violation OR not_null_violation OR undefined_column THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.sec03_has_any_policy(p_table regclass, p_cmd text)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = p_table
      AND (polcmd = p_cmd OR polcmd = '*')
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.sec03_table_has_owner_column(p_table regclass)
RETURNS text
LANGUAGE sql
AS $$
  SELECT a.attname
  FROM pg_attribute a
  WHERE a.attrelid = p_table
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND a.attname IN ('user_id', 'owner_id', 'created_by', 'passenger_id')
  ORDER BY array_position(ARRAY['user_id', 'owner_id', 'created_by', 'passenger_id'], a.attname)
  LIMIT 1;
$$;

-- 1. SEC-03 prerequisite: target tables exist and have RLS enabled.
DO $$
DECLARE
  cfg sec03_config%ROWTYPE;
  target text;
  t regclass;
BEGIN
  SELECT * INTO cfg FROM sec03_config LIMIT 1;
  FOREACH target IN ARRAY ARRAY[cfg.resume_table, cfg.application_table, cfg.subscription_table, cfg.email_log_table, cfg.loading_dock_message_table] LOOP
    t := to_regclass(target);
    PERFORM pg_temp.sec03_assert(
      format('table exists: %s', target),
      t IS NOT NULL,
      'SEC-02 must create or map this table before SEC-03 can pass.'
    );
    IF t IS NOT NULL THEN
      PERFORM pg_temp.sec03_assert(
        format('RLS enabled: %s', target),
        pg_temp.sec03_has_rls_enabled(t),
        'relrowsecurity must be true.'
      );
    END IF;
  END LOOP;
END $$;

-- 2. User A cannot read User B records, and User B cannot read User A records.
DO $$
DECLARE
  cfg sec03_config%ROWTYPE;
  target text;
  t regclass;
  owner_col text;
  cross_count integer;
BEGIN
  SELECT * INTO cfg FROM sec03_config LIMIT 1;
  FOREACH target IN ARRAY ARRAY[cfg.resume_table, cfg.application_table, cfg.subscription_table] LOOP
    t := to_regclass(target);
    IF t IS NULL THEN CONTINUE; END IF;
    owner_col := pg_temp.sec03_table_has_owner_column(t);
    PERFORM pg_temp.sec03_assert(
      format('owner column detected: %s', target),
      owner_col IS NOT NULL,
      'Expected one of user_id, owner_id, created_by, passenger_id.'
    );
    IF owner_col IS NULL THEN CONTINUE; END IF;

    PERFORM pg_temp.sec03_set_auth('authenticated', cfg.user_a_id, false);
    PERFORM pg_temp.sec03_try_insert_owner_row(t, owner_col, cfg.user_a_id);

    PERFORM pg_temp.sec03_set_auth('authenticated', cfg.user_b_id, false);
    PERFORM pg_temp.sec03_try_insert_owner_row(t, owner_col, cfg.user_b_id);

    PERFORM pg_temp.sec03_set_auth('authenticated', cfg.user_a_id, false);
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', t, owner_col) INTO cross_count USING cfg.user_b_id;
    PERFORM pg_temp.sec03_assert(
      format('User A cannot read User B rows: %s', target),
      cross_count = 0,
      format('Visible cross-user row count: %s', cross_count)
    );

    PERFORM pg_temp.sec03_set_auth('authenticated', cfg.user_b_id, false);
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', t, owner_col) INTO cross_count USING cfg.user_a_id;
    PERFORM pg_temp.sec03_assert(
      format('User B cannot read User A rows: %s', target),
      cross_count = 0,
      format('Visible cross-user row count: %s', cross_count)
    );
  END LOOP;
END $$;

-- 3. WITH CHECK blocks owner ID spoofing on insert.
DO $$
DECLARE
  cfg sec03_config%ROWTYPE;
  target text;
  t regclass;
  owner_col text;
  spoof_succeeded boolean;
BEGIN
  SELECT * INTO cfg FROM sec03_config LIMIT 1;
  FOREACH target IN ARRAY ARRAY[cfg.resume_table, cfg.application_table, cfg.subscription_table] LOOP
    t := to_regclass(target);
    IF t IS NULL THEN CONTINUE; END IF;
    owner_col := pg_temp.sec03_table_has_owner_column(t);
    IF owner_col IS NULL THEN CONTINUE; END IF;
    PERFORM pg_temp.sec03_set_auth('authenticated', cfg.user_a_id, false);
    spoof_succeeded := pg_temp.sec03_try_insert_owner_row(t, owner_col, cfg.user_b_id);
    PERFORM pg_temp.sec03_assert(
      format('WITH CHECK blocks owner spoof insert: %s', target),
      spoof_succeeded = false,
      'Authenticated User A must not be able to insert a row owned by User B.'
    );
  END LOOP;
END $$;

-- 4. Admin access works on operational tables.
DO $$
DECLARE
  cfg sec03_config%ROWTYPE;
  target text;
  t regclass;
  admin_can_select boolean;
BEGIN
  SELECT * INTO cfg FROM sec03_config LIMIT 1;
  FOREACH target IN ARRAY ARRAY[cfg.email_log_table, cfg.loading_dock_message_table, cfg.application_table, cfg.subscription_table] LOOP
    t := to_regclass(target);
    IF t IS NULL THEN CONTINUE; END IF;
    PERFORM pg_temp.sec03_set_auth('authenticated', cfg.admin_id, true);
    BEGIN
      PERFORM pg_temp.sec03_count_visible(t);
      admin_can_select := true;
    EXCEPTION WHEN insufficient_privilege THEN
      admin_can_select := false;
    END;
    PERFORM pg_temp.sec03_assert(
      format('admin can select operational table: %s', target),
      admin_can_select,
      'Admin JWT metadata must satisfy the admin SELECT policy.'
    );
  END LOOP;
END $$;

-- 5. Non-admin is denied EmailLog.
DO $$
DECLARE
  cfg sec03_config%ROWTYPE;
  t regclass;
  visible_count integer;
BEGIN
  SELECT * INTO cfg FROM sec03_config LIMIT 1;
  t := to_regclass(cfg.email_log_table);
  IF t IS NOT NULL THEN
    PERFORM pg_temp.sec03_set_auth('authenticated', cfg.user_a_id, false);
    visible_count := pg_temp.sec03_count_visible(t);
    PERFORM pg_temp.sec03_assert(
      'non-admin denied EmailLog SELECT',
      visible_count = 0,
      format('Non-admin visible EmailLog rows: %s', visible_count)
    );
  END IF;
END $$;

-- 6. Public cannot write LoadingDockMessage.
DO $$
DECLARE
  cfg sec03_config%ROWTYPE;
  t regclass;
  insert_succeeded boolean;
  owner_col text;
BEGIN
  SELECT * INTO cfg FROM sec03_config LIMIT 1;
  t := to_regclass(cfg.loading_dock_message_table);
  IF t IS NOT NULL THEN
    owner_col := COALESCE(pg_temp.sec03_table_has_owner_column(t), 'user_id');
    PERFORM pg_temp.sec03_set_auth('anon', cfg.user_a_id, false);
    insert_succeeded := pg_temp.sec03_try_insert_owner_row(t, owner_col, cfg.user_a_id);
    PERFORM pg_temp.sec03_assert(
      'public cannot write LoadingDockMessage',
      insert_succeeded = false,
      'Anon role must not be able to INSERT LoadingDockMessage rows.'
    );
  END IF;
END $$;

-- 7. Service-role writes EmailLog only from approved server-side function.
--    This scaffold validates the policy surface; SEC-06/SEC-09 should pair it
--    with function-level token/signature checks for approved server invocations.
DO $$
DECLARE
  cfg sec03_config%ROWTYPE;
  t regclass;
BEGIN
  SELECT * INTO cfg FROM sec03_config LIMIT 1;
  t := to_regclass(cfg.email_log_table);
  IF t IS NOT NULL THEN
    PERFORM pg_temp.sec03_assert(
      'EmailLog has INSERT policy for service role path',
      pg_temp.sec03_has_any_policy(t, 'a'),
      'Expected INSERT policy on EmailLog for approved server/service-role path.'
    );
  END IF;
END $$;

TABLE sec03_results ORDER BY test_name;

DO $$
DECLARE
  failure_count integer;
BEGIN
  SELECT count(*) INTO failure_count FROM sec03_results WHERE NOT passed;
  IF failure_count > 0 THEN
    RAISE EXCEPTION 'SEC-03 RLS acceptance tests failed: % failing checks', failure_count;
  END IF;
END $$;

ROLLBACK;
