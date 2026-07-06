import "server-only";
import type { TransactionSql } from "postgres";

// ============================================================
// Payment ledger derivation (D51/D52). guesthub.payments is the authoritative
// ledger; reservations.paid_amount / balance are derived CACHES of it —
// recomputed here inside the caller's transaction after every write that can
// move them (payment insert, total_price change). This replaces the four
// divergent incremental formulas that let paid_amount drift from the ledger.
//
// CANONICAL collected-money rule (D52 §6): a payment row counts toward the paid
// amount ONLY when status = 'paid' (captured funds). Every other lifecycle
// status — 'failed', 'voided', 'refunded', 'pending' — is excluded, so a failed
// or voided payment can never inflate paid_amount. (Migration 019 relabelled
// legacy seed rows that misused 'partial' as a real captured payment → 'paid';
// 'partial' is a RESERVATION state, never a payment-row status.)
//
// balance = total_price − paid, NOT floored: a negative balance is an honest
// overpayment (customer credit) — the reservation payment STATE derives via
// paymentState() and the credit is surfaced via formatBalance() (inventory-rules).
// ============================================================

// The single payment-row status that represents captured funds.
export const COLLECTED_PAYMENT_STATUS = "paid";

export async function recomputePaymentAggregates(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
): Promise<{ paid: number; balance: number; total: number }> {
  const [row] = await tx<{ paid: number; balance: number; total: number }[]>`
    UPDATE guesthub.reservations res SET
      paid_amount = x.paid,
      balance = res.total_price - x.paid
    FROM (
      SELECT COALESCE(SUM(amount) FILTER (WHERE status = ${COLLECTED_PAYMENT_STATUS}), 0) AS paid
      FROM guesthub.payments
      WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId}
    ) x
    WHERE res.id = ${reservationId} AND res.tenant_id = ${tenantId}
    RETURNING x.paid::float8 AS paid, res.balance::float8 AS balance, res.total_price::float8 AS total`;
  if (!row) throw new Error("reservation not found for payment recompute");
  return row;
}
