# GuestHub — Payments & Financial Integrity Audit (Agent H)

- **Date:** 2026-07-18
- **Branch:** feat/pms-hardening-channex-certification
- **Scope:** payment ledger, state derivation, refunds, gateway seam, card-data boundary (V2 §18), token model, idempotency, reconciliation, currency, VAT, invoice readiness, audit trail
- **Method:** static read of code + migrations; read-only SELECTs against snapshot `guesthub_stage1_restore` (test container, port 5433). No product code, DB, or process was modified.

---

## 1. Ledger model

`guesthub.payments` is the authoritative ledger (`db/migrations/000_init_schema.sql:286-298`): `id, tenant_id, reservation_id, amount numeric(12,2), method text, status, paid_at, reference, notes` (+ `idempotency_key` from migration 030). `reservations.paid_amount` / `balance` are **stored but explicitly derived caches**, never independently authored:

- The single recompute formula lives in `src/lib/payments/ledger.ts:26-44` (`recomputePaymentAggregates`): `paid = SUM(amount) FILTER (WHERE status='paid')`, `balance = total_price − paid`, run **inside the caller's transaction** after every write that can move them.
- Only `status='paid'` counts as collected money (`ledger.ts:24`, `COLLECTED_PAYMENT_STATUS`); `pending/failed/voided/refunded` are excluded, so a failed payment can never inflate `paid_amount`.
- Migration `019_payment_status_ledger_reconcile.sql:50-53` pins payment-row status with a DB CHECK to `('paid','pending','failed','voided','refunded')` and (lines 57-68) rebuilt every cached aggregate from the ledger.
- Balance is **not floored**: a negative balance is an honest overpayment/credit (`ledger.ts:18-20`).

Recompute call sites: reservation create (`src/app/(dashboard)/reservations/actions.ts:289`), reservation update (+additional payment) (`actions.ts:568`), external payment record (`src/app/(dashboard)/reservations/card-actions.ts:366`), channel booking import (`src/lib/channel/booking-import.ts:627`).

**Exception found:** the calendar reschedule/move path recomputes `total_price` and `balance` with a second inline formula — `balance = GREATEST(0, rooms_total - discount + extra) - res.paid_amount` (`actions.ts:882-893`) — instead of calling `recomputePaymentAggregates`. It happens to stay consistent today (it reuses the cached `paid_amount`), but it is exactly the "divergent incremental formula" class D51 eliminated, and it floors the total (`GREATEST(0, …)`) while the canonical path does not floor.

### Reservation payment state

Derived, never stored as a flag: `paymentState(total, paid)` → `unpaid | partial | paid | overpaid` and `balanceOf`/`formatBalance` (due/settled/credit) in `src/lib/inventory-rules.ts:49-76`. `partial`/`overpaid` are reservation states only — migration 019 relabelled legacy rows that misused `partial` as a payment-row status. There is **no** `refunded` reservation state (display mapping only, `src/lib/status-colors.ts:53`).

### Manual / external payments

`recordExternalPaymentAction` (`card-actions.ts:322-392`): explicit staff confirmation required, positive integer amount, `payments.card_charge` permission, inserts a `'paid'` row, recomputes aggregates in-tx, audits `payment_external_record` with amount/method/reference/IP/session, publishes a realtime event. Honest: audited as an *external* record, never as a GuestHub charge. Payment rows are immutable in app code — no update/delete path exists anywhere (good for ledger integrity, but see refunds below).

Cancellation is cancel-never-delete: the reservation keeps rooms/price/**payments**/identity (`actions.ts:689-698`); active OTA reservations refuse local cancel (`actions.ts:675-683`).

---

## 2. Card-data boundary vs V2 §18

### What is stored, encrypted, masked

| Store | Contents | Protection |
|---|---|---|
| `reservation_cards` (`008_phase3_reservation_cards.sql:25-42`) | **Full PAN** as `pan_encrypted` AES-256-GCM ciphertext (`v1.<iv>.<tag>.<data>`), `key_version`, plus masked display fields `brand`, `last4` (CHECK `^[0-9]{4}$`), `exp_month/exp_year`, holder name/ID | Key from env `CARD_VAULT_KEY` (sha-256-derived), never in DB; fresh random 96-bit IV per value; fail-closed when key missing (`src/lib/card-vault.ts:22-33`) |
| `reservation_payment_methods` (`030_workflow_statuses_payment_methods.sql:108-124`) | PSP token reference `provider_ref` + safe display metadata (brand/last4/expiry) | No PAN/CVV columns exist; reference never logged/audited verbatim (`src/lib/channel/payments-admin.ts:24-27, 225-231`) |
| `channel_booking_revisions.card_meta` | Masked channel guarantee (brand/last4/expiry/holder/masked_display/virtual window) — display metadata only, never chargeable (`src/lib/payments/collection.ts:26-38`) | Raw channel payloads redacted before persistence (`src/lib/channel/payloads.ts:20,39`) |

