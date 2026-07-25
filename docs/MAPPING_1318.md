# Room 1318 ↔ Beds24 — diagnosis, gap, and runbook

**Date:** 2026-07-25 · **Scope:** tenant `68139d06-58c4-4043-b256-4691f83e1556`,
Beds24 connection `8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8` (`provider='beds24'`,
`state='active'`, `is_active_provider=true`), Beds24 property **342449**
("מגדל הים - בניין אלמוג", currency ILS).

All Beds24 reads below used the **cached** access token exactly as the app does
(`channel_connections.access_token_ciphertext`, valid to 2026-07-25 22:52 UTC).
No token was minted, printed or modified. **No write of any kind was issued —
not to Beds24, not to the production database.**

---

## ACTIVE OVERBOOKING EXPOSURE: **NO**

Room 1318 **cannot be sold on any channel**, because it does not exist at Beds24
at all. It is invisible to distribution in both directions — nothing to
oversell, and nothing arrives.

Evidence (two independent Beds24 endpoints, live 2026-07-25):

```text
GET /properties?id=342449&includeAllRooms=true   → HTTP 200
PROPERTY 342449 "מגדל הים - בניין אלמוג" currency=ILS
  rooms at Beds24: 14
   707484 "1238"   707485 "926"    707486 "1142"   707487 "1042"
   707488 "1242"   707489 "1237"   707490 "1329"   707491 "1006"
   707492 "1424"   707493 "1235"   707494 "1245"   707495 "1130"
   707496 "1102"   707497 "1131"
                              → no room named or numbered 1318

GET /properties (no filter)  → HTTP 200, count: 1
                              → 342449 is the ONLY property the token can see,
                                so 1318 is not hiding under another property

GET /inventory/rooms/calendar?propertyId=342449
      &startDate=2026-07-25&endDate=2026-08-24&includeNumAvail=true → HTTP 200
rooms returned by Beds24 calendar: 14   (same 14 ids — no 1318 row exists,
                                         therefore no numAvail exists for it)
```

Corroborating evidence on our side:

- No row for 1318 in `guesthub.channel_beds24_room_mappings` (14 rows, all
  `status='mapped'`, all property 342449 — the two rooms without a row are
  `1318` and `חניה זמנית`).
- The exact scoping query `projectBeds24Ari` runs, restricted to 1318, returns
  **0 rows** → not one byte about 1318 has ever left the process:

  ```sql
  SELECT m.room_id, m.local_rate_plan_id
  FROM guesthub.channel_beds24_room_mappings m
  JOIN guesthub.rooms r ON r.id = m.room_id
  WHERE m.connection_id = '8365fdc8-…' AND m.tenant_id = '68139d06-…'
    AND m.status = 'mapped' AND m.local_rate_plan_id IS NOT NULL
    AND r.id = '6653f7e6-a58e-45d4-9e5e-4e775cff4067';
  -- (0 rows)
  ```

- Inbound is clean: 9 `channel_booking_revisions`, all `import_status='imported'`,
  zero `mapping_error`. Beds24 bookings arriving in the next 30 days are 2 —
  roomId 707495 (1130) and 707489 (1237). Neither is 1318.
- Each sellable unit contains exactly one room (16 units / 16 rooms, none
  pooled), so 1318's occupancy cannot leak into another room's pushed
  availability and vice versa.

**The real risk is the mirror image: 1318 is silently NOT distributed.** It has
14 occupied nights and a priced base plan, yet no OTA can ever see it, and — see
"The alert that does not exist" below — nothing in the system says so.

---

## STEP 0 — diagnosis (read-only)

### 0.1 Room 1318 on our side

| field | value |
|---|---|
| `rooms.id` | `6653f7e6-a58e-45d4-9e5e-4e775cff4067` |
| `tenant_id` | `68139d06-58c4-4043-b256-4691f83e1556` |
| `room_number` / `name` | `1318` / `1318` |
| `room_type_id` | `4e7d4b7a-6149-4480-875c-ce61573fa783` ("2 חדרי שינה וסלון", base_price 850) |
| `status` / `is_active` | `available` / `true` |
| occupancy | max 6 (6 adults, 4 children, 1 infant), default/included 2 |
| `show_on_website` / `show_on_calendar` | `true` / `true` |
| sellable unit | `b4b9a377-289d-46d3-9317-51f4185f8843` ("1318"), 1 room, not pooled |
| per-unit base plan | `eea48ca8-885e-4882-ab8e-8b6666d329a4` ("מחיר בסיס"), **30/30 priced days** at 610 ILS in the next 30 days, `stop_sell=false` |
| created | 2026-07-20 11:56 UTC |

