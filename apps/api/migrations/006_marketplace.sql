-- Store theming + fuzzy search support.
ALTER TABLE stores ADD COLUMN theme jsonb NOT NULL DEFAULT '{}';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);