PAN write path is single (`saveReservationCardAction`, `card-actions.ts:104-200`, encrypts before persist, one active card per reservation); PAN read path is single (`revealReservationCardAction`, `card-actions.ts:208-273`, `payments.card_reveal` permission, audited success **and** rejection with IP+session, digits never in audit).

### CVV — proven absent

- Migration `018_remove_stored_cvv.sql:57-61` permanently dropped `reservation_cards.cvv_encrypted` and `channel_booking_revisions.card_cvv_encrypted`.
- Snapshot check: `information_schema.columns WHERE column_name ILIKE '%cvv%'` → **0 columns**.
- Code grep: every remaining `cvv|cvc` hit is a negative guarantee — save action does not accept one (`card-actions.ts:136`), UI has no field (`src/components/reservations/CardFields.tsx:51`), channel ingest discards it (`src/lib/channel/card-ingest.ts:10-11`), payload redaction keys include `cvv|cvc|security_code` (`payloads.ts:20`), vault has no CVV functions (`card-vault.ts:43-47`). The only CVV mention with a runtime shape is the **transient-only** field on `CardChargeRequest` (`src/lib/payments/gateway.ts:17-21`), contractually never persisted. **PASS.**

### Boundary assessment

Storing reversible full PANs — and revealing them to the browser — keeps GuestHub inside full PCI DSS scope (SAQ D territory), regardless of encryption quality. The V2 §18 posture (provider-neutral token references only, PAN never touching GuestHub) is *partially* built (`reservation_payment_methods`) but coexists with the PAN vault rather than replacing it. Additional vault notes: single static key, `key_version` exists but no rotation tooling; key is sha256 of a raw env string (no KDF salt/stretching — acceptable for a high-entropy secret, weak for a passphrase).

---

## 3. Gateway seam

`src/lib/payments/gateway.ts` defines a provider-neutral `PaymentGateway { id; charge(req) }` returning `getPaymentGateway(): null` until a PSP lands — every call site fails closed (`chargeReservationCardAction` returns `NO_GATEWAY_MESSAGE`, audits the attempt with `outcome: no_gateway`, `card-actions.ts:296-311`). Charge permission `payments.card_charge` fails closed (D42).

- **Cardcom/Tranzila-ready:** yes for the *direct-PAN* style — `CardChargeRequest` carries `pan/exp/holder/holderIdNumber/amount/currency/reference`, which matches Israeli PSP terminal APIs.
- **Stripe/token-ready:** no — the seam has **no token-charge method**; `reservation_payment_methods.provider_ref` cannot be charged through `PaymentGateway` as designed (charging a Stripe method requires a `chargeToken(ref, …)`-shaped call, absent). The Channex-Stripe tokenization admin flow (`payments-admin.ts`) creates references but nothing can consume them.

---

## 4. Token model vs V2 §18 provider-neutral reference model — gap analysis

`reservation_payment_methods` (`030:108-124`) vs the V2 §18 target:

| V2 §18 field | Present? | Evidence / gap |
|---|---|---|
| provider | ⚠️ Partial | Column exists but `CHECK (provider IN ('stripe'))` (`030:112`) — Cardcom/Tranzila/other require a migration; not provider-neutral as constrained |
| external **customer** ref | ❌ Missing | Only a method-level `provider_ref` exists; no PSP customer object reference, so no cross-reservation reuse per guest |
| external **method** ref | ✅ | `provider_ref` (`030:113`), never logged/audited verbatim |
| brand / last4 / expiry | ✅ | `030:114-117`, format CHECKs on last4/exp |
| status (active/expired/revoked) | ❌ Missing | No lifecycle column; an expired or PSP-revoked method is indistinguishable from a live one |
| consent (who/when/scope) | ❌ Missing | Only `created_by/created_at`; no guest-consent record for storing/charging |
| scope | ⚠️ Reservation-scoped | `UNIQUE (reservation_id, provider)` — no guest-level wallet; V2 §18 implies a reusable guest payment method |

Tokenization idempotency is good: reuse-before-network + `ON CONFLICT DO NOTHING` race handling (`payments-admin.ts:171-191, 214-233`).

---

## 5. Idempotency of payment recording

