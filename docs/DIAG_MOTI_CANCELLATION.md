# DIAG — Moti Grosman cancellation that never freed the room

**NEITHER STATE A NOR STATE B · root cause: the cancellation never reached Beds24 — GuestHub is correctly mirroring a source that still says the booking is live · deciding evidence: live `GET /bookings?id=90359426` returns `status:"new"`, `cancelTime:null`, `modifiedTime:2026-07-24T08:50:35Z` (unchanged since creation), and a full account sweep of all 5 Beds24 bookings 2025-01-01→2027-12-31 finds exactly one cancelled booking and it is a different guest · scope 4.1 = 0 · scope 4.2 = 2 · released: NO (STEP 5 conditional not met — the source is NOT cancelled, so touching it would be releasing a room that is still sold).**

---

Phase 1, read-only diagnosis. No code changes. No DB writes. No repair performed.
Worktree `/var/www/wt-stab` (branch `stab/base`). Production DB read via `docker exec supabase-db`
(`DATABASE_URL` → `localhost:5432` → `supabase-pooler` → `supabase-db`, verified; no secret value printed).
Live Beds24 reads used the canonical auth path (cached 24 h access token, AES-256-GCM under
`CHANNEL_SECRETS_KEY`, `token` header on `api.beds24.com/v2`). No token ever printed.

---

## STEP 1 — Identify the reservation, then ask the source

### 1a. The guest

```sql
select id, tenant_id, full_name, first_name, last_name, email, phone, country, created_at
from guesthub.guests
where full_name ilike '%grosman%' or full_name ilike '%grossman%' or full_name ilike '%moti%'
   or last_name ilike '%grosman%' or first_name ilike '%moti%'
   or full_name ilike '%גרוסמן%' or full_name ilike '%מוטי%';
```

```
                  id                  |              tenant_id               |  full_name   | first_name | last_name |              email              |      phone       | country |          created_at
--------------------------------------+--------------------------------------+--------------+------------+-----------+---------------------------------+------------------+---------+-------------------------------
 1335e46e-93a3-4907-9d4a-9993564dbd3f | 68139d06-58c4-4043-b256-4691f83e1556 | Moti Grosman | Moti       | Grosman   | mgrosm.803498@guest.booking.com | +972 52 667 5358 | il      | 2026-07-24 08:52:12.379699+00
```

Exactly one match. No duplicates.

### 1b. The reservation

```sql
select r.id as reservation_id, r.tenant_id, r.reservation_number, r.status, r.check_in, r.check_out,
       r.created_at, r.updated_at, r.channel_connection_id, r.external_booking_id,
       r.external_revision_id, r.ota_reservation_code, r.ota_name, r.external_booked_at,
       r.booking_origin, r.cancelled_at, r.cancelled_by_type, r.cancellation_origin,
       r.cancellation_reason, r.external_cancellation_requested_at,
       r.external_cancellation_confirmed_at, r.no_show_reported_at, r.is_test,
       g.full_name, li.label as source_label
from guesthub.reservations r
left join guesthub.guests g on g.id = r.primary_guest_id
left join guesthub.lookup_items li on li.id = r.source_id
where r.primary_guest_id = '1335e46e-93a3-4907-9d4a-9993564dbd3f';
```

```
-[ RECORD 1 ]----------------------+-------------------------------------
reservation_id                     | ac0abf43-0b80-4863-bcf3-e709880825f8
tenant_id                          | 68139d06-58c4-4043-b256-4691f83e1556
reservation_number                 | 1026
status                             | confirmed
check_in                           | 2026-07-28
check_out                          | 2026-07-29
created_at                         | 2026-07-24 08:52:12.379699+00
updated_at                         | 2026-07-24 08:52:12.379699+00
channel_connection_id              | 8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8
external_booking_id                | 90359426
external_revision_id               | 90359426:2026-07-24T08:50:35Z
external_unique_id                 |
ota_reservation_code               | 6244501220
ota_name                           | booking
external_booked_at                 | 2026-07-24 08:50:34+00
booking_origin                     | ota
cancelled_at                       |
cancelled_by_type                  |
cancellation_origin                |
cancellation_reason                |
external_cancellation_requested_at |
external_cancellation_confirmed_at |
no_show_reported_at                |
is_test                            | f
full_name                          | Moti Grosman
source_label                       | Booking.com
```

Exactly one match. `updated_at == created_at` — the row has never been modified since import.

### 1c. The room it holds

`occupies_room` is `reservation_rooms.is_blocking` in this schema (maintained by trigger
`trg_rr_set_blocking` + `trg_res_propagate_blocking`, enforced by the GIST exclusion
constraint `rr_no_double_booking`). There is no `checked_in` column — check-in is the
reservation `status` value `checked_in`; this reservation is `confirmed`, i.e. **not** checked in.

```sql
select rr.id as res_room_id, rr.room_id, rm.name as room_name, rm.room_number,
       rr.check_in, rr.check_out, rr.is_blocking, rr.created_at, rr.updated_at
from guesthub.reservation_rooms rr left join guesthub.rooms rm on rm.id = rr.room_id
where rr.reservation_id = 'ac0abf43-0b80-4863-bcf3-e709880825f8';
```

```
             res_room_id              |               room_id                |            room_name              | room_number |  check_in  | check_out  | is_blocking |          created_at           |          updated_at
--------------------------------------+--------------------------------------+-----------------------------------+-------------+------------+------------+-------------+-------------------------------+-------------------------------
 dd51a99e-1d67-4228-a82d-9f17b5e5d202 | 2149bbb4-1db6-422c-a113-9f5e8b279ce1 | Studio Delux with Sea View - 1130 | 1130        | 2026-07-28 | 2026-07-29 | t           | 2026-07-24 08:52:12.379699+00 | 2026-07-24 08:52:12.379699+00
```

