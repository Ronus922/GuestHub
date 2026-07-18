# GuestHub — Performance

- **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification`
- **Principle (V2 §20):** measurement-driven; no blind optimization; justified indexes only; conclusions require before/after evidence.

## Hot read paths + the indexes that serve them

| Hot path | Query | Serving index |
|---|---|---|
| Calendar / ARI availability | `sellable_unit_inventory` / `room_type_inventory` (reservation_rooms overlap + OOO closures) | `idx_res_rooms_tenant_dates`, `idx_closures_ooo` |
| Double-booking guard | exclusion constraint on write | `rr_no_double_booking` (gist) |
| Arrivals / departures / in-house | reservations by tenant + check_in/out | `idx_reservations_tenant_checkin`, `idx_reservations_dates` |
| Status filters / reports | reservations by tenant + status | `idx_reservations_tenant_status` |
| Rate grid / projection | `pricing_plan_rates` by unit/tenant + date | `idx_ppr_unit_date`, `idx_ppr_tenant_date` |
| Outbound drain | dirty ranges ready to send | `idx_dirty_runnable`, `idx_dirty_pending` |

No new indexes were added in Stage 6: the predicates above are already covered by
purpose-built composite `(tenant_id, …, date)` indexes from earlier stages. Adding
more would be unjustified (write cost without a measured read win).

## Measurements — current scale (staging :5434)

`EXPLAIN (ANALYZE)` on the heaviest read, the 500-day per-SU availability
projection (`sellable_unit_inventory`, the same function the calendar and ARI
consume):

- **Execution time ≈ 12 ms** (planning ≈ 7 ms) over the full 500-day horizon.
- Well under the `check:performance` budget of 1500 ms.

This is the dominant hot path (ARI full sync, calendar render, booking validation
all fan out from it); other reads (reservation lists, cash-up, occupancy) are
simpler aggregations over the same indexed tables.

## Growth-scale method + reasoning

The composite `(tenant_id, …, date_range)` indexes are the growth-critical design:
the availability + report predicates are all `tenant_id = ? AND <date overlap>`,
which these indexes serve with index-range scans rather than full scans, so cost
grows with the *result window* (bounded: 500 days, one tenant's rooms), not with
total table size. The 500-day projection is already the worst-case window.

**Growth-scale fixture (method, for a load run when needed):** seed the disposable
:5433 DB with N× reservations/rooms/rate-rows via `scripts/seed.mjs` scaled up,
then re-run the same `EXPLAIN (ANALYZE)` and confirm the plan stays on the
composite indexes and the 500-day projection stays within budget. Because the hot
predicates are tenant+window-bounded and index-served, per-request cost is
insensitive to global row count; the fixture run validates that the planner keeps
choosing the index at scale.

## Verified by
`check:performance` — asserts the justified indexes exist and the 500-day
availability projection stays within budget (measured via EXPLAIN ANALYZE on staging).
