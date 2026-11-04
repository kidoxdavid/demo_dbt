-- Trust and governance: store review, verification requests, product moderation, terms acceptance, privacy erasure.
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'stores'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE stores DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'products'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE stores ADD CONSTRAINT stores_status_check CHECK (status IN ('draft','pending_review','published','suspended'));
ALTER TABLE stores ADD COLUMN review_note text;
ALTER TABLE stores ADD COLUMN submitted_at timestamptz;
ALTER TABLE stores ADD COLUMN reviewed_at timestamptz;

ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('draft','active','archived','removed'));
ALTER TABLE products ADD COLUMN moderation_reason text;
ALTER TABLE products ADD COLUMN moderated_at timestamptz;

ALTER TABLE users ADD COLUMN terms_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN terms_version text;

ALTER TABLE businesses ADD COLUMN verification_note text;
ALTER TABLE businesses ADD COLUMN verification_requested_at timestamptz;
ALTER TABLE businesses ADD COLUMN verification_reviewed_at timestamptz;
ALTER TABLE businesses ADD COLUMN verification_decision_reason text;

ALTER TABLE orders ADD COLUMN anonymised_at timestamptz;

INSERT INTO platform_role_permissions(role_key, permission) VALUES
  ('super_admin','reviews.write'), ('moderator','reviews.write'),
  ('super_admin','privacy.write');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
