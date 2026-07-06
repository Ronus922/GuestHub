-- ============================================================
--  GuestHub · D52 — Payment-ledger reconciliation + canonical payment-row status.
--
--  The payments ledger is authoritative (D51): reservations.paid_amount / balance
--  are derived CACHES recomputed from SUM(amount) FILTER (WHERE status='paid').
--
--  BUG this fixes: legacy seed rows misused the RESERVATION-level state 'partial'
--  as a PAYMENT-ROW status for real captured partial payments. Those rows were
--  therefore EXCLUDED from the ledger sum, so the stored paid_amount already
--  disagreed with the ledger and the next payment/edit on such a reservation
--  would have silently wiped the collected amount from paid_amount.
--
--  Canonical model (D52 §6):
--    * A PAYMENT ROW status is its own lifecycle: 'paid' (captured), 'pending',
--      'failed', 'voided', 'refunded'. Only 'paid' counts toward paid_amount.
--    * 'partial' / 'overpaid' etc. are RESERVATION states, DERIVED from the
--      ledger (paymentState / formatBalance) — never a payment-row status.
--
--  This migration:
--    1. Relabels every payment row status='partial' → 'paid' (they ARE captured
--       funds). NO amount changes — money is untouched, only the wrong label.
--    2. Adds a CHECK constraint pinning payment-row status to the canonical set.
--    3. Recomputes paid_amount/balance for ALL reservations from the ledger, so
--       every stored cache equals the authoritative sum (balance NOT floored).
--  Idempotent: safe to re-run. Prints COUNTS only, never any monetary value tied
--  to a guest.
--
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/019_payment_status_ledger_reconcile.sql
--
--  ROLLBACK (not recommended — reintroduces the ledger divergence):
--    ALTER TABLE guesthub.payments DROP CONSTRAINT IF EXISTS payments_status_check;
-- ============================================================

SET search_path TO "guesthub", public;

DO $$
DECLARE
  relabelled bigint := 0;
BEGIN
  SELECT count(*) INTO relabelled FROM payments WHERE status = 'partial';
  RAISE NOTICE 'D52 payment reconcile — payment rows relabelled partial->paid: %', relabelled;
END $$;

-- 1. captured partial payments are real 'paid' rows (amounts unchanged)
UPDATE payments SET status = 'paid', updated_at = now()
WHERE status = 'partial';

-- 2. pin the payment-row status to the canonical lifecycle set
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('paid','pending','failed','voided','refunded'));

-- 3. rebuild paid_amount/balance from the authoritative ledger for EVERY
--    reservation (same formula as recomputePaymentAggregates; balance NOT floored)
WITH ledger AS (
  SELECT r.id AS reservation_id,
         COALESCE((SELECT SUM(p.amount) FROM payments p
                   WHERE p.reservation_id = r.id AND p.status = 'paid'), 0) AS paid
  FROM reservations r
)
UPDATE reservations res SET
  paid_amount = l.paid,
  balance     = res.total_price - l.paid
FROM ledger l
WHERE res.id = l.reservation_id
  AND (res.paid_amount <> l.paid OR res.balance <> res.total_price - l.paid);

DO $$
DECLARE
  drift bigint := 0;
BEGIN
  SELECT count(*) INTO drift
  FROM reservations r
  WHERE r.paid_amount <> COALESCE(
    (SELECT SUM(p.amount) FROM payments p WHERE p.reservation_id = r.id AND p.status='paid'), 0);
  RAISE NOTICE 'D52 payment reconcile — reservations still diverging from ledger (must be 0): %', drift;
END $$;
