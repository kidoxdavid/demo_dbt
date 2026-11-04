-- AI-assisted drafting (EazySnap: photo to listing, EazyLaunch: store text). A draft is only ever a suggestion for the seller to edit; nothing is published from here.
CREATE TABLE ai_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('snap','launch')),
  output jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]',
  model text NOT NULL,
  decision text CHECK (decision IN ('accepted','discarded')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_drafts(tenant_id, created_at DESC);
ALTER TABLE ai_drafts ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_drafts_rw ON ai_drafts USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
REVOKE DELETE, TRUNCATE ON invoices FROM eazy_app;
