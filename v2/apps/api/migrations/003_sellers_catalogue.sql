-- Sellers, shops, media, products, variants, attributes, tags and verified synonyms.
CREATE TABLE sellers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 160),
  business_type text NOT NULL DEFAULT 'individual' CHECK (business_type IN ('individual','sole_proprietor','company','nonprofit')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  verification_tier text NOT NULL DEFAULT 'basic' CHECK (verification_tier IN ('basic','payout_verified','verified_maker')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_roles ADD CONSTRAINT user_roles_seller_fk FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE;

-- Seller sign-up asks "what do you sell?": remember the answer to pre-fill forms, tips and policy templates.
CREATE TABLE seller_categories (seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE, category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE, PRIMARY KEY (seller_id, category_id));

-- Uploaded images and videos. Validated by magic bytes, optimised, kept on disk AND in the database (bytea), served with Range support.
CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image','video')),
  original_name text, bytes int NOT NULL, width int, height int, duration_s numeric(8,2),
  blur text,                                         -- tiny data-URI placeholder for blur-up loading
  created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_files (
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE, label text NOT NULL,   -- w320 w640 w1280 | video poster
  mime text NOT NULL, bytes int NOT NULL, data bytea NOT NULL, PRIMARY KEY (media_id, label)
);

CREATE TABLE shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL UNIQUE REFERENCES sellers(id) ON DELETE CASCADE,
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 50),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80), tagline text CHECK (length(tagline) <= 140), story text CHECK (length(story) <= 4000),
  city text, region text,
  logo_media_id uuid REFERENCES media(id) ON DELETE SET NULL, banner_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  look text NOT NULL DEFAULT 'atelier' CHECK (look IN ('atelier','noir','sage','blush','sky')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused')),
  vacation_mode boolean NOT NULL DEFAULT false,
  processing_days_min int NOT NULL DEFAULT 2 CHECK (processing_days_min BETWEEN 0 AND 60), processing_days_max int NOT NULL DEFAULT 3 CHECK (processing_days_max >= processing_days_min AND processing_days_max <= 60),
  policies jsonb NOT NULL DEFAULT '{}',
  badges text[] NOT NULL DEFAULT '{}',               -- handmade, made_in_canada, small_batch (verified maker comes from the seller's tier)
  rating_avg numeric(2,1), rating_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE, seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 140), description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  category_id uuid REFERENCES categories(id),
  condition text NOT NULL DEFAULT 'new' CHECK (condition IN ('new','used','vintage')),
  handmade boolean NOT NULL DEFAULT false, made_in text, tax_class text NOT NULL DEFAULT 'standard' CHECK (tax_class IN ('standard','exempt')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','hidden')),
  moderation_status text NOT NULL DEFAULT 'approved' CHECK (moderation_status IN ('approved','queued','removed')),
  one_of_a_kind boolean NOT NULL DEFAULT false, made_to_order boolean NOT NULL DEFAULT false,
  lead_time_days int CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 1 AND 120), weekly_capacity int CHECK (weekly_capacity IS NULL OR weekly_capacity >= 1),
  personalisation jsonb NOT NULL DEFAULT '[]', dangerous_goods boolean NOT NULL DEFAULT false,
  chip_override text CHECK (length(chip_override) <= 24),           -- e.g. "Limited"
  art_kind text, art_tone text,                                      -- illustrated placeholder when there is no photo (demo seed, empty states)
  tags text[] NOT NULL DEFAULT '{}', sales_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  CHECK (NOT (one_of_a_kind AND made_to_order))
);
CREATE INDEX products_shop ON products(shop_id, status);
CREATE INDEX products_category ON products(category_id);
CREATE INDEX products_title_trgm ON products USING gin (title gin_trgm_ops);
CREATE INDEX products_tags ON products USING gin (tags);
CREATE INDEX products_listing ON products(created_at DESC) WHERE status = 'published';

