-- Drops and waitlists: demand before you make it, and a way for buyers to follow makers and get first access.
ALTER TABLE products ADD COLUMN available_from timestamptz;            -- a drop: visible, but not purchasable until this time
ALTER TABLE products ADD COLUMN drop_announced_at timestamptz;          -- followers and the waitlist were told once it went live

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  email citext NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('restock','drop')),
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  UNIQUE (product_id, email)
);
CREATE INDEX ON waitlist_entries(tenant_id, product_id) WHERE notified_at IS NULL;
ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY; ALTER TABLE waitlist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY waitlist_rw ON waitlist_entries USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());

CREATE TABLE store_follows (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
ALTER TABLE store_follows ENABLE ROW LEVEL SECURITY; ALTER TABLE store_follows FORCE ROW LEVEL SECURITY;
CREATE POLICY follows_rw ON store_follows USING (user_id = app_user() OR tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (user_id = app_user() OR app_is_platform());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
REVOKE DELETE, TRUNCATE ON invoices FROM eazy_app;