Its two reservations (`reservation_rooms` → `reservations`):

| res_no | dates | status | blocking | origin |
|---|---|---|---|---|
| 1004 | 2026-07-08 → 2026-07-31 | confirmed | yes | direct — `channel_connection_id`, `external_booking_id`, `ota_name` all NULL |
| 1006 | 2026-08-06 → 2026-08-14 | confirmed | yes | direct — same, all NULL |

Both are **local/direct**, so no inbound Beds24 revision can ever collide with
or duplicate them: the importer matches on `external_booking_id` /
`external_unique_id`, and these have none.

`guesthub.sellable_unit_inventory()` for 2026-07-25 → 2026-08-24 gives 1318
availability 1 on 16 days and 0 on 14 days — exactly the nights of those two
stays (07-25…07-30 = 6, 08-06…08-13 = 8).

### 0.2 Beds24 property 342449 — every room

Listed in full above: **14 rooms, ids 707484–707497, contiguous, all 14 already
mapped 1:1 to our rooms.** There is no spare, hidden or inactive room that could
be 1318. `qty=1` on every room (per-unit model, not pooled).

Note: `beds24_room_name` stored in our mapping rows is the name as of
2026-07-19 ("Studio", "One-Bedroom Apartment with Sea View", …). The rooms have
since been renamed at Beds24 to the bare unit numbers. Cosmetic snapshot drift
only — the mapping key is `beds24_room_id`, which is unchanged and correct.

### 0.3 The shape of a valid mapping record

Live row for the closest analogue (1329 — same local room type, same capacity):

```text
id                   88f6ae35-e27c-4de2-b785-f08e3146984d
tenant_id            68139d06-58c4-4043-b256-4691f83e1556
connection_id        8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8
room_id              fbd663ec-c384-46b0-82ea-59214809fb97   (rooms."Two Bedroom Apartment Sea View - 1329")
beds24_property_id   342449
beds24_room_id       707490
beds24_property_name מגדל הים - בניין אלמוג
beds24_room_name     Two-Bedroom Apartment with Ocean View
local_rate_plan_id   fee07a5b-8d74-4f5a-9466-c6f7818afb8f   (pricing_plans "No_Refuneble" / "ללא החזר")
currency             ILS
status               mapped
```

All 14 rows share `connection_id`, `beds24_property_id=342449`,
`local_rate_plan_id=fee07a5b-…`, `currency=ILS`, `status='mapped'`. Uniqueness is
enforced twice: `(connection_id, room_id)` and
`(connection_id, beds24_property_id, beds24_room_id)`.

`guesthub.channel_room_mappings` (13 rows) belongs to the **paused Channex**
connection `5e6dba4e-…` and is not a template for anything here.

### 0.4 Exposure / numAvail, next 30 days (2026-07-25 → 2026-08-24)

Beds24 `numAvail` vs. our `sellable_unit_inventory()` — the two agree everywhere:

| room | Beds24 numAvail=0 days | local availability=0 days | verdict |
|---|---|---|---|
| 1238, 926, 1142, 1235, 1102, 1131 | 0 | 0 | match |
| 1242 | 07-25 | 1 | match |
| 1237 | 08-07 | 1 | match |
| 1329 | 08-06 | 1 | match |
| 1245 | 08-09 | 1 | match |
| 1130 | 07-28 | 1 | match |
| 1424 | 07-25…07-30 | 6 | match |
| 1006 | all 30 | 0 | **deliberate stop-sell** — its base plan carries `stop_sell=true` on all 30 days; the push correctly sends numAvail=0 |
| 1042 | all 30 | 0 | same — `stop_sell=true` on all 30 days |
| **1318** | **no row exists at Beds24** | 14 | **not distributed at all** |
| חניה זמנית | no row exists at Beds24 | 30 (permanently) | deliberate, see STEP 3 |

No room is offered at Beds24 on a date our own inventory calls occupied. There
is no oversell anywhere in the window.

---

## STEP 1 — the configuration gap

**CASE (a): the room does not exist at Beds24.**

Not (b) — a mapping row cannot be created, because there is no
`beds24_room_id` to point at. Not (c) — there is no broken row; "unmapped" for
this table means "no row" (`beds24_room_id` is `NOT NULL` and unique per
connection+property, so `unmapBeds24RoomAction` deletes rather than flags —
`src/lib/channel/beds24-admin.ts:706`).

Order of operations, and what depends on what:

