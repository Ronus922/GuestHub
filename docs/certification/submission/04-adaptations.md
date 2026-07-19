# 04 — Vacation-Rental Adaptations (form notes)

Paste-ready notes for the Channex certification form. Channex's official
vacation-rental adaptation lets a product that models **one unit / one price per unit**
mirror its actual data model on the staging property, provided every adapted test value
is declared here.

---

## GuestHub's data model (the reason for adaptation)

GuestHub's inventory unit is the **physical room**, not a pooled room-type count. Each
physical room maps to exactly **one Channex Room Type with `count_of_rooms = 1`** (D64).
Consequently availability is **0 or 1 per room**, never a count > 1.

| Concept | GuestHub value |
|---|---|
| Room Type inventory | `count_of_rooms = 1` (one physical unit) |
| Open (bookable) | availability = **1** |
| Sold or blocked | availability = **0** |
| Cancellation / release | availability back to **1** |

This is a deliberate, consistent model across all ARI — not a per-test workaround.

---

## Adapted test values (official table value → GuestHub value + reason)

| Test | Official table value | GuestHub adapted value | Reason |
|---|---|---|---|
| 9 — Single-date availability | Twin 21 Nov `8 → 7`; Double 25 Nov `1 → 0` | Twin 21 Nov `1 → 0`; Double 25 Nov `1 → 0` | Single-unit model: a booking takes the one unit, so any "occupied" state is `→ 0`; the documented `8` has no counterpart (there is only ever 1 unit). |
| 10 — Multi-date availability | Twin 10–16 Nov `→ 3`; Double 17–24 Nov `→ 4` | Twin 10–16 Nov `→ 0` or `→ 1` per unit; Double 17–24 Nov `→ 0` or `→ 1` per unit | Same single-unit model: values are `0/1` per physical room; a count of `3`/`4` cannot exist for a `count_of_rooms = 1` room type. |
| 9–10 — general | availability as a count (e.g. `8`) | availability as `0/1` per unit | Inventory unit is the physical room; every availability change is expressed as open (`1`) / sold-or-blocked (`0`). |

All other tests (1–8) use the **official rate/restriction values as-is** — no adaptation.
Rate and restriction semantics (price, min-stay, stop-sell, CTA/CTD, max-stay) are
unchanged; only the **availability count → 0/1** mapping is adapted.

---

## Realistic-data note

Before the certification Full Sync the property carries **varied** prices, min-stay and
restrictions across the 500-day window (multiple room types, seasons, weekend pricing),
and availability changes come from **real test reservations** — not uniform placeholders.
Group Update compression is therefore visible in the demo while each still emits one API
call per dimension.

---

## Declaration line for the form

> GuestHub models one physical unit per Channex Room Type (`count_of_rooms = 1`), so
> availability is 0/1 per room rather than a pooled count. Tests 9–10 are adapted
> accordingly: Open = 1, Sold/blocked = 0, cancellation/release = 1; documented counts
> such as `8`, `3` or `4` are mapped to the single-unit `0/1` equivalent. All rate and
> restriction tests (1–8) use the official values unchanged.
