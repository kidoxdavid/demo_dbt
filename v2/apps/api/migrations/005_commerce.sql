-- Commerce core: shipping profiles, carts, orders (one customer order -> one seller order per seller -> lines), reservations, payments, ledger, refunds, outbox.
-- Money is integer cents (CAD) everywhere.
ALTER TABLE sellers ADD COLUMN commission_bps int CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 5000);   -- per-seller override of the platform commission

CREATE TABLE shipping_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60), is_default boolean NOT NULL DEFAULT false,
  rate_type text NOT NULL DEFAULT 'flat' CHECK (rate_type IN ('flat','per_item','weight')),
  base_cents int NOT NULL DEFAULT 0 CHECK (base_cents >= 0 AND base_cents <= 100000),
  extra_item_cents int NOT NULL DEFAULT 0 CHECK (extra_item_cents >= 0),     -- per_item: each additional item
  per_kg_cents int NOT NULL DEFAULT 0 CHECK (per_kg_cents >= 0),             -- weight: per started kilogram, added to the base
  free_over_cents int CHECK (free_over_cents IS NULL OR free_over_cents > 0),-- free shipping when THIS seller's items total reaches this
  transit_days_min int NOT NULL DEFAULT 3 CHECK (transit_days_min BETWEEN 0 AND 60), transit_days_max int NOT NULL DEFAULT 6 CHECK (transit_days_max >= transit_days_min AND transit_days_max <= 60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shipping_profiles_one_default ON shipping_profiles(seller_id) WHERE is_default;
ALTER TABLE products ADD COLUMN shipping_profile_id uuid REFERENCES shipping_profiles(id) ON DELETE SET NULL;

-- Carts: one per signed-in buyer, or one per guest (the guest token lives in a cookie; only its hash is stored).
CREATE TABLE carts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE, guest_hash text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK ((user_id IS NULL) <> (guest_hash IS NULL)));
CREATE TABLE cart_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE, variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity int NOT NULL CHECK (quantity BETWEEN 1 AND 20), personalisation jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (cart_id, variant_id));
CREATE TABLE cart_gifts (cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE, seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE, is_gift boolean NOT NULL DEFAULT true, message text CHECK (length(message) <= 300), PRIMARY KEY (cart_id, seller_id));

CREATE SEQUENCE order_number_seq START 10001;
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number bigint NOT NULL UNIQUE DEFAULT nextval('order_number_seq'),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL, email citext NOT NULL, buyer_name text NOT NULL, ship_to jsonb NOT NULL, public_token text NOT NULL UNIQUE,
  currency char(3) NOT NULL DEFAULT 'CAD', items_cents int NOT NULL, shipping_cents int NOT NULL, tax_cents int NOT NULL, total_cents int NOT NULL CHECK (total_cents = items_cents + shipping_cents + tax_cents),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','confirmed','cancelled')),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','partially_refunded','refunded')),
  cart_id uuid REFERENCES carts(id) ON DELETE SET NULL, reservation_expires_at timestamptz, idempotency_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz
);
CREATE INDEX orders_user ON orders(user_id, created_at DESC);
CREATE TABLE seller_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, seller_id uuid NOT NULL REFERENCES sellers(id), shop_id uuid NOT NULL REFERENCES shops(id),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','new','accepted','shipped','delivered','cancelled')),
  items_cents int NOT NULL, shipping_cents int NOT NULL, tax_cents int NOT NULL, total_cents int NOT NULL CHECK (total_cents = items_cents + shipping_cents + tax_cents),
  commission_bps int NOT NULL, commission_cents int NOT NULL CHECK (commission_cents >= 0), refunded_cents int NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= total_cents),
  shipping_refunded boolean NOT NULL DEFAULT false, gift jsonb, ship_by date, est_delivery_min date, est_delivery_max date, tracking_carrier text, tracking_number text, shipped_at timestamptz, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seller_id)
);
CREATE INDEX seller_orders_seller ON seller_orders(seller_id, created_at DESC);
CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, seller_order_id uuid NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL, variant_id uuid REFERENCES variants(id) ON DELETE SET NULL,
  title text NOT NULL, variant_label text, options jsonb NOT NULL DEFAULT '{}', sku text, image_media_id uuid, art_kind text, art_tone text,
  unit_price_cents int NOT NULL CHECK (unit_price_cents >= 0), quantity int NOT NULL CHECK (quantity >= 1), tax_cents int NOT NULL DEFAULT 0, commission_cents int NOT NULL DEFAULT 0,
  personalisation jsonb NOT NULL DEFAULT '{}', refunded_qty int NOT NULL DEFAULT 0 CHECK (refunded_qty >= 0 AND refunded_qty <= quantity)
);

-- Stock holds during checkout. held -> committed (paid) or released (failed or expired).
CREATE TABLE stock_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, variant_id uuid NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity int NOT NULL CHECK (quantity > 0), status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','committed','released')), expires_at timestamptz NOT NULL);
CREATE INDEX stock_reservations_due ON stock_reservations(expires_at) WHERE status = 'held';

CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE, provider text NOT NULL, provider_ref text NOT NULL UNIQUE,
  amount_cents int NOT NULL CHECK (amount_cents >= 0), currency char(3) NOT NULL DEFAULT 'CAD', status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')), created_at timestamptz NOT NULL DEFAULT now());
-- A payment event from the provider is applied once, however many times it is delivered.
CREATE TABLE webhook_events (id text PRIMARY KEY, provider text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());

-- Double-entry ledger, append-only. Every transaction must sum to zero (checked when the transaction commits).
CREATE TABLE ledger_entries (id bigserial PRIMARY KEY, txn_id uuid NOT NULL, order_id uuid REFERENCES orders(id), seller_order_id uuid REFERENCES seller_orders(id), seller_id uuid REFERENCES sellers(id),
  account text NOT NULL CHECK (account IN ('cash','seller_payable','commission_revenue','tax_payable')), amount_cents bigint NOT NULL, memo text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ledger_txn ON ledger_entries(txn_id); CREATE INDEX ledger_seller ON ledger_entries(seller_id, account);
CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger_entries is append-only'; END $$;
CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
CREATE FUNCTION ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF (SELECT sum(amount_cents) FROM ledger_entries WHERE txn_id = NEW.txn_id) <> 0 THEN RAISE EXCEPTION 'ledger_unbalanced'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER ledger_balance_check AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_balanced();

CREATE TABLE refunds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), seller_order_id uuid NOT NULL REFERENCES seller_orders(id), payment_id uuid NOT NULL REFERENCES payments(id),
  amount_cents int NOT NULL CHECK (amount_cents > 0), commission_returned_cents int NOT NULL DEFAULT 0, tax_returned_cents int NOT NULL DEFAULT 0, reason text NOT NULL, lines jsonb NOT NULL DEFAULT '[]', restock boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')), provider_ref text, idempotency_key text UNIQUE, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Outbox: an email is recorded in the same transaction as the event that caused it, then sent by a worker (so it is never lost and never sent for a rolled-back event).
CREATE TABLE outbox_emails (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), to_email citext NOT NULL, template text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')), attempts int NOT NULL DEFAULT 0, send_after timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, error text,
  subject text, body text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX outbox_due ON outbox_emails(send_after) WHERE status = 'pending';
