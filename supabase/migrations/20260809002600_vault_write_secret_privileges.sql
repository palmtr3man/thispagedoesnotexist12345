-- DB-02: permit the production sync wrapper to resolve and write Vault secrets.
-- The wrapper is SECURITY DEFINER and is executable only by postgres.

DROP FUNCTION IF EXISTS public.vault_write_secret(text, text, text);

CREATE FUNCTION public.vault_write_secret(
  p_name text,
  p_secret text,
  p_description text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, vault
AS $$
BEGIN
  INSERT INTO vault.secrets (name, secret, description)
  VALUES (p_name, p_secret, p_description)
  ON CONFLICT (name) DO UPDATE
    SET secret = EXCLUDED.secret,
        description = EXCLUDED.description,
        updated_at = now();
END;
$$;

GRANT SELECT ON vault.secrets TO postgres;
REVOKE ALL ON FUNCTION public.vault_write_secret(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_write_secret(text, text, text) TO postgres;
