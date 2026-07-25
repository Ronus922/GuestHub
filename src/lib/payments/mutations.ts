import "server-only";
import type { TransactionSql } from "postgres";
import { lockReservationForPaymentWrite, recomputePaymentAggregates } from "./ledger";

// ============================================================
// Canonical payment ledger MUTATIONS (Stage 3, H7/M6). guesthub.payments is the
// authoritative ledger (see ledger.ts). These helpers are the ONLY sanctioned
// way to void or refund captured money, so paid_amount/balance always stay a
// faithful derivation of the ledger.
//
// Model (keeps the single aggregate formula paid = SUM(amount) FILTER status='paid'):
//   * VOID  — a mistaken capture is flipped to status='voided' (excluded from the
//     sum). Idempotent: voiding an already-voided row is a no-op.
//   * REFUND — money returned is recorded as a NEGATIVE contra 'paid' row, so the
//     net captured amount drops by the refund. Refunds can never drive net
//     captured below zero (you cannot refund more than was collected).
//
// No real PSP is integrated: like the external-payment recorder (D46), these
// record money movements that happened OUTSIDE GuestHub; they never fake a
// provider charge/refund. All callers pass an existing transaction so the ledger
// write and the aggregate recompute commit atomically.
//
// ATOMIC IS NOT ENOUGH (B5.1, NIGHT_AUDIT §3). Both helpers READ the ledger and
// then WRITE it, so they must also be SERIALIZED per reservation: two concurrent
// ₪60 refunds against a ₪100 capture each read "net captured = 100", each pass
// the over-refund guard, and the ledger commits at −20 (proven on staging).
// lockReservationForPaymentWrite() takes the reservation row FIRST, before any
// ledger read, so the read that the decision rests on is never stale.
// ============================================================

/** Void a captured payment (mistaken entry). Idempotent. Returns false if already voided/absent. */
export async function voidPayment(
  tx: TransactionSql,
  tenantId: string,
  paymentId: string,
): Promise<boolean> {
  // the reservation this payment belongs to, locked before the flip so a
  // concurrent refund/capture cannot interleave between the flip and the recompute
  const [target] = await tx<{ reservation_id: string }[]>`
    SELECT reservation_id FROM guesthub.payments
     WHERE id = ${paymentId} AND tenant_id = ${tenantId}`;
  if (!target) return false; // absent — no-op
  await lockReservationForPaymentWrite(tx, tenantId, target.reservation_id);

  const [row] = await tx<{ reservation_id: string }[]>`
    UPDATE guesthub.payments
       SET status = 'voided'
     WHERE id = ${paymentId} AND tenant_id = ${tenantId} AND status = 'paid'
    RETURNING reservation_id`;
  if (!row) return false; // not in a voidable state — no-op
  await recomputePaymentAggregates(tx, tenantId, row.reservation_id);
  return true;
}

/**
 * Record a refund (money returned outside GuestHub) as a negative contra 'paid'
 * row. `amount` is the POSITIVE refund magnitude. Fails closed if it would drive
 * net captured below zero. `idempotencyKey` (e.g. the provider refund reference)
 * makes a retried refund a no-op via the unique (tenant_id, idempotency_key) index.
 */
export async function recordRefund(
  tx: TransactionSql,
  args: {
    tenantId: string;
    reservationId: string;
    amount: number;
    method?: string | null;
    reference?: string | null;
    notes?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<{ refunded: number; paid: number; balance: number } | null> {
  const amount = Math.round(Number(args.amount) * 100) / 100;
  if (!(amount > 0)) throw new Error("refund amount must be positive");

  // serialize with every other money-moving write for THIS reservation before
  // reading the balance the refund decision rests on (B5.1)
  await lockReservationForPaymentWrite(tx, args.tenantId, args.reservationId);

  // net captured so far (paid contra entries already netted)
  const [{ paid: netPaid }] = await tx<{ paid: number }[]>`
    SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::float8 AS paid
    FROM guesthub.payments
    WHERE reservation_id = ${args.reservationId} AND tenant_id = ${args.tenantId}`;
  if (amount > netPaid + 1e-9) {
    throw new Error(`refund ${amount} exceeds net captured ${netPaid}`);
  }

  // idempotent: a retry with the same key inserts nothing
  const inserted = await tx`
    INSERT INTO guesthub.payments
      (tenant_id, reservation_id, amount, method, status, paid_at, reference, notes, idempotency_key)
    VALUES (${args.tenantId}, ${args.reservationId}, ${-amount}, ${args.method ?? null},
            'paid', now(), ${args.reference ?? null}, ${args.notes ?? null}, ${args.idempotencyKey ?? null})
    ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) return null; // duplicate refund suppressed

  const agg = await recomputePaymentAggregates(tx, args.tenantId, args.reservationId);
  return { refunded: amount, paid: agg.paid, balance: agg.balance };
}
