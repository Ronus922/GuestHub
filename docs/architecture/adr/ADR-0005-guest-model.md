# ADR-0005 — Guest model direction

- **Status:** Accepted (Stage 1) — approved by Agent A; input to Stage 3 (foundation) and Stage 5 (merge UI, PII)
- **Date:** 2026-07-18
- **Deciders:** Agents A, C, F, I
- **Context inputs:** `docs/audit/DOMAIN_INVENTORY.md`, `PMS_GAP_MATRIX.md` (guest identity), `RESERVATIONS_INVENTORY_AUDIT.md`, `THREAT_MODEL.md`, V2 §10 (Guests), §10 (Israel PII)

## Context

A `guests` table exists (60 rows) but channel import inserts a **new guest per booking** (`booking-import.ts:343`) with no dedup/merge and no guest-edit UI (M24). There is no canonical stay history, consent record, communication-preference, or PII retention/deletion path — the last is an Israeli Privacy Law (Amendment 13) obligation (H15). V2 §10 warns not to redesign this area without migration safety.

## Decision

**Canonical guest record + immutable per-reservation guest snapshot** — a two-layer model, introduced without a risky big-bang migration.

1. **Canonical `guests`** remains the identity record (name, contact, language, consent, communication preference, notes), scoped by tenant. It is the merge target and the home of privacy attributes.
2. **Per-reservation snapshot**: the guest details as they were at booking time stay attached to the reservation (already partly true via reservation fields) so historical documents/invoices never mutate when a canonical guest is later edited or merged. Stage 3 formalizes the snapshot boundary.
3. **Import dedup seam** (Stage 3 foundation): channel import resolves an existing canonical guest by a deterministic key (email/phone normalized) before inserting a new one; when ambiguous it still creates but flags for merge — never guesses silently (fail-visible, V2 §8).
4. **Merge tool + guest-edit UI**: Stage 5 (operator-facing), building on the Stage-3 canonical record.
5. **Israeli PII obligations** (Stage 5, V2 §10): data minimization (store only what's needed), access control (already tenant-scoped + permissioned), retention policy, and a **deletion/anonymization capability** — which must reconcile with the `outbound_messages` RESTRICT FK (M13) so a guest *can* be deleted/anonymized without orphaning immutable message history (anonymize-in-place rather than hard-delete where history must survive).

## Consequences

- Stage 3: canonical guest boundary + snapshot + import dedup seam + reconcile the M13 FK conflict (make deletion/anonymization possible).
- Stage 5: merge UI, guest-edit UI, retention/deletion/anonymization workflow, guest-language communications.
- No schema change in Stage 1. Migration safety: the two-layer split is additive (snapshot columns/rows already largely exist); the canonical record is enriched, not replaced, so existing 60 guests and 81 reservations migrate in place.
- Duplicate detection is a seam, not an ML problem — deterministic normalized-key match only; anything fancier is deferred (YAGNI).
