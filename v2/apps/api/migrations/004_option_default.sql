-- Which option value is pre-selected on the product page (for example Medium).
ALTER TABLE product_option_values ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX product_option_values_one_default ON product_option_values(option_id) WHERE is_default;