**Summary line for STEP 1:**

| field | value |
|---|---|
| reservation_id | `ac0abf43-0b80-4863-bcf3-e709880825f8` (number **1026**) |
| Beds24 id | **90359426** (OTA code 6244501220, Booking.com) |
| room | **1130** — Studio Delux with Sea View (`2149bbb4-1db6-422c-a113-9f5e8b279ce1`) |
| stay | 2026-07-28 → 2026-07-29 |
| local status | **confirmed** |
| occupies_room (`is_blocking`) | **true** |
| checked_in | **false** (status is `confirmed`, not `checked_in`) |
| created_at / updated_at | both `2026-07-24 08:52:12.379699+00` — never touched since import |

### 1d. Direct GET from Beds24 by id — THE DECIDING EVIDENCE

`GET /bookings?id=90359426&includeGuests=true` → HTTP 200, `success=true`, 1 row:

```json
{
  "id": 90359426,
  "status": "new",
  "subStatus": "none",
  "statusCode": 0,
  "propertyId": 342449,
  "roomId": 707495,
  "unitId": 1,
  "arrival": "2026-07-28",
  "departure": "2026-07-29",
  "bookingTime": "2026-07-24T08:50:34Z",
  "modifiedTime": "2026-07-24T08:50:35Z",
  "cancelTime": null,
  "apiReference": "6244501220",
  "apiSource": "Booking.com",
  "referer": "Booking.com",
  "channel": "booking",
  "firstName": "Moti",
  "lastName": "Grosman",
  "price": 488
}
```

- **status at source: `new`** — a live status. Not `cancelled`.
- **modifiedTime: `2026-07-24T08:50:35Z`** — identical to the value captured at import 24 hours ago.
  Beds24 re-stamps `modifiedTime` on every upstream edit. It has not moved. **Beds24 has recorded
  no change to this booking since the moment it was created.**
- **actual cancellation date: none exists.** `cancelTime` is `null`.

`GET /inventory/rooms/calendar?roomId=707495&startDate=2026-07-28&endDate=2026-07-29` → HTTP 200:

```json
{"roomId": 707495, "propertyId": 342449, "name": "1130",
 "calendar": [{"from":"2026-07-28","to":"2026-07-28","numAvail":0,"price1":610},
              {"from":"2026-07-29","to":"2026-07-29","numAvail":1,"price1":610}]}
```

**numAvail = 0 on 2026-07-28** (the one occupied night) and 1 on the departure night —
Beds24 also still considers the room sold. Source and local agree completely.

Every booking Beds24 holds on room 707495 for arrivals 2026-07-20 → 2026-08-05, all six statuses:

```
  id=90359426 status=new sub=none 2026-07-28..2026-07-29 modified=2026-07-24T08:50:35Z cancelTime=null Moti Grosman src=Booking.com
```

One row. No cancelled twin.

### 1e. CLASSIFICATION

| candidate | requires | actual | verdict |
|---|---|---|---|
| **STATE A** — ingestion failure | local status active **AND** source cancelled | local `confirmed` ✔, source `new` ✘ | **NO** |
| **STATE B** — partial `applyCancellation` | local status `cancelled` **AND** room still held | local `confirmed` ✘ | **NO** |
| **NEITHER** — source is not cancelled | local active **AND** source active | both true | **YES** |

**Classification: NEITHER STATE A NOR STATE B.**
Local state and source state are *consistent*. The cancellation the guest performed on Booking.com
**never propagated Booking.com → Beds24**. GuestHub's only source of truth is Beds24, and Beds24
still says this booking is live. There is no defect in the GuestHub inbound path for this booking:
there was nothing to ingest.

---

## STEP 2 — WHERE the hold lives (three layers checked independently)

### 2a. status + occupies_room in the DB — HELD

`reservations.status = 'confirmed'`, `reservation_rooms.is_blocking = true` (printed in 1b/1c).

### 2b. Actual inventory hold — HELD (and correctly so)

`check_room_availability` run for the exact room and dates, with no exclusion:

```sql
select ca.room_id, rm.room_number, ca.conflict_kind, ca.conflict_id, ca.conflict_from, ca.conflict_to
from guesthub.check_room_availability(
  '68139d06-58c4-4043-b256-4691f83e1556'::uuid,
  ARRAY['2149bbb4-1db6-422c-a113-9f5e8b279ce1']::uuid[],
  '2026-07-28'::date, '2026-07-29'::date) ca
join guesthub.rooms rm on rm.id = ca.room_id;
```

```
               room_id                | room_number | conflict_kind |             conflict_id              | conflict_from | conflict_to
--------------------------------------+-------------+---------------+--------------------------------------+---------------+-------------
 2149bbb4-1db6-422c-a113-9f5e8b279ce1 | 1130        | reservation   | dd51a99e-1d67-4228-a82d-9f17b5e5d202 | 2026-07-28    | 2026-07-29
```

One conflict, and it is this reservation's own `reservation_rooms` row.

`sellable_unit_inventory` over the window:

