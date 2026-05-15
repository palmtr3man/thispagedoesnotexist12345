-- SEC-02 · RLS migrations for flagged cohort-platform tables
--
-- Scope:
--   Enables RLS and installs explicit policies for the 25 flagged table targets
--   in dependency order. The migration is intentionally conditional: it applies
--   policies only to tables that exist in the target database, and owner-only
--   policies only when a recognized owner column is present.
--
-- Policy classes:
--   owner_admin        Authenticated owners can CRUD their rows; admins can read/update/delete.
--   admin_service      Admins can read; service_role can do all writes. Authenticated non-admins are denied.
--   public_read        anon/authenticated can read; service_role writes.
--   public_insert      anon/authenticated can insert only; service_role all. Used for public intake tables.
--
-- Recognized owner columns, in priority order:
--   user_id, owner_id, created_by, passenger_id
--
-- SEC-03 pairing:
--   This migration is built to satisfy the SEC-03 acceptance scaffold for
--   Resume, Application, Subscription, EmailLog, and LoadingDockMessage, while
--   extending the same policy pattern across the full flagged table set.

DO $$
DECLARE
  admin_predicate constant text := 'coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', auth.jwt() -> ''user_metadata'' ->> ''role'', '''') = ''admin''';
  target record;
  table_oid regclass;
  owner_col text;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS sec02_rls_targets (
    table_name text primary key,
    policy_class text not null,
    notes text
  ) ON COMMIT DROP;

  INSERT INTO sec02_rls_targets(table_name, policy_class, notes) VALUES
    ('public."Resume"',              'owner_admin',   'Priority 1 user-owned resume records'),
    ('public."Application"',         'owner_admin',   'Priority 2 user-owned job applications'),
    ('public."Subscription"',        'owner_admin',   'Priority 3 user-owned subscription state'),
    ('public."GmailSyncState"',      'owner_admin',   'Priority 4 user-owned Gmail sync state'),
    ('public."NotionSettings"',      'owner_admin',   'Priority 5 user-owned Notion integration settings'),
    ('public."EmailLog"',            'admin_service', 'Priority 6 operational email audit rows'),
    ('public."PassengerFlight"',     'owner_admin',   'Priority 7 passenger/flight association rows'),
    ('public."Seat"',                'owner_admin',   'Priority 8 passenger seat rows'),
    ('public."Passenger"',           'owner_admin',   'User-associated passenger rows'),
    ('public."Flight"',              'public_read',   'Public read flight metadata; service writes'),
    ('public."JobDescription"',      'owner_admin',   'Creator-owned job descriptions'),
    ('public."CoverLetter"',         'owner_admin',   'Creator-owned cover letters'),
    ('public."ResumeVariant"',       'owner_admin',   'Creator-owned resume variants'),
    ('public."SavedJob"',            'owner_admin',   'Creator-owned saved jobs'),
    ('public."Interview"',           'owner_admin',   'Creator-owned interviews'),
    ('public."FollowUp"',            'owner_admin',   'Creator-owned follow-ups'),
    ('public."Task"',                'owner_admin',   'Creator-owned tasks'),
    ('public."Reminder"',            'owner_admin',   'Creator-owned reminders'),
    ('public."LoadingDockMessage"',  'public_read',   'Public-read loading dock messages; service writes only'),
    ('public."EmailTemplate"',       'public_read',   'Public-read template metadata; service writes'),
    ('public."TemplateRegistry"',    'public_read',   'Public-read template registry; service writes'),
    ('public."Cohort"',              'public_read',   'Public-read cohort metadata; service writes'),
    ('public."AuditLog"',            'admin_service', 'Operational audit log'),
    ('public."WaitlistSubmission"',  'public_insert', 'Public intake rows'),
    ('public."UserProfile"',         'owner_admin',   'User-owned profile rows')
  ON CONFLICT (table_name) DO UPDATE
    SET policy_class = EXCLUDED.policy_class,
        notes = EXCLUDED.notes;

  FOR target IN SELECT * FROM sec02_rls_targets ORDER BY table_name LOOP
    table_oid := to_regclass(target.table_name);

    IF table_oid IS NULL THEN
      RAISE NOTICE 'SEC-02 skip: % does not exist in this environment', target.table_name;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_oid);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', table_oid);

    EXECUTE format('DROP POLICY IF EXISTS sec02_owner_select ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_owner_insert ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_owner_update ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_owner_delete ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_admin_select ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_admin_update ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_admin_delete ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_public_select ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_public_insert ON %s', table_oid);
    EXECUTE format('DROP POLICY IF EXISTS sec02_service_all ON %s', table_oid);

    owner_col := NULL;
    SELECT a.attname INTO owner_col
    FROM pg_attribute a
    WHERE a.attrelid = table_oid
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname IN ('user_id', 'owner_id', 'created_by', 'passenger_id')
    ORDER BY array_position(ARRAY['user_id', 'owner_id', 'created_by', 'passenger_id'], a.attname)
    LIMIT 1;

    IF target.policy_class = 'owner_admin' THEN
      IF owner_col IS NULL THEN
        RAISE WARNING 'SEC-02 owner_admin table % has no recognized owner column; only admin/service policies will be installed', target.table_name;
      ELSE
        EXECUTE format('CREATE POLICY sec02_owner_select ON %s FOR SELECT TO authenticated USING (%I = auth.uid())', table_oid, owner_col);
        EXECUTE format('CREATE POLICY sec02_owner_insert ON %s FOR INSERT TO authenticated WITH CHECK (%I = auth.uid())', table_oid, owner_col);
        EXECUTE format('CREATE POLICY sec02_owner_update ON %s FOR UPDATE TO authenticated USING (%I = auth.uid()) WITH CHECK (%I = auth.uid())', table_oid, owner_col, owner_col);
        EXECUTE format('CREATE POLICY sec02_owner_delete ON %s FOR DELETE TO authenticated USING (%I = auth.uid())', table_oid, owner_col);
      END IF;

      EXECUTE format('CREATE POLICY sec02_admin_select ON %s FOR SELECT TO authenticated USING (%s)', table_oid, admin_predicate);
      EXECUTE format('CREATE POLICY sec02_admin_update ON %s FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', table_oid, admin_predicate, admin_predicate);
      EXECUTE format('CREATE POLICY sec02_admin_delete ON %s FOR DELETE TO authenticated USING (%s)', table_oid, admin_predicate);
      EXECUTE format('CREATE POLICY sec02_service_all ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)', table_oid);

    ELSIF target.policy_class = 'admin_service' THEN
      EXECUTE format('CREATE POLICY sec02_admin_select ON %s FOR SELECT TO authenticated USING (%s)', table_oid, admin_predicate);
      EXECUTE format('CREATE POLICY sec02_service_all ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)', table_oid);

    ELSIF target.policy_class = 'public_read' THEN
      EXECUTE format('CREATE POLICY sec02_public_select ON %s FOR SELECT TO anon, authenticated USING (true)', table_oid);
      EXECUTE format('CREATE POLICY sec02_service_all ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)', table_oid);

    ELSIF target.policy_class = 'public_insert' THEN
      EXECUTE format('CREATE POLICY sec02_public_insert ON %s FOR INSERT TO anon, authenticated WITH CHECK (true)', table_oid);
      EXECUTE format('CREATE POLICY sec02_service_all ON %s FOR ALL TO service_role USING (true) WITH CHECK (true)', table_oid);

    ELSE
      RAISE EXCEPTION 'Unknown SEC-02 policy class % for table %', target.policy_class, target.table_name;
    END IF;
  END LOOP;
END $$;
