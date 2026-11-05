-- Identity, sessions, roles, audit, settings, feature flags. Forward-only: never edit an applied migration, add a new one.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  phone text,
  password_hash text NOT NULL,
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  email_verified_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One independent sign-in per window (area). The raw token lives only in the cookie; we store its hash.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  area text NOT NULL CHECK (area IN ('shop','studio','admin','support','finance','marketing')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Staff roles are platform-wide (seller_id NULL). Seller roles are scoped to one seller. The sellers table arrives with the catalogue phase,
-- which adds the foreign key. A grant is unique per (user, role, seller).
CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','support','finance','catalogue','marketing','seller_owner','seller_manager','seller_staff')),
  seller_id uuid,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role LIKE 'seller_%') = (seller_id IS NOT NULL))
);
CREATE UNIQUE INDEX user_roles_unique ON user_roles(user_id, role, coalesce(seller_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid, area text, action text NOT NULL, entity_type text NOT NULL, entity_id text,
  prev jsonb, next jsonb, reason text, ip text
);
CREATE INDEX audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX audit_at ON audit_log(at DESC);
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

-- Settings: value validated by a zod schema in code (src/settings.ts); a missing row means "use the default".
CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now());
-- Feature flags: a missing row means ON.
CREATE TABLE feature_flags (key text PRIMARY KEY, enabled boolean NOT NULL, note text, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now());