```
           sellable_unit_id           |               name                |    day     | total_rooms | sellable_rooms | occupied_rooms | closed_rooms | availability
--------------------------------------+-----------------------------------+------------+-------------+----------------+----------------+--------------+--------------
 81472ca4-6a22-409d-9185-f748b4dc3b28 | Studio Delux with Sea View - 1130 | 2026-07-27 |           1 |              1 |              0 |            0 |            1
 81472ca4-6a22-409d-9185-f748b4dc3b28 | Studio Delux with Sea View - 1130 | 2026-07-28 |           1 |              1 |              1 |            0 |            0
 81472ca4-6a22-409d-9185-f748b4dc3b28 | Studio Delux with Sea View - 1130 | 2026-07-29 |           1 |              1 |              0 |            0 |            1
```

`channel_dirty_ranges` for room 1130 — the two ranges the import created on 2026-07-24 08:52:12:

```
                  id                  |     kind     | date_from  |  date_to   | status  | revision |               room_id                | attempts | last_error_code |          created_at           |          updated_at
--------------------------------------+--------------+------------+------------+---------+----------+--------------------------------------+----------+-----------------+-------------------------------+-------------------------------
 847bc084-bed2-4d79-88a3-71630adb92f9 | availability | 2026-07-24 | 2026-07-29 | pending |     1719 | 2149bbb4-1db6-422c-a113-9f5e8b279ce1 |        0 |                 | 2026-07-24 08:52:12.379699+00 | 2026-07-24 08:52:12.379699+00
 db46d4dc-f7ea-444c-a5f9-036cae975827 | availability | 2026-07-28 | 2026-07-29 | synced  |     1720 | 2149bbb4-1db6-422c-a113-9f5e8b279ce1 |        0 |                 | 2026-07-24 08:52:12.379699+00 | 2026-07-24 08:52:12.548167+00 |
```

The `pending` row `847bc084` belongs to the **paused Channex connection**, not to Beds24 — see the
breakdown below. The Beds24 range `db46d4dc` synced within 170 ms. No stuck Beds24 range, no error code.

```sql
select d.connection_id, c.provider, c.state, d.status, count(*), max(d.updated_at) as last_touch
from guesthub.channel_dirty_ranges d join guesthub.channel_connections c on c.id = d.connection_id
group by 1,2,3,4 order by 2,4;
```

```
            connection_id             | provider | state  | status  | count |          last_touch
--------------------------------------+----------+--------+---------+-------+-------------------------------
 8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8 | beds24   | active | synced  |   541 | 2026-07-25 10:10:06.644501+00
 5e6dba4e-339e-4ab8-bfb0-d37d96b6d8a8 | channex  | paused | pending |    66 | 2026-07-24 08:52:12.379699+00
```

**Every single Beds24 dirty range is `synced` — 541 of 541, zero pending, zero failed.**
All 66 `pending` rows belong to the decommissioned Channex connection (see "Stale artefacts" below).

### 2c. Calendar read-model — HELD (consistent with 2a/2b)

The `stays` query from `src/app/(dashboard)/calendar/data.ts:60-83`, run verbatim for the window:

```sql
SELECT rr.id AS rr_id, rr.reservation_id, rm.room_number,
       rr.check_in::text, rr.check_out::text, res.status, res.reservation_number,
       COALESCE(NULLIF(TRIM(CONCAT(rr.guest_first_name,' ',rr.guest_last_name)),''), g.full_name,'אורח') AS guest_name,
       src.key AS source_key
FROM guesthub.reservation_rooms rr
JOIN guesthub.reservations res ON res.id = rr.reservation_id
JOIN guesthub.rooms rm ON rm.id = rr.room_id
LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id
LEFT JOIN guesthub.lookup_items src ON src.id = res.source_id
WHERE rr.tenant_id = '68139d06-58c4-4043-b256-4691f83e1556'
  AND rr.room_id = '2149bbb4-1db6-422c-a113-9f5e8b279ce1'
  AND rr.check_in < '2026-07-30' AND rr.check_out >= '2026-07-27'
  AND res.status <> 'cancelled'
ORDER BY rr.check_in;
```

```
                rr_id                 |            reservation_id            | room_number |  check_in  | check_out  |  status   | reservation_number |  guest_name  | source_key
--------------------------------------+--------------------------------------+-------------+------------+------------+-----------+--------------------+--------------+-------------
 dd51a99e-1d67-4228-a82d-9f17b5e5d202 | ac0abf43-0b80-4863-bcf3-e709880825f8 | 1130        | 2026-07-28 | 2026-07-29 | confirmed | 1026               | Moti Grosman | booking_com
```

Supporting layers, both empty (nothing else contributes to the drawn hold):

```
=== channel_inventory_holds (active) ===   (0 rows)
=== room_closures for room 1130 ===        (0 rows)
```

**Verdict for STEP 2:** all three layers are *in agreement*. This is **not** a D92-class display
artefact — (b) is not clean, it genuinely holds, and it holds because Beds24 says the room is sold.

---

## STEP 3 — WHY the normal path "missed" it (it did not miss it)

### 3a. MAPPING — the leading suspect is CLEARED

`runBeds24InboundPull` bails at `mappings.size === 0` before importing anything
(`src/lib/channel/beds24-booking-import.ts:440-445`). Room 1130 is mapped, and so is every other
Beds24 room:

```sql
select m.id, m.room_id, rm.room_number, m.beds24_property_id, m.beds24_room_id,
       m.beds24_room_name, m.status, m.created_at
from guesthub.channel_beds24_room_mappings m left join guesthub.rooms rm on rm.id = m.room_id
where rm.room_number = '1130';
```

