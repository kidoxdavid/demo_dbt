-- Configurable sales tax. Rates are DATA (admin-editable, audited), never hard-coded.
-- Rates below are starting values entered by the developer: verify against CRA / provincial sources before relying on them.
CREATE TABLE tax_rates (
  country char(2) NOT NULL,
  region text NOT NULL,
  name text NOT NULL,
  components jsonb NOT NULL,           -- [{"name":"GST","kind":"federal","ppm":50000}] ; ppm = parts per million (5% = 50000)
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country, region)
);
INSERT INTO tax_rates(country, region, name, components) VALUES
 ('CA','AB','Alberta','[{"name":"GST","kind":"federal","ppm":50000}]'),
 ('CA','BC','British Columbia','[{"name":"GST","kind":"federal","ppm":50000},{"name":"PST","kind":"provincial","ppm":70000}]'),
 ('CA','MB','Manitoba','[{"name":"GST","kind":"federal","ppm":50000},{"name":"RST","kind":"provincial","ppm":70000}]'),
 ('CA','NB','New Brunswick','[{"name":"HST","kind":"federal","ppm":150000}]'),
 ('CA','NL','Newfoundland and Labrador','[{"name":"HST","kind":"federal","ppm":150000}]'),
 ('CA','NS','Nova Scotia','[{"name":"HST","kind":"federal","ppm":140000}]'),
 ('CA','NT','Northwest Territories','[{"name":"GST","kind":"federal","ppm":50000}]'),
 ('CA','NU','Nunavut','[{"name":"GST","kind":"federal","ppm":50000}]'),
 ('CA','ON','Ontario','[{"name":"HST","kind":"federal","ppm":130000}]'),
 ('CA','PE','Prince Edward Island','[{"name":"HST","kind":"federal","ppm":150000}]'),
 ('CA','QC','Quebec','[{"name":"GST","kind":"federal","ppm":50000},{"name":"QST","kind":"provincial","ppm":99750}]'),
 ('CA','SK','Saskatchewan','[{"name":"GST","kind":"federal","ppm":50000},{"name":"PST","kind":"provincial","ppm":60000}]'),
 ('CA','YT','Yukon','[{"name":"GST","kind":"federal","ppm":50000}]');
UPDATE tax_rates SET notes = 'Default value entered by the developer. Not verified against official sources.';
GRANT SELECT, INSERT, UPDATE ON tax_rates TO eazy_app;

ALTER TABLE businesses ADD COLUMN tax_federal boolean NOT NULL DEFAULT false;        -- registered for GST/HST
ALTER TABLE businesses ADD COLUMN tax_provincial text[] NOT NULL DEFAULT '{}';       -- provinces where registered for PST/QST/RST
ALTER TABLE businesses ADD COLUMN tax_number text;

ALTER TABLE orders ADD COLUMN tax_cents int NOT NULL DEFAULT 0 CHECK (tax_cents >= 0);
ALTER TABLE orders ADD COLUMN tax_lines jsonb NOT NULL DEFAULT '[]';
ALTER TABLE orders ADD COLUMN tax_region text;
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%total_cents = (subtotal_cents + shipping_cents)%' LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE orders ADD CONSTRAINT orders_total_includes_tax CHECK (total_cents = subtotal_cents + shipping_cents + tax_cents);

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check CHECK (account IN ('cash_received','platform_fee','seller_payable','refunds','tax_payable'));

INSERT INTO platform_role_permissions(role_key, permission) VALUES ('super_admin','tax.write'), ('finance','tax.write');
