-- Sponsored placement. Sellers pay per click out of their own earnings: every charged click is one balanced ledger entry
-- (seller payable goes down, ad revenue goes up). Impressions and clicks are counted per campaign, product and day.
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check CHECK (account IN ('cash','seller_payable','commission_revenue','tax_payable','ad_revenue'));

CREATE TABLE ad_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended','blocked')), blocked_reason text,
  bid_cents int NOT NULL CHECK (bid_cents BETWEEN 1 AND 5000), daily_budget_cents int NOT NULL CHECK (daily_budget_cents BETWEEN 1 AND 100000), total_budget_cents int CHECK (total_budget_cents IS NULL OR total_budget_cents >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_campaigns_seller ON ad_campaigns(seller_id, created_at DESC);
CREATE TABLE ad_products (campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, PRIMARY KEY (campaign_id, product_id));
CREATE TABLE ad_targets (campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE, kind text NOT NULL CHECK (kind IN ('category','keyword')), value text NOT NULL, PRIMARY KEY (campaign_id, kind, value));
CREATE TABLE ad_daily (campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE, product_id uuid NOT NULL, day date NOT NULL, impressions int NOT NULL DEFAULT 0, clicks int NOT NULL DEFAULT 0, spend_cents int NOT NULL DEFAULT 0, PRIMARY KEY (campaign_id, product_id, day));
-- One row per click token: a token can be used once, and the address and account that clicked are kept so repeat and own-team clicks are not charged.
CREATE TABLE ad_clicks (token_id text PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE, product_id uuid NOT NULL, price_cents int NOT NULL, charged boolean NOT NULL, reason text, ip text, user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ad_clicks_recent ON ad_clicks(campaign_id, ip, created_at DESC);