```
                  id                  |               room_id                | room_number | beds24_property_id | beds24_room_id |         beds24_room_name         | status |          created_at
--------------------------------------+--------------------------------------+-------------+--------------------+----------------+----------------------------------+--------+-------------------------------
 7abbbf56-1ff1-442e-8aa0-9a8b95887afc | 2149bbb4-1db6-422c-a113-9f5e8b279ce1 | 1130        | 342449             | 707495         | Deluxe Double Room with Bath     | mapped | 2026-07-19 23:44:18.566128+00
```

Live mapping present, `status = 'mapped'`, `beds24_room_id = 707495` — exactly the `roomId` the live
Beds24 payload carries. Mapping status histogram across the whole connection:

```
            connection_id             | status | count
--------------------------------------+--------+-------
 8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8 | mapped |    14
```

14 mapped, 0 unmapped, 0 quarantined. Cross-checked against the source —
`GET /properties?includeAllRooms=true` returns **one** property with **14** rooms, and every one of
them has a local mapping:

```
  property 342449 "מגדל הים - בניין אלמוג" rooms=14
    beds24 room 707484 "1238" MAPPED     beds24 room 707485 "926"  MAPPED
    beds24 room 707486 "1142" MAPPED     beds24 room 707487 "1042" MAPPED
    beds24 room 707488 "1242" MAPPED     beds24 room 707489 "1237" MAPPED
    beds24 room 707490 "1329" MAPPED     beds24 room 707491 "1006" MAPPED
    beds24 room 707492 "1424" MAPPED     beds24 room 707493 "1235" MAPPED
    beds24 room 707494 "1245" MAPPED     beds24 room 707495 "1130" MAPPED
    beds24 room 707496 "1102" MAPPED     beds24 room 707497 "1131" MAPPED
```

**Not the root cause.** The inbound path for room 1130 — and for every room Beds24 knows about — is live.

### 3b. REVISIONS — one revision, imported, and correctly no second one

```sql
select id, provider_booking_id, provider_revision_id, revision_kind, raw_status, import_status,
       ack_status, attempts, mapping_error, local_reservation_id, created_at, updated_at
from guesthub.channel_booking_revisions where provider_booking_id = '90359426' order by created_at;
```

```
                  id                  | provider_booking_id |     provider_revision_id      | revision_kind | raw_status | import_status |  ack_status  | attempts | mapping_error |         local_reservation_id         |          created_at          |          updated_at
--------------------------------------+---------------------+-------------------------------+---------------+------------+---------------+--------------+----------+---------------+--------------------------------------+------------------------------+-------------------------------
 30811b5c-04d2-4ce9-9b8f-60dc3a242d52 | 90359426            | 90359426:2026-07-24T08:50:35Z | new           | new        | imported      | acknowledged |        0 |               | ac0abf43-0b80-4863-bcf3-e709880825f8 | 2026-07-24 08:52:12.37574+00 | 2026-07-24 08:52:12.379699+00
```

One revision, kind `new`, `import_status = imported`, no `mapping_error`, 0 attempts, linked to the
reservation. **There is no cancelled revision — and there should not be one**, because Beds24 never
produced a cancelled version of this booking. `applyCancellation` was never reached because nothing
ever asked it to run.

The stored payload confirms the source state at import time was already what it is now:

```json
{"id":90359426,"status":"new","subStatus":"none","propertyId":342449,"roomId":707495,
 "arrival":"2026-07-28","departure":"2026-07-29","bookingTime":"2026-07-24T08:50:34Z",
 "modifiedTime":"2026-07-24T08:50:35Z","cancelTime":null,"apiReference":"6244501220",
 "apiSource":"Booking.com","channel":"booking","firstName":"Moti","lastName":"Grosman","price":488}
```

### 3c. ROUTES — every route ran, and each returned the correct answer

The channel worker is running the post-D93 build. PR #102 merged `2026-07-25 00:01:22 +0300`
(= `2026-07-24 21:01:22 UTC`); `guesthub-channel-worker` (pid 580469, cwd `/var/www/guesthub`)
started `2026-07-24T21:02:25.692Z` — 63 seconds after the merge. The explicit status filter and the
reconciliation loop are live in production.

```
guesthub                | pid 580229 | online | uptime_start 2026-07-24T21:02:22.509Z | restarts 41
guesthub-channel-worker | pid 580469 | online | uptime_start 2026-07-24T21:02:25.692Z | restarts 13 | script /var/www/guesthub/scripts/channel-worker.cjs
```

| route | ran in the window? | what it returned |
|---|---|---|
| **poll window** (5-min incremental, `modifiedFrom = now-7d`) | **YES**, every 5 minutes without a gap — `pull_booking_revisions` `succeeded` at 10:51:57, 10:46:56, 10:41:54, 10:36:53, 10:31:52, 10:26:50, 10:21:49 … all with `attempts=1`, `last_error_code` empty | fetched the booking, computed the same synthetic revision id, `ON CONFLICT DO NOTHING` → 0 inserts. Correct no-op. |
| **first-run backfill** (arrival window) | **NO** — gated on `conn.last_inbound_import_at === null`; it is `2026-07-24 20:32:40.124209+00` | not applicable; nothing to backfill |
| **convergence sweep** (`sweepUnimportedRows`) | **YES**, on every pull | selects `import_status IN ('pending','quarantined','failed')`; this booking's only revision is `imported`, so it is not selected. Correct. |
| **targeted pull** (`payload.booking_id`) | **NO** — never enqueued for this booking (all `pull_booking_revisions` rows carry `payload = {}`) | n/a |
| **reconciliation** (20-min) | **YES** — `reconcile_inventory` `succeeded` at 10:45:55, 10:25:50, 10:05:47, 09:45:42, 09:25:39, 09:05:34, 08:45:29 … | selected this reservation, did the live GET, saw `status = "new"`, and correctly did **not** release. See 3d. |

