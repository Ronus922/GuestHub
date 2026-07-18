# Payment Architecture

**Date:** 2026-07-18 · **Stage:** 3 · **Sources of truth:** `src/lib/payments/{ledger,mutations,gateway,collection}.ts`, migrations 008/009/010/018/019/030

## Ledger is authoritative

`guesthub.payments` is the canonical payment ledger. `reservations.paid_amount` and `reservations.balance` are **derived caches**, recomputed inside the caller's transaction by the single formula in `recomputePaymentAggregates` (`src/lib/payments/ledger.ts`) after every write that can move them:

```
paid_amount = SUM(payments.amount) FILTER (WHERE status = 'paid')     -- captured funds only
balance     = reservations.total_price - paid_amount                  -- UNFLOORED (negative = customer credit)
```

Only `status='paid'` counts as captured. `pending`/`failed`/`voided`/`refunded` are excluded, so a failed or voided payment can never inflate `paid_amount`. Reservation payment STATE (`unpaid`/`partial`/`paid`/`overpaid`) derives from `paymentState()` and the credit-aware `balanceOf()`/`formatBalance()` in `src/lib/inventory-rules.ts` — the UI formats money but never recomputes it.

Guarded by `check:payment-ledger-integrity` (paid==SUM captured, balance==total−paid, canonical statuses, no orphans, idempotency unique).

## Mutations (Stage 3, H7/M6)

All money movements go through canonical helpers so the caches stay faithful:

| Operation | Helper | Model |
|---|---|---|
| Capture | inline inserts + `recomputePaymentAggregates` (reservation create/edit); external recorder `recordExternalPayment` | `status='paid'` row |
| Refund | `recordRefund` (`mutations.ts`) | negative contra `'paid'` row; nets down captured; over-refund **fails closed**; `idempotency_key` suppresses duplicates |
| Void | `voidPayment` (`mutations.ts`) | flip `'paid'→'voided'` (excluded from sum); idempotent |

Server actions: `refundPaymentAction` / `voidPaymentAction` (`reservations/card-actions.ts`), permission `payments.refund`, audited, emit `reservation.payment_changed`. Proven by `check:payment-refund-void` (capture/refund/dup-suppress/over-refund-blocked/void netting).

**Idempotency (M6):** `payments.idempotency_key` with unique `(tenant_id, idempotency_key)`. The external recorder derives it from the transaction reference (`ext:<reference>`); refunds use `refund:<reference>`. A double-submit with the same reference is suppressed, not double-counted.

## Gateway seam

`src/lib/payments/gateway.ts` is a provider-neutral seam. **No PSP is integrated** — there is no fake charge. Payment success requires real provider evidence; today captures and refunds are recorded as money movements that happened **outside** GuestHub (the external-recorder pattern, D46). The tokenization/PCI boundary and the provider-neutral payment-method reference model are in `TOKENIZATION_AND_PCI_BOUNDARIES.md`.

## Currency

Amounts are `numeric(12,2)` (exact, never float — enforced by `check:timezone-and-money-invariants`). Single-currency per tenant today; multi-currency (payments rows carrying their own currency; OTA foreign-currency conversion guard) is a documented gap (audit PAY H-6, M9) targeted at a later stage.

## Israel-market note

VAT is inclusive/per-tenant; tourist zero-rating and חשבונית מס/קבלה issuance are **not** implemented — a clean external-invoicing seam is the intended direction (Stage 5, defect H15). No accounting system is built here.
