ALTER TABLE plans ADD COLUMN sort_order int NOT NULL DEFAULT 100;
UPDATE plans SET sort_order = CASE code WHEN 'starter' THEN 10 WHEN 'growth' THEN 20 WHEN 'professional' THEN 30 WHEN 'enterprise' THEN 40 ELSE 100 END;