Proof the poll actually reaches this booking — the exact filter `runBeds24InboundPull` builds,
reproduced from `BEDS24_STATUS_FILTER` + `LOOKBACK_DAYS` and executed live:

```
/bookings?propertyId=342449&status=confirmed&status=new&status=request&status=cancelled&status=black&status=inquiry&modifiedFrom=2026-07-18T10%3A58%3A27&includeGuests=true&includeInvoiceItems=true&page=1

HTTP 200 success=true rows=5
  id=90381357 status=new       modified=2026-07-24T19:27:49Z -> synthetic revision id "90381357:2026-07-24T19:27:49Z"
  id=90359426 status=new       modified=2026-07-24T08:50:35Z -> synthetic revision id "90359426:2026-07-24T08:50:35Z"
  id=90352557 status=cancelled modified=2026-07-24T18:48:30Z -> synthetic revision id "90352557:2026-07-24T18:48:30Z"
  id=90136306 status=confirmed modified=2026-07-23T18:07:26Z -> synthetic revision id "90136306:2026-07-23T18:07:26Z"
  id=90136305 status=confirmed modified=2026-07-23T18:07:25Z -> synthetic revision id "90136305:2026-07-23T18:07:25Z"

booking 90359426 IS INSIDE the poll window the worker walks every 5 minutes.
synthetic revision id from the LIVE payload : 90359426:2026-07-24T08:50:35Z
already stored in channel_booking_revisions : YES (import_status=imported)
```

The poll sees the booking every five minutes, with `status=cancelled` explicitly requested, and
correctly stores nothing new because the source revision has not changed.

**Control case — the pipeline demonstrably works.** In the same window, booking 90352557
(Oday Aramin, room 1329) *was* cancelled at source (`cancelTime = 2026-07-24T18:48:30Z`), and
reservation 1021 was released:

```
 reservation_number |     full_name      |  status   | external_booking_id |  check_in  | check_out  |         cancelled_at         | cancellation_origin | cancelled_by_type |          updated_at           | holds_room
--------------------+--------------------+-----------+---------------------+------------+------------+------------------------------+---------------------+-------------------+-------------------------------+------------
 1001               | Benjamin YAISH     | confirmed | 90136306            | 2026-09-06 | 2026-09-20 |                              |                     |                   | 2026-07-23 18:11:47.702459+00 | t
 1002               | Anastasya katzaran | confirmed | 90136305            | 2026-08-07 | 2026-08-08 |                              |                     |                   | 2026-07-23 18:11:47.737662+00 | t
 1021               | Oday Aramin        | cancelled | 90352557            | 2026-07-24 | 2026-07-25 | 2026-07-24 20:32:40.09919+00 | ota_revision        | ota               | 2026-07-24 20:32:40.09919+00  | f
 1026               | Moti Grosman       | confirmed | 90359426            | 2026-07-28 | 2026-07-29 |                              |                     |                   | 2026-07-24 08:52:12.379699+00 | t
 1027               | Aspinall Baha      | confirmed | 90381357            | 2026-07-24 | 2026-07-25 |                              |                     |                   | 2026-07-24 19:30:11.425054+00 | t
```

`holds_room = f` for 1021, `cancellation_origin = ota_revision`. When Beds24 *does* carry a
cancellation, the room is freed. The difference for 1026 is entirely upstream.

### 3d. D94 PATTERN — the reconcile query, run verbatim

From `src/lib/channel/beds24-booking-import.ts:551-562`:

```sql
SELECT id, reservation_number, status, external_booking_id, check_in, check_out
FROM guesthub.reservations
WHERE tenant_id = '68139d06-58c4-4043-b256-4691f83e1556'
  AND channel_connection_id = '8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8'
  AND external_booking_id IS NOT NULL
  AND status IN ('confirmed', 'checked_in')
  AND check_out >= CURRENT_DATE
ORDER BY check_in
LIMIT 50;
```

```
                  id                  | reservation_number |  status   | external_booking_id |  check_in  | check_out
--------------------------------------+--------------------+-----------+---------------------+------------+------------
 4c4f7bfe-0207-4f28-8fa8-9c2cdaf95707 | 1027               | confirmed | 90381357            | 2026-07-24 | 2026-07-25
 ac0abf43-0b80-4863-bcf3-e709880825f8 | 1026               | confirmed | 90359426            | 2026-07-28 | 2026-07-29
 33d29228-f86e-46d2-bb23-d1a306e5ef4a | 1002               | confirmed | 90136305            | 2026-08-07 | 2026-08-08
 cb19b054-8a3a-40df-b78d-4a314c920300 | 1001               | confirmed | 90136306            | 2026-09-06 | 2026-09-20
```

**The reservation IS selected.** No predicate excludes it. 4 rows returned, far below the
`RECONCILE_LIMIT = 50` bound, so the bounded-scan caveat does not apply either. Reconciliation
checks reservation 1026 every 20 minutes, does the live GET, reads `status: "new"`, and hits
`if (!source || source.rawStatus?.toLowerCase() !== "cancelled") continue;` — the guard at line 587
that deliberately refuses to treat anything but an explicit `cancelled` as a cancellation.
**This is the code behaving exactly as designed.** No D94-class predicate gap here.

### 3e. channel_sync_errors + audits — ZERO alerts, and zero is CORRECT here

`channel_sync_errors`, complete table (28 rows ever, none since 2026-07-24 05:47):

