-- Per-maker switches the admin can flip, and "acting as a maker" sessions (an admin working inside one maker's studio, for a limited time, with a reason).
CREATE TABLE seller_flags (
  seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE, key text NOT NULL CHECK (key IN ('ads','store_promotions','publishing')),
  enabled boolean NOT NULL, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (seller_id, key)
);
ALTER TABLE sessions ADD COLUMN acting_seller_id uuid REFERENCES sellers(id) ON DELETE CASCADE, ADD COLUMN acting_reason text;
