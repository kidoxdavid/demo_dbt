-- Customer accounts (orders history, wishlist) and verified-purchase product reviews. POS support lives on orders (channel, payment_method).
ALTER TABLE orders ADD COLUMN customer_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX orders_customer_user ON orders(customer_user_id) WHERE customer_user_id IS NOT NULL;

CREATE TABLE wishlist_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY; ALTER TABLE wishlist_items FORCE ROW LEVEL SECURITY;
CREATE POLICY wishlist_rw ON wishlist_items USING (user_id = app_user() OR app_is_platform()) WITH CHECK (user_id = app_user() OR app_is_platform());

CREATE TABLE product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_name text NOT NULL,                            -- first name only, snapshotted
  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title text CHECK (title IS NULL OR length(title) <= 120),
  body text CHECK (body IS NULL OR length(body) <= 2000),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','removed')),
  removal_reason text,
  seller_reply text CHECK (seller_reply IS NULL OR length(seller_reply) <= 1000),
  seller_replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX ON product_reviews(product_id, status, created_at DESC);
ALTER TABLE product_reviews ENABLE ROW LEVEL SECURITY; ALTER TABLE product_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY product_reviews_rw ON product_reviews USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
