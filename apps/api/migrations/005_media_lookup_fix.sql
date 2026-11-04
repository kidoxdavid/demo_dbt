-- FORCE RLS applies to the definer too. Elevate only for this lookup and restore the previous setting,
-- so the elevated flag can never leak to later statements in the same transaction.
CREATE OR REPLACE FUNCTION media_content_type(k text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE old text := coalesce(current_setting('app.platform_admin', true), ''); r text;
BEGIN
  PERFORM set_config('app.platform_admin', 'on', true);
  SELECT m.content_type INTO r FROM product_media m JOIN products p ON p.id = m.product_id WHERE m.storage_key = k AND p.status = 'active';
  PERFORM set_config('app.platform_admin', old, true);
  RETURN r;
END $$;