Migration 030 §4 added `payments.idempotency_key` with a partial unique index (`030:136-140`) — DB-enforced. **No application code populates it**: grep shows `idempotency_key` writers only in channel jobs and communications outbox, none in payments. Consequently:

- `recordExternalPaymentAction` (`card-actions.ts:355-362`) — plain INSERT, no key: a retry/double-submit records the payment twice.
- Reservation create/update payment inserts (`actions.ts:281-287, 560-566`) — same.

The column is future infrastructure for PSP charges (D77 §F) that today protects nothing.

---

## 6. Reconciliation (migration 019)

One-shot reconcile + permanent guarantees: relabel `partial`→`paid` (amounts untouched), status CHECK, full cache rebuild from ledger, self-verifying drift count printed (must be 0) (`019_payment_status_ledger_reconcile.sql:37-79`). Counts-only notices — no guest amounts printed. There is no *recurring* reconcile job; integrity now rests on all writers using `recomputePaymentAggregates` (see the §1 exception).

---

## 7. Currency

- `payments` has **no currency column** (`000:286-298`) — ledger sums assume the reservation's currency implicitly.
- Back-office reservations hardcode `'ILS'` (`actions.ts:258`); channel import stores the OTA currency (`booking-import.ts:548, 593` — `norm.currency ?? 'ILS'`), so non-ILS reservations are possible.
- The print/PDF document prices everything in the **tenant** currency (`src/lib/pdf/booking-doc-data.ts:150, 213`; `getTenantCurrency` `src/lib/settings.ts:20-24`), ignoring `reservations.currency` — a EUR Booking.com reservation would render with ₪.
- `recordExternalPaymentAction` rounds to whole units (`Math.round`, `card-actions.ts:341`) although columns are `numeric(12,2)` and `balanceOf` keeps agorot (`inventory-rules.ts:62-64`) — an agorot-precision balance can never be settled exactly.
- The gateway request carries ISO-4217 currency (`gateway.ts:13`) — ready, unused.

## 8. VAT interaction

VAT is **display-only** and totals are VAT-inclusive by design: `tenants.settings->vat_rate`, default 18%, changing the rate never recalculates reservations (`src/lib/vat.ts:1-8`); `includedVatAmount` back-computes the included portion, rounded to whole shekels (`vat.ts:32-35`). The booking document shows `vatRate`/`vatAmount` (`booking-doc-data.ts:150-153, 186`). VAT never touches the ledger or balance — clean separation, but no per-line VAT, no zero-rate handling for tourist (non-resident) stays, which Israeli hotels commonly need.

## 9. Financial export / invoice readiness (Israeli market)

What exists is a **booking confirmation/print** (`src/app/reservations/[id]/print/page.tsx`, `src/lib/pdf/BookingPdf.tsx`) — masked card only, payments list with tenant method labels. Missing for חשבונית מס/קבלה compliance: no invoice/receipt entity, no sequential legal numbering, no business identifiers (ח.פ./עוסק מורשה) on the document, no Rashut HaMisim allocation-number (מספר הקצאה) support, no receipt issued on payment, no export (CSV/מבנה אחיד) of the ledger. Payment `method` is free text (default `'credit_card'`, `card-actions.ts:343`) not validated against the canonical `lookup_items 'payment_methods'` list that the rest of the app uses (`booking-doc-data.ts:157-160`, `src/lib/commercial/payment.ts:49-51`) — exports will fragment by method.

## 10. Audit trail on payment mutations

- External payment record: full audit in-tx (amount/method/reference/outcome, IP+session) — `card-actions.ts:371-378`.
- Card save/replace/delete/reveal(+denied)/charge-attempt: all audited, masked metadata only — `card-actions.ts:182-191, 218-225, 247-254, 298-305, 406-413`.
- Payments inserted during reservation create/update ride the generic reservation `create`/`update` audit **without** payment-level detail (no amount/method of the inserted payment) — `actions.ts:291-296, 570-576`.
- No mutation path exists for payment rows themselves (no update/delete action), so the ledger is append-only at the app layer — though not enforced by DB grants/triggers.

---

## 11. Snapshot sanity checks (read-only, `guesthub_stage1_restore`)

