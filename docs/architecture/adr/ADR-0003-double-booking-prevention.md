# ADR-0003 — Double-booking prevention mechanism

- **Status:** Accepted (Stage 1) — approved by Agent A; primary input to Stage 3
- **Date:** 2026-07-18
- **Deciders:** Agents A, E, F
- **Context inputs:** `docs/audit/RESERVATIONS_INVENTORY_AUDIT.md` (F1, scenario R9), `DOMAIN_INVENTORY.md` (#1), V2 §10

## Context

Overbooking prevention today is entirely application-level: `lockRooms()` (`SELECT … FOR UPDATE`) plus `check_room_availability()` inside the reservation transaction. All current product paths comply and the snapshot shows zero overlaps, but there is **no database-level guarantee** (H1). Two historical direct-SQL bypass incidents are already documented (migrations 026/028). V2 §10 explicitly requires a DB-level last line of defense: an exclusion constraint on room + stay date-range over active states, combined with the existing row/advisory locks.

## Decision

Add, in Stage 3, a PostgreSQL **exclusion constraint** as the last line of defense, keeping the existing application locks:

- On `reservation_rooms` (the row that binds a reservation to a physical room + stay), add a `daterange` of the stay `[check_in, check_out)` and:
  ```
  EXCLUDE USING gist (room_id WITH =, stay WITH &&)
  WHERE (<reservation is in an inventory-blocking status>)
  ```
- The blocking-status predicate mirrors `inventory_blocking_statuses()`; because the exclusion must be immutable, the constraint is scoped via a partial index on a stored boolean/generated column that reflects blocking status (maintained by trigger or generated column), not by calling a volatile function directly.
- `btree_gist` extension is required (for the `room_id WITH =` equality in a gist exclusion). Verify it is available on the dedicated cluster (Stage 2); enabling an extension on the **dedicated** GuestHub cluster is allowed (it is not the shared stack).
- Keep `lockRooms()` FOR UPDATE + `check_room_availability()` for a friendly application-level error and correct concurrency ordering; the constraint is the guarantee, the app check is the UX.
- Fix the lock-ordering deadlock risk (M3) by sorting locked room IDs deterministically.

Half-open interval `[check_in, check_out)` is used so same-day checkout/checkin on one room does **not** conflict (standard hotel semantics).

## Consequences

- Stage 3 delivers the migration + `check:reservation-concurrency` and `check:inventory-integrity` tests, including scenario R9 (concurrent inserts bypassing `lockRooms`) run only on the disposable DB to prove the constraint holds under true concurrency.
- Migrating existing data: the constraint is added `NOT VALID` then validated after confirming zero current overlaps (snapshot already shows zero), avoiding a failed migration on live data.
- Status changes that would create an overlap now fail closed at the DB rather than silently double-book.
- Interacts with H2 (status CHECK) and the generated blocking-status column — both land together in Stage 3.
