-- What each role may do and which windows it may sign in to, as chosen by the admin. A role with no row here uses the built-in defaults.
-- The admin role itself is never stored: it always has every permission and every console, so the platform cannot be locked out.
CREATE TABLE role_config (
  role text PRIMARY KEY CHECK (role IN ('support','finance','catalogue','marketing','seller_manager','seller_staff')),
  permissions text[] NOT NULL DEFAULT '{}', areas text[] NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