| Check | Result |
|---|---|
| Reservations with `paid_amount` ≠ ledger sum (status='paid') | **0** ✅ |
| Reservations with `balance` ≠ `total_price − paid_amount` | **0** ✅ |
| Payments with `amount ≤ 0` | **0** ✅ |
| Payment status distribution | 14 rows, all `paid`, total 25,620.00 |
| Refunds exceeding payments | n/a — zero `refunded/voided/pending/failed` rows exist |
| Orphan payments (tenant mismatch vs reservation; FK prevents dangling) | **0** ✅ |
| Cancelled reservations with `paid_amount > 0` | 0 |
| Overpaid reservations (`paid > total`) | 1 (honest credit, by design) |
| `payments.idempotency_key` populated | 0 of 14 (all NULL) |
| CVV columns anywhere in schema | **0** ✅ |
| Stored encrypted cards / tokenized methods | 2 / 0 |

---

## 12. Findings

| # | Severity | Description | Evidence |
|---|---|---|---|
| H-1 | High | Refunds/reversals are **unimplemented**: `refunded/voided/failed/pending` statuses are constrained and correctly excluded from the paid sum, but no code path ever writes them and no action voids/corrects a payment row — a mistakenly recorded payment (or a real refund) cannot be represented; money out has no ledger form | `019:50-53`; `ledger.ts:13-16`; grep: only display mapping `status-colors.ts:53`; no update/delete action on `guesthub.payments` anywhere in `src/` |
| H-2 | High (compliance) | Full reversible PAN storage + browser reveal keeps GuestHub in full PCI DSS scope; V2 §18 token model exists in parallel but does not replace the vault; no key-rotation tooling for `CARD_VAULT_KEY` | `008:31`; `card-vault.ts:22-41`; `card-actions.ts:208-273`; `030:108-124` |
| H-3 | Medium | Payment recording is **not idempotent**: `payments.idempotency_key` + unique index exist but no payment writer populates the key; double-click/retry on external record or reservation-save-with-payment duplicates a payment | `030:136-140`; `card-actions.ts:355-362`; `actions.ts:281-287, 560-566` |
| H-4 | Medium | Second, divergent aggregate formula on the calendar reschedule path bypasses `recomputePaymentAggregates` (inline `balance = GREATEST(0,…) − paid_amount`, floored total) — the exact drift class D51 removed | `actions.ts:882-893` vs `ledger.ts:26-44` |
| H-5 | Medium | Token model gaps vs V2 §18: provider CHECK hardwired to `'stripe'`; no external **customer** ref; no method **status** lifecycle; no **consent** record; reservation-scoped only (no guest wallet); gateway seam has no token-charge method so stored references are unchargeable by design | `030:112, 123`; `gateway.ts:33-36`; `payments-admin.ts:141-250` |
| H-6 | Medium | Currency integrity: `payments` rows carry no currency; back-office hardcodes ILS while channel import persists OTA currency; print/PDF renders all amounts in **tenant** currency ignoring `reservations.currency` — non-ILS OTA reservations display mislabeled money | `000:286-298`; `actions.ts:258`; `booking-import.ts:548, 593`; `booking-doc-data.ts:150, 213` |
| H-7 | Low | External payment amounts truncated to whole shekels (`Math.round`) against a 2-decimal ledger and agorot-precise `balanceOf` — exact settlement of fractional balances impossible | `card-actions.ts:341`; `inventory-rules.ts:62-64` |
| H-8 | Low | `payments.method` is unvalidated free text (default `'credit_card'`), not checked against the canonical `lookup_items 'payment_methods'` set used by policies and the print doc — method-level reporting fragments | `card-actions.ts:343`; `commercial/payment.ts:49-51, 86-89`; `booking-doc-data.ts:157-160` |
| H-9 | Low | Payments created inside reservation create/update lack a payment-level audit entry (amount/method not in the generic reservation audit); ledger append-only is app-convention only, not DB-enforced | `actions.ts:281-296, 560-576`; `audit.ts:12-18` |
| H-10 | Info (gap) | Israeli invoicing not present: no חשבונית מס/קבלה entity, sequential numbering, business identifiers, allocation-number (מספר הקצאה), or ledger export; VAT is display-only, inclusive, no zero-rating for tourist stays | `vat.ts:1-8, 32-35`; `booking-doc-data.ts`; `BookingPdf.tsx` |
| H-11 | Pass | CVV nonexistence proven end-to-end (schema, snapshot, code, redaction, transient-only gateway contract) | `018:57-61`; snapshot `information_schema` = 0; `payloads.ts:20`; `gateway.ts:17-21` |
| H-12 | Pass | Ledger discipline holds in data: zero drift, zero cache mismatch, zero negative/orphan payments on the snapshot; fail-closed charge path with audit; cancel-never-delete preserves payments; OTA hotel-collect never fabricates payment rows | §11 above; `card-actions.ts:296-311`; `actions.ts:689-698`; `booking-import.ts:625` |
