# Channex ARI outbound contract (reference — no live connection)

Source: official Channex docs (`https://docs.channex.io/llms-full.txt`), fetched 2026-07-05.
Used only to shape GuestHub's INTERNAL outbound projection + queue. No HTTP is sent
(fake/recording providers only). Phase 4B wires the real client.

## Two payload shapes

### Availability (ROOM TYPE level) — physical inventory only
```json
{ "type": "availability_changes",
  "attributes": { "room_type_id": "…", "date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD",
                  "availability": <integer> } }
```
`availability` = integer count of physically sellable units for the mapped Channex
Room Type. Comes ONLY from physical inventory (`sellable_unit_inventory`), never from
`stop_sell`/rates.

### Restrictions + Rates (RATE PLAN level) — commercial ARI only
```json
{ "type": "restriction_changes",
  "attributes": { "rate_plan_id": "…", "room_type_id": "…",
                  "date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD",
                  "rates": [{ "rate": "200.00", "currency": "…", "occupancy": 2 }],
                  "stop_sell": <bool>, "closed_to_arrival": <bool>, "closed_to_departure": <bool>,
                  "min_stay_arrival": <int>, "min_stay_through": <int>, "max_stay": <int> } }
```
Comes ONLY from commercial ARI (`pricing_plan_rates`). Rate/restriction changes never
change availability.

## Levels
- Availability → `room_type_id` (Channex Room Type).
- Rates/restrictions → `rate_plan_id` (Channex Rate Plan) + its `room_type_id`.

GuestHub mapping: Sellable Unit → Channex Room Type (`sellable_units.room_type_id`);
Pricing Plan → Channex Rate Plan. An individually-sold apartment → one Room Type with
availability 0/1. A pooled SU → one Room Type, availability = count of eligible free
member rooms.

## Rate limits & batching (drives coalescing)
- 10 Restriction & Price requests / minute / property.
- 10 Availability requests / minute / property.
- Recommendation: "batch all changes and combine into 1 api call each ~6 seconds";
  queue to avoid HTTP 429. Up to 10MB per JSON call.
→ Coalesce rapid per-cell edits into one canonical batch per (property, kind) window;
  the worker rebuilds the batch from the LATEST Effective Sell State, never replays a
  stored UI payload. Past dates are handled distinctly by Channex; GuestHub rejects
  past-date writes locally to match the future-facing external contract.
