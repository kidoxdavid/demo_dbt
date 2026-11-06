-- A promotion a maker runs on their own store page: a headline, a few words, and one of their pieces to feature.
-- It shows at the top of that store page for visitors while it is live. Staff approve it first when the setting says so.
CREATE TABLE store_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  headline text NOT NULL CHECK (length(headline) BETWEEN 1 AND 60),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 200),
  cta_label text NOT NULL DEFAULT 'Shop now' CHECK (length(cta_label) BETWEEN 1 AND 24),
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  starts_on date NOT NULL DEFAULT current_date,
  ends_on date CHECK (ends_on IS NULL OR ends_on >= starts_on),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','live','paused','rejected','ended')),
  reject_reason text,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- One running promotion per shop (a maker edits it, or ends it and starts another).
CREATE UNIQUE INDEX store_promotions_one_open ON store_promotions(shop_id) WHERE status IN ('pending','live','paused','rejected');
CREATE INDEX store_promotions_status ON store_promotions(status, created_at DESC);
CREATE TABLE store_promotion_stats (promotion_id uuid NOT NULL REFERENCES store_promotions(id) ON DELETE CASCADE, day date NOT NULL, views int NOT NULL DEFAULT 0, clicks int NOT NULL DEFAULT 0, PRIMARY KEY (promotion_id, day));
