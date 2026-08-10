-- DB-02: permit the production sync wrapper to resolve and write Vault secrets.
-- The wrapper is SECURITY DEFINER and callable by service_role (used by SEC-05).
--
-- Implementation note: the original INSERT INTO vault.secrets path requires
-- EXECUTE on vault._crypto_aead_det_noncegen and vault._crypto_aead_det_encrypt,
-- both owned by supabase_admin. Since postgres cannot GRANT on functions it does
-- not own, we instead delegate to vault.create_secret / vault.update_secret
-- (owned by supabase_admin, already granted to postgres) which handle the
-- encryption internally without requiring additional grants.

DROP FUNCTION IF EXISTS public.vault_write_secret(text, text, text);

CREATE FUNCTION public.vault_write_secret(
  p_name        text,
  p_secret      text,
  p_description text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM vault.secrets
  WHERE name = p_name
  LIMIT 1;

  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_secret, p_name, p_description, NULL);
  ELSE
    PERFORM vault.update_secret(v_id, p_secret, p_name, p_description, NULL);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.vault_write_secret(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_write_secret(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_write_secret(text, text, text) TO postgres;
