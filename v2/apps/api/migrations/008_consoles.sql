-- Staff consoles: internal notes (support), seller payouts (finance).
CREATE TABLE support_notes (id bigserial PRIMARY KEY, entity_type text NOT NULL CHECK (entity_type IN ('order','user','seller')), entity_id uuid NOT NULL, body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000), author_id uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX support_notes_entity ON support_notes(entity_type, entity_id, created_at DESC);
-- A payout is money sent to a seller by bank transfer (outside the app). Recording it posts a balanced ledger entry (cash out, seller payable down) in the same transaction.
CREATE TABLE payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES sellers(id), amount_cents int NOT NULL CHECK (amount_cents > 0), reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 120), note text, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX payouts_seller ON payouts(seller_id, created_at DESC);
