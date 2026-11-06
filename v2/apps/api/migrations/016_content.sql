-- Wording the admin can change without code: extra lines on emails, and plain pages (terms, privacy, returns, ...).
CREATE TABLE email_overrides (
  template text PRIMARY KEY, subject text CHECK (subject IS NULL OR length(subject) <= 150), intro text NOT NULL DEFAULT '' CHECK (length(intro) <= 600), closing text NOT NULL DEFAULT '' CHECK (length(closing) <= 600),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cms_pages (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9-]{2,40}$'), title text NOT NULL CHECK (length(title) BETWEEN 1 AND 100), body text NOT NULL DEFAULT '' CHECK (length(body) <= 60000),
  published boolean NOT NULL DEFAULT false, updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
