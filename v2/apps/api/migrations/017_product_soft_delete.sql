-- A maker can delete any product. When nothing refers to it the row is removed; when it has been ordered it is taken off sale and kept (marked deleted)
-- so every order, receipt and review keeps working.
ALTER TABLE products ADD COLUMN deleted_at timestamptz;
CREATE INDEX products_not_deleted ON products(seller_id, updated_at DESC) WHERE deleted_at IS NULL;