-- A product belongs to its primary category AND any others it legitimately fits (a hand-built planter is pottery and a planter).
CREATE TABLE product_categories (product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE, PRIMARY KEY (product_id, category_id));
CREATE INDEX product_categories_cat ON product_categories(category_id);

CREATE TABLE product_options (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, position int NOT NULL CHECK (position BETWEEN 0 AND 2), name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40), UNIQUE (product_id, position), UNIQUE (product_id, name));
CREATE TABLE product_option_values (option_id uuid NOT NULL REFERENCES product_options(id) ON DELETE CASCADE, position int NOT NULL, value text NOT NULL CHECK (length(value) BETWEEN 1 AND 60), swatch text CHECK (swatch IS NULL OR swatch ~ '^#[0-9a-fA-F]{6}$'), PRIMARY KEY (option_id, value));

CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, position int NOT NULL DEFAULT 0,
  sku text CHECK (length(sku) <= 60), options jsonb NOT NULL DEFAULT '{}',
  price_cents int NOT NULL CHECK (price_cents >= 0 AND price_cents <= 100000000), compare_at_cents int CHECK (compare_at_cents IS NULL OR compare_at_cents > price_cents),
  tracks_stock boolean NOT NULL DEFAULT true,                       -- made-to-order variants do not track stock
  stock_on_hand int NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0), stock_reserved int NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0),
  image_media_id uuid REFERENCES media(id) ON DELETE SET NULL, weight_g int CHECK (weight_g IS NULL OR weight_g >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  CHECK (stock_reserved <= stock_on_hand), UNIQUE (product_id, options)
);
CREATE INDEX variants_product ON variants(product_id) WHERE status = 'active';

-- One-of-a-kind items can never be oversold: exactly one variant, and never more than one in stock.
CREATE FUNCTION enforce_one_of_a_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ooak boolean;
BEGIN
  SELECT one_of_a_kind INTO ooak FROM products WHERE id = NEW.product_id;
  IF ooak AND NEW.status = 'active' THEN
    IF NEW.stock_on_hand > 1 THEN RAISE EXCEPTION 'one_of_a_kind_stock'; END IF;
    IF (SELECT count(*) FROM variants WHERE product_id = NEW.product_id AND status = 'active' AND id <> NEW.id) > 0 THEN RAISE EXCEPTION 'one_of_a_kind_variants'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER variants_one_of_a_kind BEFORE INSERT OR UPDATE ON variants FOR EACH ROW EXECUTE FUNCTION enforce_one_of_a_kind();

CREATE TABLE product_media (product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE, position int NOT NULL DEFAULT 0, PRIMARY KEY (product_id, media_id));
CREATE TABLE product_attribute_values (product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE, key text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (product_id, key));
CREATE INDEX product_attr_lookup ON product_attribute_values(key, value);

-- Verified synonyms (a human checked each pair). Search expands a term to its related terms, never the other way round on its own.
CREATE TABLE synonyms (term citext PRIMARY KEY, related text[] NOT NULL CHECK (cardinality(related) >= 1));
INSERT INTO synonyms(term, related) VALUES
  ('wig', '{hair piece,hairpiece}'), ('hair piece', '{wig}'), ('hairpiece', '{wig}'), ('extensions', '{hair extensions,weave,bundle}'), ('bundle', '{hair bundle,extensions}'),
  ('mug', '{cup,coffee cup}'), ('cup', '{mug}'), ('vase', '{bud vase,flower vase}'), ('print', '{poster,art print}'), ('poster', '{print}'), ('candle', '{votive,soy candle}'),
  ('necklace', '{pendant,chain}'), ('earrings', '{studs,hoops}'), ('planter', '{plant pot,pot}'), ('plant pot', '{planter}'), ('perfume', '{fragrance,eau de parfum,cologne}'), ('fragrance', '{perfume,scent}'),
  ('3d printed', '{3d print,3d printing}'), ('3d print', '{3d printed}'), ('toy', '{plaything,game}'), ('scarf', '{shawl,wrap}'), ('pottery', '{ceramics,stoneware}'), ('ceramics', '{pottery,stoneware}');
