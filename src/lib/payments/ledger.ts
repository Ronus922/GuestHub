import "server-only";
import type { TransactionSql } from "postgres";

// ============================================================
// Payment ledger derivation (D51). guesthub.payments is the authoritative
// ledger; reservations.paid_amount / balance are derived CACHES of it —
// recomputed here inside the caller's transaction after every write that can
// move them (payment insert, total_price change). This replaces the four
// divergent incremental formulas that let paid_amount drift from the ledger.
// balance = total_price − paid, NOT floored: a negative balance is an honest
// overpayment (credit) — payment STATUS still derives via paymentState().
// ============================================================

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
      SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid
      FROM guesthub.payments
      WHERE reservation_id = ${reservationId} AND tenant_id = ${tenantId}
    ) x
    WHERE res.id = ${reservationId} AND res.tenant_id = ${tenantId}
    RETURNING x.paid::float8 AS paid, res.balance::float8 AS balance, res.total_price::float8 AS total`;
  if (!row) throw new Error("reservation not found for payment recompute");
  return row;
}