```
 total |              min              |              max
-------+-------------------------------+-------------------------------
    28 | 2026-07-20 11:54:48.963613+00 | 2026-07-24 05:47:27.831103+00
```

All 28 are `error_code = 'partial_warnings'` (`Beds24 דחה N ערכים: process inventory rooms calendar`)
on the ARI push path, all predating the incident window. **Zero `unmapped_room`, zero
`inbound_normalize_failed`, zero `cancelled_at_source_checked_in`, zero `cancellation_reconciled`
for this reservation or this room.**

`audit_logs` for the reservation, the room, the guest and the `reservation_rooms` row:

```
                  id                  | entity_type |              entity_id               |        action         |               user_id                |          created_at           |                          after
--------------------------------------+-------------+--------------------------------------+-----------------------+--------------------------------------+-------------------------------+----------------------------------------------------------
 2ddb0a3a-5444-4358-91db-bfc8db378e81 | reservation | ac0abf43-0b80-4863-bcf3-e709880825f8 | channel_import_create |                                      | 2026-07-24 08:52:12.379699+00 | {"rooms": 1, "total": 488, "check_in": "2026-07-28", ...
 91e90fe2-6965-43b5-bca8-396ae50b7697 | room        | 2149bbb4-1db6-422c-a113-9f5e8b279ce1 | update                | db214c1c-ad87-435e-a962-a31b09b1fec4 | 2026-07-09 05:26:38.324653+00 | {"langs": [], "status": "available", "room_number": "1130"}
 32d1531b-5196-4839-aff4-5cba4c312e32 | room        | 2149bbb4-1db6-422c-a113-9f5e8b279ce1 | update                | db214c1c-ad87-435e-a962-a31b09b1fec4 | 2026-07-08 18:54:45.195866+00 | {"langs": ["he"], "status": "available", "room_number": "1130"}
```

Exactly one audit for the reservation: the original `channel_import_create`. Nothing since.
`channel_external_changes` is empty (0 rows) — no date-change or modification record either.

**Interpretation.** Zero alerts is normally itself a finding. Here it is the *correct* outcome:
nothing failed, so nothing alerted. **But it is also the real gap.** GuestHub has no signal —
none at all — for "an OTA cancellation exists that the channel manager never delivered". That
failure mode is silent by construction, because every guard in the system is anchored to the Beds24
status and Beds24 is the thing that is stale. See "What is not covered" below.

---

## STEP 4 — SCOPE

### 4.1 — External reservations holding a room while the source says cancelled: **0**

Every externally-sourced reservation currently holding a room, each checked against a live
`GET /bookings?id=…`:

```
=== SCOPE 4.1 — 4 externally-sourced reservations currently HOLDING a room; live source status for each ===
  res 1027 (Aspinall Baha)      local=confirmed 2026-07-24..2026-07-25 beds24_id=90381357 SOURCE=new       cancelTime=null modified=2026-07-24T19:27:49Z
  res 1026 (Moti Grosman)       local=confirmed 2026-07-28..2026-07-29 beds24_id=90359426 SOURCE=new       cancelTime=null modified=2026-07-24T08:50:35Z
  res 1002 (Anastasya katzaran) local=confirmed 2026-08-07..2026-08-08 beds24_id=90136305 SOURCE=confirmed cancelTime=null modified=2026-07-23T18:07:25Z
  res 1001 (Benjamin YAISH)     local=confirmed 2026-09-06..2026-09-20 beds24_id=90136306 SOURCE=confirmed cancelTime=null modified=2026-07-23T18:07:26Z

SCOPE 4.1 RESULT: 0 reservation(s) hold a room while the source says cancelled (of 4 checked)
```

Cross-checked from the source side. Full account sweep, all six statuses, arrivals
2025-01-01 → 2027-12-31, paginated:

```
=== FULL SWEEP /bookings propertyId=342449 ALL statuses arrivals 2025-01-01..2027-12-31 -> 5 bookings ===
status histogram: {"new":2,"cancelled":1,"confirmed":2}

--- every CANCELLED booking at source ---
  id=90352557 room=707490 2026-07-24..2026-07-25 cancelTime=2026-07-24T18:48:30Z apiRef=6408882519 Oday Aramin

--- every record matching Grosman / Moti / apiRef 6244501220 / id 90359426 ---
  id=90359426 status=new sub=none room=707495 2026-07-28..2026-07-29 booked=2026-07-24T08:50:34Z modified=2026-07-24T08:50:35Z cancelTime=null apiRef=6244501220 Moti Grosman
  (1 matching record(s) — a cancellation would appear here as a second row or status=cancelled)
```

The entire Beds24 account holds 5 bookings. Exactly one is cancelled, and it is Oday Aramin —
already released locally (reservation 1021, `holds_room = f`). **There is no second Moti Grosman
record, no cancelled twin, no alternate id.** Booking.com's cancellation is not present at Beds24
in any form.

**SCOPE 4.1 = 0.**

### 4.2 — Rooms with no live mapping: **2**

```sql
select rm.id, rm.room_number, rm.name, rm.status, rm.is_active, rm.show_on_calendar,
       (select count(*) from guesthub.sellable_unit_rooms sur where sur.room_id = rm.id) as sellable_unit_links,
       (select count(*) from guesthub.reservation_rooms rr where rr.room_id = rm.id) as reservations_ever
from guesthub.rooms rm
where rm.tenant_id = '68139d06-58c4-4043-b256-4691f83e1556'
  and not exists (select 1 from guesthub.channel_beds24_room_mappings m
                  where m.room_id = rm.id
                    and m.connection_id = '8365fdc8-b8b6-4db3-9ca7-62db2f1d18e8'
                    and m.status = 'mapped')
order by rm.room_number;
```

