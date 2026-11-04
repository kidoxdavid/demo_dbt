-- Discount codes, shipping rules (weight / price / province), product weight and barcode.
ALTER TABLE product_variants ADD COLUMN weight_grams int CHECK (weight_grams IS NULL OR weight_grams >= 0);
ALTER TABLE product_variants ADD COLUMN barcode text;
CREATE UNIQUE INDEX product_variants_barcode ON product_variants(tenant_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE shipping_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  regions text[] NOT NULL DEFAULT '{}',                    -- empty = every province
  min_weight_g int NOT NULL DEFAULT 0 CHECK (min_weight_g >= 0),
  max_weight_g int CHECK (max_weight_g IS NULL OR max_weight_g >= min_weight_g),
  min_subtotal_cents int NOT NULL DEFAULT 0 CHECK (min_subtotal_cents >= 0),
  max_subtotal_cents int CHECK (max_subtotal_cents IS NULL OR max_subtotal_cents >= min_subtotal_cents),
  price_cents int NOT NULL CHECK (price_cents >= 0),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON shipping_rules(tenant_id, position);

CREATE TABLE discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code citext NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent','fixed','free_shipping')),
  value int NOT NULL DEFAULT 0 CHECK (value >= 0),         -- percent (1-100) or cents; 0 for free shipping
  min_subtotal_cents int NOT NULL DEFAULT 0 CHECK (min_subtotal_cents >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  max_uses int CHECK (max_uses IS NULL OR max_uses > 0),
  max_uses_per_email int CHECK (max_uses_per_email IS NULL OR max_uses_per_email > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK ((kind = 'percent' AND value BETWEEN 1 AND 100) OR (kind = 'fixed' AND value > 0) OR (kind = 'free_shipping' AND value = 0))
);
CREATE TABLE discount_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  discount_id uuid NOT NULL REFERENCES discounts(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  email citext NOT NULL,
  amount_cents int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);
CREATE INDEX ON discount_redemptions(discount_id);

ALTER TABLE orders ADD COLUMN discount_cents int NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);
ALTER TABLE orders ADD COLUMN discount_code text;
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'online' CHECK (channel IN ('online','pos'));
ALTER TABLE orders ADD COLUMN payment_method text;
ALTER TABLE orders DROP CONSTRAINT orders_total_includes_tax;
ALTER TABLE orders ADD CONSTRAINT orders_total_includes_tax CHECK (discount_cents <= subtotal_cents AND total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shipping_rules','discounts','discount_redemptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY; ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t, t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform())', t || '_rw', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
