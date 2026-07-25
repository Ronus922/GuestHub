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
//
// CONCURRENCY (B5.1, NIGHT_AUDIT §3): the derivation above is only correct while
// ONE transaction at a time moves money for a reservation. Under READ COMMITTED
// the aggregate below is evaluated from the STATEMENT SNAPSHOT: when a second
// writer blocks on the reservation row, PostgreSQL re-checks the target row of
// the UPDATE but does NOT re-evaluate the `FROM (SELECT SUM …)` subquery, so the
// first writer's freshly committed payment is silently dropped from the cache
// (proven on staging: ledger 220, paid_amount 170). Every money-moving write
// therefore takes the reservation row lock FIRST, in its own statement — the
// next statement then gets a fresh snapshot that includes whatever the previous
// holder committed. This is also what makes the over-refund guard in
// mutations.ts sound (see recordRefund).
// ============================================================

// The single payment-row status that represents captured funds.
export const COLLECTED_PAYMENT_STATUS = "paid";

/**
 * Serialize money-moving writes PER RESERVATION (B5.1). Must run BEFORE the
 * ledger read that a write decision rests on, so that read is never stale, and
 * before the aggregate recompute, so a concurrent payment is never lost from
 * paid_amount. Locking the reservation row (not the payments rows) keeps the
 * order reservation → payments everywhere and leaves unrelated reservations
 * fully parallel.
 *
 * FOR NO KEY UPDATE, deliberately, NOT `FOR UPDATE`: inserting a payment row
 * takes a FOR KEY SHARE lock on this same reservation row (the payments →
 * reservations foreign key). `FOR UPDATE` conflicts with KEY SHARE, so two
 * transactions that each insert a payment and then lock would deadlock — the
 * concurrency guard reproduces exactly that ("deadlock detected") when the
 * strength is raised. NO KEY UPDATE conflicts with itself (money writers are
 * still mutually excluded) and with plain UPDATEs of the reservation, but not
 * with the foreign key's KEY SHARE.
 */
export async function lockReservationForPaymentWrite(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
): Promise<void> {
  await tx`
    SELECT id FROM guesthub.reservations
     WHERE id = ${reservationId} AND tenant_id = ${tenantId}
     FOR NO KEY UPDATE`;
}

export async function recomputePaymentAggregates(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
): Promise<{ paid: number; balance: number; total: number }> {
  // hold the row before summing: without this the sum below is read from a stale
  // snapshot and a concurrently committed payment is lost from paid_amount.
  await lockReservationForPaymentWrite(tx, tenantId, reservationId);
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
