-- Transactional email outbox, one-time email tokens (verify / reset), and TOTP two-factor login.
CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  to_email citext NOT NULL,
  template text NOT NULL,
  subject text NOT NULL,
  text_body text NOT NULL,
  html_body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','simulated','failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_due ON email_outbox(next_attempt_at) WHERE status = 'pending';
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_rw ON email_outbox USING (tenant_id = app_tenant() OR app_is_platform())
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_tenant() OR app_is_platform());

CREATE TABLE email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verify','reset')),
  token_hash text NOT NULL UNIQUE,         -- only a hash of the emailed token is stored
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_tokens(user_id, kind);

ALTER TABLE users ADD COLUMN mfa_secret_enc text;          -- AES-256-GCM encrypted TOTP secret
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_recovery jsonb NOT NULL DEFAULT '[]';   -- sha256 hashes of unused recovery codes
ALTER TABLE users ADD COLUMN mfa_last_step bigint NOT NULL DEFAULT 0;    -- blocks re-use of a TOTP code
ALTER TABLE sessions ADD COLUMN mfa_at timestamptz;

CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eazy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eazy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs, ledger_entries, inventory_movements, refunds FROM eazy_app;