```
                  id                  | room_number |    name    |  status   | is_active | show_on_calendar | sellable_unit_links | reservations_ever
--------------------------------------+-------------+------------+-----------+-----------+------------------+---------------------+-------------------
 6653f7e6-a58e-45d4-9e5e-4e775cff4067 | 1318        | 1318       | available | t         | t                |                   1 |                 2
 9569be80-c4fd-4291-b4a3-750887de78c7 | 2000        | חניה זמנית | available | t         | t                |                   1 |                 0
```

**SCOPE 4.2 = 2** — rooms **1318** and **2000** ("חניה זמנית" / temporary parking).

Qualification, so the number is not misread. Both are `is_active` and shown on the calendar, but
neither exists on the Beds24 side at all (the property has exactly 14 rooms, all of them mapped —
printed in 3a). Consequences, in both directions:

- **Inbound risk: none.** Beds24 has no room object for 1318 or 2000, so no inbound booking can ever
  reference them. Their inbound path is inert in the sense that it is unused, not in the sense that
  it is silently dropping revisions.
- **Outbound cross-contamination: none.** Each sits in its *own* dedicated sellable unit, sharing
  with no mapped room, so the "refuse rather than over-sell" hazard in `beds24-ari-projection.ts`
  cannot be triggered by them:

  ```
             sellable_unit_id           | unit_name  | room_number | room_name  | has_mapping
  --------------------------------------+------------+-------------+------------+-------------
   b4b9a377-289d-46d3-9317-51f4185f8843 | 1318       | 1318        | 1318       | f
   b7734491-4828-49d7-a7f8-a6a1a28d9877 | חניה זמנית | 2000        | חניה זמנית | f
  ```

- **Real cost: distribution, not overbooking.** Room 1318 is a genuine, sold room —

  ```
                    id                  | reservation_number |  status   | booking_origin | external_booking_id |  check_in  | check_out  | is_blocking
  --------------------------------------+--------------------+-----------+----------------+---------------------+------------+------------+-------------
   daaa6c51-db67-46b8-86fa-25faa5286371 | 1004               | confirmed | back_office    |                     | 2026-07-08 | 2026-07-31 | t
   532707ad-c661-41d3-a6f8-797442c8aaa5 | 1006               | confirmed | back_office    |                     | 2026-08-06 | 2026-08-14 | t
  ```

  — booked only through the back office, and its availability is never published to any OTA.
  Room 2000 is a parking pseudo-room and is almost certainly intentional.

**This triggers the run's HARD STOP (4.2 ≠ 0) and is Ronen's decision.** The recommendation, for
what it is worth: 2000 should be excluded from the "must be mapped" population by an explicit flag
rather than by accident, and 1318 should either be created in Beds24 and mapped, or explicitly
marked non-distributed. Today the difference between "deliberately not sold online" and "silently
missing from the channel" is not representable in the data model — which is why this number can
only be interpreted by a human.

---

## STEP 5 — REPAIR: **NOT PERFORMED**, by rule

The STEP 5 conditional is explicit: *"the STEP 1 GET must confirm the source is cancelled.
Not confirmed → DO NOT TOUCH; that is a room that could be double-sold."*

The STEP 1 GET confirms the opposite. `status: "new"`, `cancelTime: null`, `numAvail: 0` at the
source for the occupied night. **No targeted pull was enqueued. No escape hatch was used. No
manual release. No DB write of any kind was performed during this diagnosis.**

Why a targeted pull would have been the wrong action here, concretely: `runBeds24InboundPull(db,
conn, { bookingId: "90359426" })` fetches by id, computes the synthetic revision id
`90359426:2026-07-24T08:50:35Z`, finds it already present, and inserts nothing
(`ON CONFLICT (connection_id, provider_revision_id) DO NOTHING`). It would be a no-op that produced
a misleading "we tried the canonical route and it didn't work" data point. The route is not broken;
there is simply nothing upstream to pull.

STATE-A-style repair is only correct once Beds24 actually carries the cancellation. Since scope 4.1
is **0**, there is no other case to handle by that route either.

The three mandatory post-release verifications (`check_room_availability` → zero conflicts,
`numAvail: 1` on a live read, an audit row + a cancelled revision with the real `modifiedTime`)
were **not** run, because no release was performed. Recording that explicitly rather than reporting
a vacuous pass.

### What should actually happen next (operator action, not code)

The defect is in the Booking.com → Beds24 leg. The correct remediation is out of GuestHub's reach
and belongs to whoever holds the Beds24 and Booking.com extranet accounts:

1. Confirm in the **Booking.com extranet** that reservation `6244501220` is in fact cancelled there,
   and capture the cancellation timestamp.
