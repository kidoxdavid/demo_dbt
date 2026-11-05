-- Saved pieces (the heart on every card) and followed shops. Signed-in buyers only; guests are asked to sign in.
CREATE TABLE saved_products (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, product_id));
CREATE INDEX saved_products_user ON saved_products(user_id, created_at DESC);
CREATE TABLE shop_follows (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, shop_id));
