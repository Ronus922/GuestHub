# Min Stay Arrival / Through — determination & declaration (§15)

**Status:** determined and declared · **Applies to:** Channex certification Group Update + ARI restrictions · **Last reviewed:** 2026-07-18

Channex exposes two distinct minimum-stay restrictions on `POST /restrictions`:

| Channex field | Meaning |
|---|---|
| `min_stay_arrival` | Minimum number of nights required **when a stay ARRIVES (checks in) on that date**. The classic "minimum stay". |
| `min_stay_through` | Minimum number of nights required for **any stay that PASSES THROUGH that date** (arrives on or before, departs on or after). Stricter — it constrains stays that merely overlap the date, not only those that begin on it. |

## GuestHub's determination

GuestHub's Rate Grid stores **both** values independently per (room × plan × date):
`pricing_plan_rates.min_stay_arrival` and `pricing_plan_rates.min_stay_through`.

The canonical projection (`src/lib/channel/ari-projection.ts`) resolves them as:

- **`min_stay_arrival`** = `max(cell.min_stay_arrival, plan.default_min_stay)`.
  The per-cell value is the operator's explicit override; it is floored by the
  rate plan's `default_min_stay` so a plan-level minimum can never be silently
  undercut by a blank cell. This is the **primary, always-populated** restriction.
- **`min_stay_through`** = `cell.min_stay_through` (per-cell only, no plan floor).
  **Optional**: sent only when the operator sets it on the cell/Group Update.
  Absent by default — GuestHub does not synthesise a through-restriction.

Both are emitted to Channex exactly as resolved (`ari-payloads.ts` includes each
field only when non-null), so the value the operator sees in the grid is the
value Channex receives — no hidden remapping.

## Declaration answer (certification form)

> **Q: How does your PMS handle Minimum Stay Arrival vs Minimum Stay Through?**
>
> GuestHub supports both as first-class, independently-editable restrictions in
> its Rate Grid and Group Update. `min_stay_arrival` is the primary minimum-stay,
> always sent, floored by the rate plan's default minimum stay. `min_stay_through`
> is optional and sent only when explicitly set. Both map 1:1 to the Channex
> `min_stay_arrival` / `min_stay_through` fields with no transformation.

## Verified by

`scripts/check-channex-group-update-batching.mjs` — asserts both fields survive
projection→payload, and that a Group Update spanning multiple rooms/plans/dates
collapses into a single combined restrictions request.
