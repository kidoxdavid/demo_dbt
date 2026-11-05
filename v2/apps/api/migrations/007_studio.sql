-- Seller Studio: shop page views (for "Shop visits") and whether the seller has chosen a look (a setup checklist step).
CREATE TABLE shop_views (shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE, day date NOT NULL, views int NOT NULL DEFAULT 0, PRIMARY KEY (shop_id, day));
ALTER TABLE shops ADD COLUMN look_chosen boolean NOT NULL DEFAULT false;
