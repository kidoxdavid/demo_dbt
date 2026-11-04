-- Subscription billing. tenants.plan_id stays the single source of truth for what a seller may do; subscriptions records how and until when it is paid for.
CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  billing_interval text NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly','annual')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','trialing','past_due')),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL DEFAULT now() + interval '1 month',
  trial_ends_at timestamptz,
  trial_used boolean NOT NULL DEFAULT false,                     -- a free trial is offered once per business
  pending_plan_id uuid REFERENCES plans(id),                     -- change that takes effect at period end (downgrade or cancel)
  pending_interval text CHECK (pending_interval IN ('monthly','annual')),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  past_due_since timestamptz,
  last_attempt_at timestamptz,
  provider text NOT NULL DEFAULT 'none',                         -- 'simulated' | 'manual' (set by staff, e.g. enterprise contracts) | a real provider later
  sim_card text NOT NULL DEFAULT 'ok' CHECK (sim_card IN ('ok','declined')),   -- simulated provider only: lets staff and tests exercise a failed payment
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  billing_interval text NOT NULL,
  description text NOT NULL,
  amount_cents int NOT NULL CHECK (amount_cents >= 0),
  credit_cents int NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),  -- unused time on the previous plan, already deducted from amount_cents
  currency char(3) NOT NULL DEFAULT 'CAD',
  status text NOT NULL CHECK (status IN ('paid','failed')),
  attempts int NOT NULL DEFAULT 1,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  provider text NOT NULL, provider_ref text, failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
  UNIQUE (tenant_id, period_start)
);
CREATE INDEX ON invoices(tenant_id, created_at DESC);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY; ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_rw ON subscriptions USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY; ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_rw ON invoices USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());

-- Existing businesses get a subscription that mirrors their current plan; nothing is charged retroactively.
INSERT INTO subscriptions(tenant_id, plan_id, provider, current_period_start, current_period_end)
  SELECT id, plan_id, 'none', now(), now() + interval '1 month' FROM tenants;

INSERT INTO platform_settings(key, value) VALUES ('billing_grace_days', '7') ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
-- invoices are financial records: no edits or deletes after the fact except the retry bookkeeping done by the billing job
REVOKE DELETE, TRUNCATE ON invoices FROM eazy_app;
