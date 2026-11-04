-- A payment can succeed after its reservation expired and stock is gone: flag for refund, never lose the money record.
ALTER TABLE payments ADD COLUMN needs_refund boolean NOT NULL DEFAULT false;
