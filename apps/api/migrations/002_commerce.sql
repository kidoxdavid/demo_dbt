-- Phase 3 thin slice: catalogue, inventory, single-seller checkout, orders, payments, ledger.
ALTER TABLE stores ADD COLUMN delivery_fee_cents int NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text,
  brand text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  attributes jsonb NOT NULL DEFAULT '{}',          -- seller-defined custom attributes
  made_to_order boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON products(tenant_id, status, created_at DESC);

CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Default',
  sku text,
  options jsonb NOT NULL DEFAULT '{}',
  price_cents int NOT NULL CHECK (price_cents >= 0),
  cost_cents int CHECK (cost_cents >= 0),           -- nullable: profit shown as unknown when absent
  track_inventory boolean NOT NULL DEFAULT true,
  low_stock_threshold int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON product_variants(tenant_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX ON product_variants(product_id);

CREATE TABLE inventory_levels (
  variant_id uuid PRIMARY KEY REFERENCES product_variants(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  on_hand int NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (reserved <= on_hand)                       -- DB-level oversell guard
);

CREATE TABLE inventory_movements (                  -- append-only history
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  delta int NOT NULL,
  reason text NOT NULL CHECK (reason IN ('initial','adjustment','sale','return','correction')),
  order_id uuid,
  actor_user_id uuid,
  note text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON inventory_movements(variant_id, at DESC);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id),
  number bigint GENERATED ALWAYS AS IDENTITY,
  public_token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment','paid','processing','ready','shipped','completed','cancelled','refunded')),
  customer_email citext NOT NULL,
  customer_name text NOT NULL,
  fulfilment text NOT NULL CHECK (fulfilment IN ('pickup','delivery')),
  delivery_address jsonb,
  currency char(3) NOT NULL,
  subtotal_cents int NOT NULL CHECK (subtotal_cents >= 0),
  shipping_cents int NOT NULL CHECK (shipping_cents >= 0),
  total_cents int NOT NULL CHECK (total_cents = subtotal_cents + shipping_cents),
  platform_fee_bps int NOT NULL,
  reservation_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON orders(tenant_id, created_at DESC);
CREATE INDEX ON orders(status, reservation_expires_at) WHERE status = 'awaiting_payment';

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  name text NOT NULL,                              -- snapshots: later edits never rewrite history
  variant_title text,
  quantity int NOT NULL CHECK (quantity > 0 AND quantity <= 1000),
  unit_price_cents int NOT NULL,
  unit_cost_cents int
);
CREATE INDEX ON order_items(order_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_ref text NOT NULL,
  amount_cents int NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

-- Double-entry ledger, append-only, each group must balance to zero.
CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  group_id uuid NOT NULL,
  order_id uuid,
  account text NOT NULL CHECK (account IN ('cash_received','platform_fee','seller_payable','refunds')),
  amount_cents bigint NOT NULL,                    -- signed; debits +, credits -
  currency char(3) NOT NULL,
  memo text,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, account)
);
CREATE INDEX ON ledger_entries(tenant_id, at);
CREATE FUNCTION ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT sum(amount_cents) FROM ledger_entries WHERE group_id = NEW.group_id) <> 0 THEN
    RAISE EXCEPTION 'ledger group % does not balance', NEW.group_id;
  END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balance AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_balanced();
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER ledger_no_mut BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER movements_no_mut BEFORE UPDATE OR DELETE ON inventory_movements FOR EACH ROW EXECUTE FUNCTION append_only();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['products','product_variants','inventory_levels','inventory_movements','orders','order_items','payments','ledger_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY; ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t, t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id = app_tenant() OR app_is_platform()) WITH CHECK (tenant_id = app_tenant() OR app_is_platform())', t || '_rw', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements FROM eazy_app;
