-- Phase 1 foundation: identity, tenancy, onboarding, plans, platform RBAC, audit.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,         -- sha256 of the opaque cookie token; raw token never stored
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions(user_id);

-- Platform (EazyStores staff) RBAC. Data-driven so admins change roles without code.
CREATE TABLE platform_roles (key text PRIMARY KEY, label text NOT NULL);
CREATE TABLE platform_role_permissions (
  role_key text NOT NULL REFERENCES platform_roles(key) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (role_key, permission)
);
CREATE TABLE platform_staff (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_key text NOT NULL REFERENCES platform_roles(key)
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  price_monthly_cents int NOT NULL DEFAULT 0 CHECK (price_monthly_cents >= 0),
  price_annual_cents int NOT NULL DEFAULT 0 CHECK (price_annual_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'CAD',
  limits jsonb NOT NULL DEFAULT '{}',
  features jsonb NOT NULL DEFAULT '{}',
  transaction_fee_bps int NOT NULL DEFAULT 0 CHECK (transaction_fee_bps BETWEEN 0 AND 10000),
  trial_days int NOT NULL DEFAULT 0,
  is_public boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  suspended_reason text,
  plan_id uuid NOT NULL REFERENCES plans(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','manager','staff','support')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX ON memberships(user_id);

CREATE TABLE businesses (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_type text NOT NULL DEFAULT 'individual'
    CHECK (legal_type IN ('individual','sole_proprietorship','registered_business','partnership','creator')),
  business_name text NOT NULL,
  description text,
  category text,
  contact_email citext,
  contact_phone text,
  city text, region text, country char(2) NOT NULL DEFAULT 'CA',
  registration_number text,
  currency char(3) NOT NULL DEFAULT 'CAD',
  fulfilment jsonb NOT NULL DEFAULT '{"pickup":false,"delivery":false,"shipping":false}',
  social jsonb NOT NULL DEFAULT '{}',
  onboarding_step text NOT NULL DEFAULT 'business',
  onboarding_completed_at timestamptz,
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text NOT NULL,
  tagline text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','suspended')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stores(tenant_id);

CREATE TABLE reserved_slugs (slug citext PRIMARY KEY);
INSERT INTO reserved_slugs VALUES ('admin'),('api'),('www'),('store'),('stores'),('help'),('support'),('login'),('signup'),('eazyfoods'),('eazystores'),('app'),('static');

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  tenant_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  ip inet
);
CREATE INDEX ON audit_logs(tenant_id, at DESC);
CREATE INDEX ON audit_logs(entity_type, entity_id);
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

CREATE TABLE platform_settings (
  key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Row-level security: tenant isolation enforced in the database ----------
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.platform_admin', true), '') = 'on' $$;
CREATE FUNCTION app_signup() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.signup', true), '') = 'on' $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_rw ON tenants USING (id = app_tenant() OR app_is_platform())
  WITH CHECK (id = app_tenant() OR app_is_platform() OR app_signup());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_rw ON memberships
  USING (tenant_id = app_tenant() OR user_id = app_user() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant() OR app_is_platform() OR app_signup());

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY; ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY businesses_rw ON businesses USING (tenant_id = app_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant() OR app_is_platform() OR app_signup());

ALTER TABLE stores ENABLE ROW LEVEL SECURITY; ALTER TABLE stores FORCE ROW LEVEL SECURITY;
CREATE POLICY stores_rw ON stores USING (tenant_id = app_tenant() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant() OR app_is_platform() OR app_signup());
CREATE POLICY stores_public ON stores FOR SELECT USING (status = 'published');

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_logs FOR SELECT USING (tenant_id = app_tenant() OR app_is_platform());
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (true);

INSERT INTO platform_roles VALUES ('super_admin','Super admin'),('support','Support'),('finance','Finance'),('moderator','Moderator');
INSERT INTO platform_role_permissions VALUES
 ('super_admin','sellers.read'),('super_admin','sellers.suspend'),('super_admin','plans.write'),('super_admin','audit.read'),('super_admin','staff.manage'),('super_admin','settings.write'),
 ('support','sellers.read'),('support','audit.read'),
 ('finance','sellers.read'),('finance','plans.write'),('finance','audit.read'),
 ('moderator','sellers.read'),('moderator','sellers.suspend');
-- Placeholder commercial values; admin-editable. See docs.
INSERT INTO plans (code,name,price_monthly_cents,price_annual_cents,limits,features,transaction_fee_bps,trial_days) VALUES
 ('starter','Starter',0,0,'{"active_products":50,"staff":1}','{"custom_domain":false,"pos":false}',300,0),
 ('growth','Growth',2900,29000,'{"active_products":1000,"staff":3}','{"custom_domain":false,"pos":false}',200,14),
 ('professional','Professional',7900,79000,'{"active_products":20000,"staff":10}','{"custom_domain":true,"pos":true}',150,14),
 ('enterprise','Enterprise',0,0,'{"active_products":null,"staff":null}','{"custom_domain":true,"pos":true}',100,0);

GRANT USAGE ON SCHEMA public TO eazy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM eazy_app;