1. **Ronen creates the room in the Beds24 panel** under property 342449 (panel
   action, not code — see the runbook). Nothing in GuestHub can do this: the
   Beds24 client is read-only on `/properties` and the only write path in the
   whole codebase is `POST /inventory/rooms/calendar`
   (`src/lib/channel/beds24-ari.ts:118`). Creating a room is not in it, by
   design.
2. **Guard against an accidental go-live first** (see the warning below) —
   this must happen *before* step 3, not after.
3. **Create the mapping** via the app UI (Channels → Beds24 → refresh property
   list → map 1318). `mapBeds24RoomAction` re-verifies the property and room
   fresh against Beds24, checks currency, writes the row and an audit entry.
   No SQL, no migration.
4. **Verify**, then deliberately release for sale.

### ⚠ The moment the mapping row exists, 1318 goes on sale

Unlike 1006 and 1042 (which are stop-sold and therefore harmless), **1318's base
plan is priced and open**: 30/30 days at 610 ILS, `stop_sell=false`. The first
ARI drain or full sync after the mapping appears will push
`numAvail=1, price1=610` for all 16 free nights, and the OTAs will start selling
it — with no further human action.

So the mapping and the go-live must be separated on purpose. Either:

- **(preferred)** create the Beds24 room **not connected to any channel** and
  keep it that way until step 4 passes; or
- set `stop_sell=true` on 1318's base plan (`eea48ca8-…`) for the horizon before
  mapping — the same state 1006/1042 are already in — and clear it deliberately
  after verification.

---

## STEP 2 — what was executed

**Nothing was written.** This is case (a): the only correct action on our side
is to wait for the Beds24 room to exist. No mapping row was inserted (there is
no room id to insert), no ARI was pushed, no room was opened for sale, and no
room was created at Beds24. Staging was not needed — there is no DB change to
rehearse.

### Runbook for Ronen — Beds24 panel

**A. Create the room** (Beds24 → Settings → Properties → 342449
"מגדל הים - בניין אלמוג" → Rooms → new room). Use unit 1329 (id 707490) as the
template — it is the same local room type and capacity. Fields, with the values
the existing 14 rooms use:

| field | value | why |
|---|---|---|
| Name | `1318` | every other room is named by its bare unit number — the mapping UI shows this name |
| Room type | `apartment` | as 1006 / 1329 (both `2 חדרי שינה וסלון`) |
| Qty / units | `1` | every room in this property is `qty=1`; the per-unit model depends on it |
| Max people | `6` | our `rooms.max_occupancy` for 1318 |
| Max adults | `6` | our `rooms.max_adults` |
| Max children | `4` | our `rooms.max_children` |
| Overbooking protection | `room` | as 1329 |
| Min stay / Max stay | none / `365` | as 1329 (GuestHub pushes per-date minStay itself) |
| Restriction strategy | `stayThrough` | as 1329 |
| Sell priority / control priority | `5` / `5` | as 1329 |
| Dependencies | none | every room is independent — do **not** link 1318 to another room |
| **Channel connections** | **leave OFF / do not connect any OTA yet** | this is the go-live guard from STEP 1 |

Do **not** set prices or availability in the Beds24 panel. GuestHub is the
source of truth for both and pushes them through
`POST /inventory/rooms/calendar`; anything typed in the panel is overwritten on
the next sync.

**B. Verify the room is visible to the API.** Ask for the room list again (or
just do step C — the UI does this call for you). The room must appear in
`GET /properties?id=342449&includeAllRooms=true` with a new numeric id, expected
`707498` or higher.

**C. Create the mapping in GuestHub** — Channels → Beds24 → "רענן רשימת נכסים"
→ choose room `1318` → Beds24 property `מגדל הים - בניין אלמוג` → Beds24 room
`1318` → rate plan **`ללא החזר` (No_Refuneble)** → save. The action refuses the
write if the room is not really there or if the currency does not match, so a
stale browser list cannot produce a bad row. The result must be one new row in
`channel_beds24_room_mappings` with `status='mapped'`, `beds24_property_id=342449`,
`local_rate_plan_id=fee07a5b-…`, `currency=ILS`.

**D. Verify before releasing** — run STEP 4 below.

**E. Release for sale deliberately** — only after D: connect 1318 to the OTA
channels in the Beds24 panel (and/or clear the temporary `stop_sell`), then
watch the first push.

---

## STEP 3 — חניה זמנית

**Already marked as deliberately not-distributed, using mechanisms that exist in
the schema. No change was made and none is needed.**

| marker | value on `חניה זמנית` (`9569be80-…`) | value on all 15 real rooms |
|---|---|---|
| `rooms.is_active` | **`false`** | `true` |
| `rooms.show_on_website` | `false` | `true` (except 1042) |
| `rooms.show_on_calendar` | `false` | `true` (except 1006, 1042) |
| mapping row | none | present for 14 |

