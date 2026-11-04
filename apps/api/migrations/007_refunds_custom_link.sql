-- Refunds (append-only financial record), customer customisation, share-link attribution.
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL,
  restocked boolean NOT NULL DEFAULT false,
  kind text NOT NULL DEFAULT 'order' CHECK (kind IN ('order','unfulfilled')),
  provider text NOT NULL,
  provider_ref text NOT NULL,
  idempotency_key text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refunds_idem ON refunds(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON refunds(order_id);
CREATE TRIGGER refunds_no_mut BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION append_only();
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY; ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY refunds_rw ON refunds USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());

ALTER TABLE orders ADD COLUMN refunded_cents int NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= total_cents);
ALTER TABLE orders ADD COLUMN source text;
ALTER TABLE payments ADD COLUMN refund_resolved_at timestamptz;

ALTER TABLE products ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '[]';
ALTER TABLE order_items ADD COLUMN custom_values jsonb NOT NULL DEFAULT '[]';

CREATE TABLE custom_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  bytes int NOT NULL,
  order_id uuid REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON custom_uploads(tenant_id, created_at);
ALTER TABLE custom_uploads ENABLE ROW LEVEL SECURITY; ALTER TABLE custom_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY custom_uploads_rw ON custom_uploads USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
