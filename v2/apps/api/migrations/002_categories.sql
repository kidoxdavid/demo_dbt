-- Categories (a tree) and typed attribute definitions per category. Attributes drive seller forms AND buyer filters.
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  parent_id uuid REFERENCES categories(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  tile_name text,                                   -- short friendly name for the seller sign-up tiles
  art_kind text, art_tone text,                     -- illustrated placeholder (see design system)
  seller_tips text, photo_guide text,               -- shown to sellers when they list in this category
  allows_custom_attributes boolean NOT NULL DEFAULT false,   -- the "Other" category: free-form attributes
  restricted boolean NOT NULL DEFAULT false,        -- listing needs extra acknowledgements and review
  sort int NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_parent ON categories(parent_id);

CREATE TABLE attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  type text NOT NULL CHECK (type IN ('text','number','select','multiselect','color','boolean')),
  unit text,                                        -- for numbers: ml, cm, in, g, h
  options jsonb,                                    -- for select and multiselect: [{"value":"...","label":"..."}]
  required boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT false,
  help text,                                        -- one plain sentence, shown behind an "i"
  sort int NOT NULL DEFAULT 100,
  UNIQUE (category_id, key),
  CHECK ((type IN ('select','multiselect')) = (options IS NOT NULL))
);
