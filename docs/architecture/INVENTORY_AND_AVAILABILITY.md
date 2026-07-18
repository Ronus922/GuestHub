# GuestHub — Inventory & Availability

- **Status:** Skeleton — Stage 1; completed in **Stage 3**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/RESERVATIONS_INVENTORY_AUDIT.md` (§2 Q1–Q2), `docs/audit/DOMAIN_INVENTORY.md` (§3, §5), ADR-0001, ADR-0003

How availability is computed, how physical inventory maps to sellable units, and where the double-booking guarantee lives.

## Current state

Availability has ONE canonical conflict-level function — SQL `guesthub.check_room_availability()` (`004_phase3_calendar.sql:73-111`: half-open overlap, blocking statuses, closures, room sellability), with the sole TS entry `checkRoomAvailability` (`src/lib/inventory.ts:57`); all booking-side paths reach it through the pricing engine (`engine.ts:242`) or directly (OTA import, closures) (`RESERVATIONS_INVENTORY_AUDIT.md` §2 Q1). The blocking-status list is single-sourced (`inventory_blocking_statuses()` ↔ `src/lib/inventory-rules.ts`, CI-asserted). Two aggregate count projections exist: `room_type_inventory()` (includes `channel_inventory_holds`) and `sellable_unit_inventory()` (deliberately excludes holds, feeds outbound ARI) — a documented but latent divergence. The physical/sellable model is triple-layered (room / sellable_unit / room_type) kept 1:1 by the 026/028 triggers (`DOMAIN_INVENTORY.md` §3).

The material gap is the guarantee: **no DB-level double-booking guard** — no exclusion constraint, no unique range index, no advisory locks; prevention rests entirely on the app contract "lockRooms (`SELECT … FOR UPDATE`) then check in the same tx" (D34). All current product paths comply and the snapshot shows zero overlaps, but any bypass (future code, admin SQL, scripts) writes overlaps silently (`RESERVATIONS_INVENTORY_AUDIT.md` §2 Q2, F1). Secondary issues: `channel_inventory_holds` is dead scaffolding (counted and rendered but never written) so an unappliable OTA booking consumes no local inventory — a local-overbooking window (F2); `lockRooms` does not sort ids, so cross-path multi-room writes can deadlock (F4).

## Target state (per ADR-0001, ADR-0003)

- `check_room_availability` + `src/lib/inventory.ts` confirmed as THE single conflict function; calendar/rate-grid `price ?? base_price` re-implementations collapsed into one shared projection (ADR-0001).
- DB exclusion constraint `EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out) WITH &&)` scoped to blocking status, `btree_gist` enabled on the dedicated cluster (ADR-0003).
- `channel_inventory_holds` either wired or dropped (ADR-0001, M1); reconcile the two count projections.
- Deterministic lock ordering (ADR-0003).

## To be completed in Stage 3

- [ ] Availability computation walkthrough (inputs: stays, closures, room status; half-open overlap rule).
- [ ] Physical→sellable→channel mapping diagram.
- [ ] Exclusion-constraint design + `check:inventory-integrity` / `check:reservation-concurrency` test plan (incl. R9).
- [ ] Resolution of the holds divergence (`room_type_inventory` vs `sellable_unit_inventory`).
- [ ] Lock-ordering rule and deadlock-avoidance note.
