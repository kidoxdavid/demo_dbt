-- Search and listing speed at scale. products.search_text holds title, tags and the start of the description in one column that a trigram index can serve;
-- a trigger keeps it current. The other indexes cover the listing order, category membership and the cheapest-variant lookup every card needs.
ALTER TABLE products ADD COLUMN search_text text NOT NULL DEFAULT '';
CREATE FUNCTION products_search_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.search_text := coalesce(NEW.title,'') || ' ' || coalesce(array_to_string(NEW.tags,' '),'') || ' ' || left(coalesce(NEW.description,''), 1000); RETURN NEW; END $$;
CREATE TRIGGER products_search_text_trg BEFORE INSERT OR UPDATE OF title, description, tags ON products FOR EACH ROW EXECUTE FUNCTION products_search_text();
UPDATE products SET title = title;
CREATE INDEX products_search_trgm ON products USING gin (search_text gin_trgm_ops);
CREATE INDEX shops_name_trgm ON shops USING gin (name gin_trgm_ops);
DROP INDEX products_listing;          -- replaced by a version that also covers the moderation filter and the tie-breaker
CREATE INDEX products_listing ON products (created_at DESC, id) WHERE status = 'published' AND moderation_status <> 'removed';
CREATE INDEX products_popular ON products (sales_count DESC, created_at DESC) WHERE status = 'published' AND moderation_status <> 'removed';
CREATE INDEX product_categories_by_category ON product_categories (category_id, product_id);
CREATE INDEX variants_cheapest ON variants (product_id, price_cents, position) WHERE status = 'active';
CREATE INDEX product_attribute_values_key ON product_attribute_values (key, product_id);