`is_active=false` is the effective, enforced one. `guesthub.sellable_unit_inventory()`
counts a room as sellable only when `status='available' AND is_active`, so the
unit reports `sellable_rooms=0` and `availability=0` on every date, for ever —
verified: 30/30 days at availability 0 in the 30-day window, while every real
room varies. Even if someone mapped it by accident, the projection would push
`numAvail=0` on every date; and being a pseudo-room, it has no counterpart at
Beds24 to map to.

No new column, no migration, no DECISIONS.md entry required.

---

## STEP 4 — verification

The mapping could not be completed (case a), so the verification performed is
the fallback the task specifies: **prove 1318 is not being silently sold.**

| claim | evidence |
|---|---|
| 1318 does not exist at Beds24 | `GET /properties?id=342449&includeAllRooms=true` → 14 rooms, none is 1318; `GET /properties` → `count: 1` (no other property) |
| 1318 has no availability at Beds24 | `GET /inventory/rooms/calendar?propertyId=342449` for 2026-07-25→08-24 returns 14 room blocks; 1318 is absent, so no `numAvail` exists for it |
| Nothing about 1318 is ever pushed | the projection scoping query for 1318 returns 0 rows (`beds24-ari-projection.ts:104-118`); an unmapped room is structurally excluded |
| No inbound booking can land on 1318 | there is no Beds24 room id to arrive on; if one ever did, `beds24-normalize.ts:170-177` returns `unmappedRoomId` and `beds24-booking-import.ts:251-259` quarantines it with code `unmapped_room`. Zero such rows exist today (9 revisions, all imported, no `mapping_error`) |
| The two local reservations are intact and not duplicated | both `confirmed`, `is_blocking=true`, and both purely local (`external_booking_id`, `external_unique_id`, `channel_connection_id` all NULL) — nothing for the importer to match |
| No oversell anywhere in the property | Beds24 `numAvail` and `sellable_unit_inventory()` agree on all 14 mapped rooms for the next 30 days (table in §0.4) |

### The alert that does not exist

**22 dirty ranges for room 1318 on the active Beds24 connection are marked
`status='synced'`, and not one of them sent anything.** This is deliberate
policy, not a bug — `beds24-ari-sync.ts:523-525`:

> `// NOTE: rows for rooms with no pushable mapping produce nothing to send and`
> `// are marked synced below — same policy as ari-sync.ts (projectAri simply`
> `// returns nothing for unmapped rooms and the claimed rows complete).`

The consequence is that an unmapped room is **indistinguishable from a healthy
one** in every existing signal:

- `check:beds24-ari` passes — it only looks for ranges pending > 2h, and these
  complete instantly.
- The evidence ledger's `unmappedRooms` counter cannot see it either: the
  payload builder only counts mappings that *exist but lack a rate plan*
  (`beds24-ari-payloads.ts:192-198`). A room with **no row at all** never
  enters `mappings` and is counted nowhere.
- `check:beds24-revisions` passes — nothing inbound can reference the room.

**Required alert** — a mapping-coverage guard, asserting on the active Beds24
connection that every distributable room has a mapping:

```sql
SELECT r.id, r.name
FROM guesthub.rooms r
JOIN guesthub.channel_connections cc
  ON cc.tenant_id = r.tenant_id AND cc.provider = 'beds24' AND cc.state = 'active'
LEFT JOIN guesthub.channel_beds24_room_mappings m
  ON m.room_id = r.id AND m.connection_id = cc.id AND m.status = 'mapped'
WHERE r.is_active AND r.status = 'available' AND m.id IS NULL;
-- must return zero rows; today it returns 1318
```

`r.is_active` is what makes the assertion correct rather than noisy: it excludes
חניה זמנית by the very mechanism STEP 3 relies on. Wiring it as
`check:beds24-mapping-coverage` needs one line in `package.json`, which is
currently inside PR #112's diff — **not touched here**, so the guard is
specified rather than installed.

---

## Not fixed here (observed, out of scope)

- `src/lib/rates/grid-state.ts:193` reads the legacy Channex
  `channel_room_mappings` table, so the /rates "mapped" badge is wrong. Known,
  and deliberately left alone.
- 1006 and 1042 are stop-sold at Beds24 for the whole 30-day window
  (`stop_sell=true` on all 30 days of their base plans). Consistent end to end
  — flagged only so it is not mistaken for the 1318 problem.
- `beds24_room_name` in the 14 existing mapping rows is a 2026-07-19 snapshot
  and no longer matches the current Beds24 room names. Display-only.