2. If it is, this is a Booking.com→Beds24 delivery failure. Re-trigger delivery from the Beds24 side
   (Beds24's channel-log / re-fetch for the Booking.com connection), or raise it with Beds24 support
   with booking id `90359426` and OTA reference `6244501220`.
3. Once Beds24 shows `status: cancelled`, **no manual GuestHub action is needed at all** — the
   existing 5-minute poll will see the new `modifiedTime`, insert a new revision, and
   `applyCancellation` will release the room. Reservation 1021 is the proof that this works
   end-to-end.
4. Only if the room must be freed *before* Beds24 catches up should the supervised escape hatch be
   used — and that is a decision for Ronen, because until Beds24 agrees the room is free, releasing
   it locally means the room is sellable in GuestHub while Beds24 still holds it at `numAvail: 0`.

---

## Coverage: is the root cause addressed by an open branch?

| open work | what it covers | does it cover this incident? |
|---|---|---|
| **PR #112** `fix/beds24-checkin-cancellation-guard` (D93 gate on every inbound route; touches `beds24-booking-import.ts`, `booking-import.ts`, `inventory-rules.ts`, `inventory.ts`, `reservations/actions.ts`) | An *ingested* cancellation must not auto-release a guest who is physically `checked_in` | **NO.** Two reasons: there is no ingested cancellation, and reservation 1026 is `confirmed`, not `checked_in`. Orthogonal. *(No file belonging to this branch was touched by this diagnosis.)* |
| **PR #106** `night/p0-3-ari-readback` (D95 — `GET /inventory/rooms/calendar` diffed against our projection, detect-only) | GuestHub's ARI projection vs what Beds24 actually holds | **NO.** It compares *us* to *Beds24*. Here we and Beds24 already agree perfectly (`numAvail: 0` matches `is_blocking = true`). The divergence is Booking.com vs Beds24, one hop further upstream, which no read-back of Beds24's own calendar can see. |
| **PR #102 / D93** (merged, deployed) — explicit `status=cancelled` filter + 20-min booking reconciliation | Cancellations that *reach* Beds24 but never reach us | **Working correctly, and proven so** by reservation 1021 in the same window. It cannot help when Beds24 itself never learns of the cancellation. |
| **PR #110** `night/p2-2-booking-com-reports` (D96) | *Outbound* status reports to Booking.com | **NO.** Wrong direction. |
| mapping work | rooms without a live mapping | Only relevant to scope 4.2 (rooms 1318 / 2000), not to this incident — room 1130 is fully mapped. |

### What is needed that nothing currently covers

1. **A cross-check against the OTA itself, not just against the channel manager.** Every existing
   guard treats Beds24 as ground truth. This incident is the class of failure where *Beds24 is the
   stale party*. Detecting it requires either (a) reading the Booking.com extranet / a
   Booking.com-side reservation feed and diffing it against Beds24, or (b) Beds24 exposing a
   channel-delivery log we can poll for undelivered messages. Both are new integrations and both
   need scoping and credentials decisions. **This is the actual root-cause gap.**
2. **A staleness signal.** Nothing today notices that a booking arriving in 6 days has had zero
   upstream activity, or that a whole connection has gone quiet. Cheap partial mitigation: alert
   when a near-arrival OTA booking's `modifiedTime` has not moved *and* the guest has not confirmed —
   weak, but it would have surfaced this as a question instead of a surprise at check-in.
3. **`last_reconciliation_at` is never written.** The column is read and displayed in the channels UI
   (`src/app/(dashboard)/channels/page.tsx:215`, label "התאמה אחרונה") and selected in
   `src/lib/channel/admin.ts:41`, but `grep -rn "last_reconciliation_at" src/ scripts/ db/` finds no
   `UPDATE` anywhere. The Beds24 connection row shows `last_reconciliation_at = NULL` even though
   `reconcile_inventory` has succeeded every 20 minutes for the last day. **An operator looking at
   the channels screen right now sees "never reconciled" for a loop that is running fine** — the one
   dashboard signal that should have let a human check this quickly is dead. Small, self-contained,
   worth its own PR.

---

## Stale artefacts observed (Iron Rule 14) — recorded, not acted on

Nothing in this task's text was stale. These are live-environment observations for Ronen; no code,
config, `DECISIONS.md` entry or DB row was changed for any of them.

- **Decommissioned provider rows are still present and still accumulating debt.**
  `channel_connections` holds three rows: the live `beds24` one, plus `channex` (`state = paused`,
  `environment = staging`, `is_active_provider = f`) and `hospitable` (`paused`, `is_active_provider = f`) —
  both deleted per D91/#97. The Channex row still owns **66 `pending` `channel_dirty_ranges`** that
  can never drain (its connection is not drainable), and they pollute any global "are there stuck
  ranges?" query — as they did in STEP 2b above, where the range covering the exact Moti stay window
  looked alarming until it was traced to Channex. Recommend a follow-up to archive or delete these
  dead rows. **Not done here** (Iron Rule 8 — never delete DB rows).
- **A pm2 process named `pms` is running** (pid 1043467, cwd `/var/www/pms`, script `/usr/bin/npm`).
  It belongs to a different application, not to GuestHub, and was not touched. Flagged only because
  Iron Rule 14 names it as a stale-instruction marker.

---

## Method notes

- All Beds24 reads were `GET` only: `/bookings` (by id, by room+arrival window, by the verbatim
  production poll filter, and a full paginated account sweep), `/inventory/rooms/calendar`,
  `/properties`. No `POST`, no write of any kind.
- Auth reused the canonical path: the cached 24 h access token from
  `channel_connections.access_token_ciphertext`, decrypted with `CHANNEL_SECRETS_KEY` exactly as
  `src/lib/channel/crypto.ts` does, sent in the `token` header per `src/lib/channel/beds24-http.ts`.
  The refresh token was never used and no token was ever minted, logged or printed. The Beds24 token
  and its scopes were not modified.
- Diagnostic scripts were written to the session scratchpad, never into the repository or into
  `/var/www/guesthub`.
- `/var/www/guesthub` was read only (`.env.local` variable *names* and the `DATABASE_URL` host/port,
  never its value). Nothing was built, deployed or restarted.
- Every query in this document is `tenant_id`-scoped or scoped by an id belonging to
  tenant `68139d06-58c4-4043-b256-4691f83e1556`.
