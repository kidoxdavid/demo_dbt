CREATE TABLE product_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes int NOT NULL CHECK (bytes > 0),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON product_media(product_id, position);
ALTER TABLE product_media ENABLE ROW LEVEL SECURITY; ALTER TABLE product_media FORCE ROW LEVEL SECURITY;
CREATE POLICY product_media_rw ON product_media USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());
-- Serving an image needs only its random key; resolve content type without tenant context.
CREATE FUNCTION media_content_type(k text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT m.content_type FROM product_media m JOIN products p ON p.id = m.product_id WHERE m.storage_key = k AND p.status = 'active' $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_media TO eazy_app;
GRANT EXECUTE ON FUNCTION media_content_type(text) TO eazy_app;
