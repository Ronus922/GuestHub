# GuestHub — Payments & Ledger

- **Status:** Skeleton — Stage 1; completed in **Stage 3**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/PAYMENTS_AUDIT.md`, ADR-0001, `docs/security/THREAT_MODEL.md` (Asset B)

The authoritative money ledger, balance derivation, refund/void, the card-data boundary, the gateway/token seam, and idempotency.

## Current state

`guesthub.payments` is the authoritative ledger (`000_init_schema.sql:286-298` + `idempotency_key` from 030); `reservations.paid_amount`/`balance` are explicitly derived caches recomputed in-transaction by the single `recomputePaymentAggregates` (`src/lib/payments/ledger.ts:26-44`): `paid = SUM(amount) FILTER (status='paid')`, `balance = total_price − paid`, never floored (`PAYMENTS_AUDIT.md` §1). Migration 019 pinned status via CHECK (`paid,pending,failed,voided,refunded`) and rebuilt every cache from the ledger; the snapshot shows zero drift, zero cache mismatch, zero negative/orphan payments (§6, §11, H-12). The card boundary is disciplined: PAN AES-256-GCM in `reservation_cards` (single write/read path, both audited, digits never in audit), **CVV proven absent end-to-end** (018; schema/code/redaction/transient-gateway-contract, H-11). The gateway seam (`payments/gateway.ts`) fails closed — `getPaymentGateway()` returns null, no PSP wired (§3).

Stage-3 gaps: **refunds/voids are unimplemented** — the statuses are constrained and excluded from `paid`, but no code path ever writes them; a mistaken payment or a real refund has no ledger form except manual DB writes (H-1, `WORKFLOW_INVENTORY.md` §7). Payment recording is **not idempotent** — `idempotency_key` + unique index exist but no payment writer populates them, so a double-submit duplicates a payment (H-3). A second divergent aggregate formula on the calendar reschedule path bypasses `recomputePaymentAggregates` (floored inline balance) — the exact drift class D51 removed (H-4). Card-vault retention is unenforced — `available_until` exists but nothing purges expired card data (RS, `PMS_GAP_MATRIX.md` §4). Full reversible PAN storage + browser reveal keeps GuestHub in full PCI scope (H-2); currency, token-model, and Israeli invoicing gaps (H-5, H-6, H-10) are Stage-5 territory.

## Target state (per ADR-0001, Stage 3)

- `guesthub.payments` confirmed as the single balance source; reschedule inline formula removed (ADR-0001, M7/H-4).
- Payment ledger completed: refund/void/correction paths; `idempotency_key` populated by every writer; single balance formula (`TARGET_ARCHITECTURE.md` §3, H-1/H-3).
- Card-vault retention enforcement (purge of expired `available_until` data) — Stage 3 RS.
- Payment-level audit detail on create/update inserts (H-9).
- Provider-neutral token seam retained; PSP selection deferred (V2 §18).

## To be completed in Stage 3

- [ ] Ledger model + balance-derivation diagram (payments → recompute → cache).
- [ ] Refund/void/correction workflow design.
- [ ] Idempotency-key population plan across all payment writers.
- [ ] Reschedule-path unification with `recomputePaymentAggregates`.
- [ ] Card-vault retention/purge design + `check:payment-ledger-integrity` extension.
