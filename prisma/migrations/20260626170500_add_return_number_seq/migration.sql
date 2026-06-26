-- Return-number sequence
-- ----------------------------------------------------------------------------
-- Mirrors order_number_seq / quotation_number_seq: a gap-free, concurrency-safe
-- counter for human return numbers (RET-YYYY-NNNNN), independent of row counts
-- and RLS context.
DO $$
DECLARE next_start bigint;
BEGIN
  SELECT COALESCE(COUNT(*), 0) + 1 INTO next_start FROM "OrderReturn";
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS return_number_seq START WITH %s', next_start);
END $$;
