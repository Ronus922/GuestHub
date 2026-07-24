# Tokenization and PCI Boundaries

**Date:** 2026-07-18 · **Stage:** 3 (model + boundaries) · **Sources:** `src/lib/card-vault.ts`, `reservations/card-actions.ts`, migrations 008/010/018/051

## Hard rules (V2 §18) — enforced

- **CVV is never accepted, stored, encrypted, revealed, logged or audited.** No `cvv_encrypted` column exists (added in 010, permanently dropped in 018). A CVV may exist only transiently inside a single PSP authorization request via the gateway seam and is discarded immediately.
- **PAN never leaves through the wrong door.** It enters only via `saveReservationCardAction` (encrypted before persistence) and returns only via the explicit, permission-gated, audited `revealReservationCardAction`. No save/list path returns the PAN; no request body is logged; no error/audit payload contains more than `last4`.
- **Encryption:** AES-256-GCM via `CARD_VAULT_KEY` (`card-vault.ts`), fail-closed — if the key is absent the app refuses to store a card rather than falling back to plaintext. Key version is recorded (`key_version`) for rotation.

## Current card model

`guesthub.reservation_cards` stores, per reservation: encrypted PAN + `key_version`, masked metadata (`brand`, `last4`, `exp_month/year`), `holder_name`, optional `holder_id_number`, `source`/`source_channel`, `is_virtual`, `available_until`, `billing_notes`. This is a **reversible PAN vault** (needed for manual back-office / OTA virtual-card workflows without a PSP).

### PCI scope acknowledgement (defect H8)

Holding a reversible PAN keeps GuestHub in full PCI scope. Mitigations in place / planned:
- Stage 2 moved the ciphertext off the shared multi-project database onto a dedicated, localhost-bound GuestHub cluster (blast-radius reduction).
- `available_until` exists for retention; a **purge job** that deletes expired vault entries is a Stage-3/Stage-6 hardening item (audit GAP RS) — currently manual delete only.
- Full PCI-scope review + key-rotation tooling is Stage 6.

## Target: provider-neutral payment-method reference model (V2 §18)

The long-term direction is to prefer **provider tokens** over a reversible PAN wherever a PSP is integrated, using a provider-neutral reference:

| Field | Meaning |
|---|---|
| `provider` | cardcom / tranzila (migration 051 set the schema CHECK to `'cardcom'`/`'tranzila'`; **Stripe intentionally excluded** — D91) |
| `external_customer_ref` | provider customer id (missing today) |
| `external_method_ref` | provider payment-method / token id |
| `brand`, `last4`, `exp_*` | masked metadata (present) |
| `status` | active / expired / revoked (missing today) |
| `consent`/`mandate` | stored-credential consent (missing today) |
| timestamps | created/updated |

**Tokens are provider-specific:** a Cardcom token cannot be used by Tranzila and vice-versa — the model records `provider` so a token is never sent to the wrong processor. Gaps (customer ref, method status, consent, token-charge path) are catalogued in `docs/audit/PAYMENTS_AUDIT.md` (H-5) and targeted as the PSP integration lands; the seam (`gateway.ts`) is already provider-neutral. The previously scaffolded **Stripe** tokenization path was dormant and was removed in **D91**; Cardcom/Tranzila are the only PSP providers.

## Card-handling posture

GuestHub can operate **without** requiring raw card data: card handling is masked-metadata + optional reversible vault; no CVV is ever stored. This holds for both direct back-office bookings and OTA virtual-card workflows carried in via the Beds24 channel.
