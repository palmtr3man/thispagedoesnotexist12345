-- Enable owner-scoped RLS on public."user" and public.user_preferences.
--
-- Schema (tuj-backend / dykyabqoilzvuncikzkd):
--   public."user".uid          text  — maps to auth.uid()
--   public.user_preferences."userSub" text — maps to public."user".uid
--
-- Resolves Supabase advisor: rls_disabled_in_public_public_user
-- and rls_disabled_in_public_public_user_preferences.

DO $$
BEGIN
  IF to_regclass('public."user"') IS NULL THEN
    RAISE NOTICE 'Skipping RLS: public."user" does not exist';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public."user" FORCE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS "Users can manage own row" ON public."user"';
  EXECUTE $policy$
    CREATE POLICY "Users can manage own row"
    ON public."user"
    FOR ALL
    TO authenticated
    USING (auth.uid()::text = uid)
    WITH CHECK (auth.uid()::text = uid)
  $policy$;

  RAISE NOTICE 'RLS enabled on public."user" (owner column: uid)';
END $$;

DO $$
BEGIN
  IF to_regclass('public.user_preferences') IS NULL THEN
    RAISE NOTICE 'Skipping RLS: public.user_preferences does not exist';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS "Users manage own preferences" ON public.user_preferences';
  EXECUTE $policy$
    CREATE POLICY "Users manage own preferences"
    ON public.user_preferences
    FOR ALL
    TO authenticated
    USING (auth.uid()::text = "userSub")
    WITH CHECK (auth.uid()::text = "userSub")
  $policy$;

  RAISE NOTICE 'RLS enabled on public.user_preferences (owner column: "userSub")';
END $$;
