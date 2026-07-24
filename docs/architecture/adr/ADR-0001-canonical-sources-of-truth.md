# ADR-0001 — Canonical source of truth per business concept

- **Status:** Accepted (Stage 1) — approved by Agent A (lead architect)
- **Date:** 2026-07-18
- **Deciders:** Agents A, B, E, F, G, H, D (reviewed)
- **Context inputs:** `docs/audit/DOMAIN_INVENTORY.md`, `PRICING_AUDIT.md`, `PAYMENTS_AUDIT.md`, `RESERVATIONS_INVENTORY_AUDIT.md`

## Context

V2 §8 mandates exactly one canonical source per business concept: UI must not invent business state and integration modules must not recompute domain logic. The audit found GuestHub is already largely single-sourced (one pricing engine, one availability function, one payment ledger) but carries competing/legacy models (four channel-mapping tables, legacy `rates`, triple physical-room model) and a handful of surfaces that re-implement a canonical rule inline.

## Decision

Declare the canonical source for every core concept. All later stages implement against this table; any second path is removed or made a thin projection of the canonical one.

| Concept | Canonical source | Non-canonical paths to remove/convert |
|---|---|---|
| Physical room identity | `rooms` table (D74, migration 028) | `sellable_units` and `room_types` are projections; mirror trigger keeps them consistent. `sellable_units_backup_028` deleted (Stage 3). |
| Sellable inventory / availability | `guesthub.check_room_availability()` + `src/lib/inventory.ts` (one conflict function) | Calendar/rate-grid `price ?? base_price` re-implementations (M10) become one shared projection. `channel_inventory_holds` either wired or dropped (M1). |
| Price / quote | `calculateReservationPrice` / `calculateQuote` (`src/lib/pricing/engine.ts`) | Beds24 ARI projection already calls `resolveChainNightPrice` verbatim — keep. Reschedule inline total (M7) converted to engine call. |
| Restrictions (min/max stay, CTA/CTD, stop-sell) | one shared validator `stayRestrictionViolationStructured` + `channel_dirty_ranges` projection | none competing; enforce on direct operator bookings too (GAP). |
| Reservation state | `reservations` + `reservation_rooms`; status drives inventory via `inventory_blocking_statuses()` | add CHECK constraint (H2); `paid_amount/balance` are derived caches only (never authoritative). |
| Payment state / balance | `guesthub.payments` ledger; balance derived by `recomputePaymentAggregates` (`src/lib/payments/ledger.ts`) | reschedule inline balance formula (M7) removed. |
| Guest identity | `guests` (canonical) + per-reservation snapshot (see ADR-0003) | per-booking duplicate insert on import gets a merge/dedup seam. |
| Channel environment | `channel_connections.environment` (V2 §11) | hardcoded staging base URLs (CHX G6) removed in Stage 4. |
| Channel mapping | consolidate to the live tables (`channel_room_mappings`, `channel_room_rate_mappings`); the 0-row 005-era `channel_room_type_mappings`/`channel_rate_plan_mappings` are dead — migrate FK references then drop (M12, Stage 4). |
| Audit trail | `audit_logs` (append-only) via `audit-write.ts` | add a read/query surface (H13); enforce append-only by grant/trigger not convention. |
| Reservation source / OTA number | canonical `source` + `ota_*` fields on `reservations` (D80) | — |

## Consequences

- Stage 3 owns removing the domain-layer duplications (M7, M10, legacy `rates`, backup table, status CHECK).
- Stage 4 owns the channel-mapping consolidation and environment routing.
- A `check:pms-domain-invariants` guard (Stage 3) will assert no surface re-implements a canonical rule that has a shared function.
- No behavior changes in Stage 1; this ADR is the contract the later stages are measured against.
