-- Engagement: verified-purchase reviews with seller replies, and conversations between buyers and sellers.
-- A shop's displayed rating blends a base (the seeded demo rating, zero for real shops) with its published reviews.
ALTER TABLE shops ADD COLUMN rating_base_avg numeric(3,2) NOT NULL DEFAULT 0, ADD COLUMN rating_base_count int NOT NULL DEFAULT 0;
UPDATE shops SET rating_base_avg = coalesce(rating_avg, 0), rating_base_count = rating_count;

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE, seller_id uuid NOT NULL REFERENCES sellers(id),
  seller_order_id uuid NOT NULL REFERENCES seller_orders(id), user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name text NOT NULL, rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5), title text CHECK (title IS NULL OR length(title) <= 100), body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  seller_reply text CHECK (seller_reply IS NULL OR length(seller_reply) BETWEEN 1 AND 1000), replied_at timestamptz,
  reported_at timestamptz, report_reason text, report_status text CHECK (report_status IN ('open','kept','hidden')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_order_id, product_id)
);
CREATE INDEX reviews_product ON reviews(product_id, created_at DESC) WHERE status='published';
CREATE INDEX reviews_shop ON reviews(shop_id, created_at DESC) WHERE status='published';
CREATE INDEX reviews_reported ON reviews(reported_at) WHERE report_status='open';

CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE, seller_id uuid NOT NULL REFERENCES sellers(id),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL, guest_email citext, buyer_name text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL, seller_order_id uuid REFERENCES seller_orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), last_message_at timestamptz NOT NULL DEFAULT now(), last_sender text NOT NULL DEFAULT 'buyer' CHECK (last_sender IN ('buyer','seller')),
  buyer_read_at timestamptz, seller_read_at timestamptz,
  CHECK (user_id IS NOT NULL OR guest_email IS NOT NULL)
);
CREATE UNIQUE INDEX threads_order ON threads(seller_order_id) WHERE seller_order_id IS NOT NULL;
CREATE UNIQUE INDEX threads_user_shop_product ON threads(user_id, shop_id, coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE seller_order_id IS NULL AND user_id IS NOT NULL;
CREATE INDEX threads_seller ON threads(seller_id, last_message_at DESC); CREATE INDEX threads_user ON threads(user_id, last_message_at DESC);
CREATE TABLE messages (id bigserial PRIMARY KEY, thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE, sender text NOT NULL CHECK (sender IN ('buyer','seller')), author_id uuid REFERENCES users(id) ON DELETE SET NULL, body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX messages_thread ON messages(thread_id, id);
