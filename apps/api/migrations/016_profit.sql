-- Profit-first: what the seller actually keeps. Delivery cost the seller paid (entered by them), and business expenses such as advertising.
ALTER TABLE orders ADD COLUMN shipping_cost_cents int CHECK (shipping_cost_cents IS NULL OR shipping_cost_cents >= 0);   -- NULL = not entered yet

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  spent_on date NOT NULL,
  category text NOT NULL CHECK (category IN ('ads','packaging','supplies','software','other')),
  amount_cents int NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  note text CHECK (note IS NULL OR length(note) <= 200),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON expenses(tenant_id, spent_on DESC);
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY; ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY expenses_rw ON expenses USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
REVOKE DELETE, TRUNCATE ON invoices FROM eazy_app;
