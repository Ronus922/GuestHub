# 05 — Live Screenshare Demo Script

**Rule (Channex):** *"If the Channex call doesn't fire from your real update path, you
don't pass."* Every action below is driven from a production PMS surface (`/rates`,
`/reservations`, `/channels`) — there is **no certification-only UI**, and
`check:channex-ari` proves at source level that no other module can send ARI.

**Two tabs:** (A) the operator surface being demonstrated; (B) `/channels` → the
read-only **certification console** (evidence ledger) where Task IDs appear live.
For each action: perform the save in tab A → refresh tab B → point at the new evidence
row (scenario, request count vs expected, Task IDs, firing file + function).

> הערת מנחה: לפני כל צעד — הראה את ה-dirty range מופיע, ה-job בתור, וה-Task ID נוחת
> בקונסולה. תמיד תבצע Group Update אחד לכל תרחיש כדי שתצא **קריאה אחת**.

---

## 0 · Setup (before the call)

- Certification tenant logged in as `super_admin`; `/channels` shows the Staging
  connection **active**, property mapped, rooms + rate plans mapped.
- Console header shows `סביבה פעילה: staging`, `production כבוי (guard)`.
- Optional: a terminal tailing the PM2 channel worker for the queue view.

---

## Scenarios 1–11

Each row: **UI path → user action → expected Channex API call(s) → firing file + function**
(every file+function grep-verified in this codebase).

### 1 · Full Sync (500 days)
- **UI path:** `/channels` → button **"סנכרון מלא"** (`AriSyncSection.tsx:235`).
- **Action:** click Full Sync; watch phased progress.
- **Expected calls:** **exactly 2** — one `POST /availability`, one rates+restrictions — over 500 property-local dates.
- **Fires:** `admin.ts:305 requestFullSyncAction` → `ari-sync.ts:312 runInitialFullSync` → `ari-sync.ts:214 sendBatches` → `channex-ari.ts:85 pushAri`. Ledger key `full_sync`.

### 2 · Single date, single rate
- **UI path:** `/rates` → edit one cell → save.
- **Expected calls:** 1 (`POST /restrictions`).
- **Fires:** `rates/actions.ts` → `lib/rates/service.ts markAriDirty` → `ari-sync.ts:618 drainAriDirtyRanges` → `ari-projection.ts:206 projectAri` → `ari-payloads.ts:184 buildRestrictionValues` → `channex-ari.ts:85 pushAri`. Ledger key `incremental_sync`.

### 3 · Single dates, multiple rates
- **UI path:** `/rates` → **Group Update** (3 room×plan combos) → one save.
- **Expected calls:** **1 batched**.
- **Fires:** same drain path; one combined restrictions call.

### 4 · Date ranges, multiple rates
- **UI path:** `/rates` → Group Update with a **date range** (D93 datepicker).
- **Expected calls:** 1 (ranges compressed to `[from,to)`).
- **Fires:** same drain path.

### 5 · Min Stay
- **UI path:** `/rates` → set **min-stay** fields → Group Update.
- **Expected calls:** 1. `min_stay_arrival` primary (floored by plan default); `min_stay_through` sent only if set.
- **Fires:** same drain path; `projectAri` resolves both, `buildRestrictionValues` emits each only when non-null.

### 6 · Stop Sell
- **UI path:** `/rates` → **sale-state close** → Group Update.
- **Expected calls:** 1 (every value carries `stop_sell`).
- **Fires:** same drain path.

### 7 · Combined restrictions (CTA/CTD/min/max)
- **UI path:** `/rates` → Group Update mixing **CTA / CTD / min-stay / max-stay** over ranges.
- **Expected calls:** 1.
- **Fires:** same drain path.

### 8 · Half-year update
- **UI path:** `/rates` → Group Update over **~180 days**.
- **Expected calls:** 1 (long range compresses; still one message, 10 MB payload cap).
- **Fires:** same drain path.

### 9 · Single-date availability (via booking)
- **UI path:** `/reservations` → create / edit / cancel a reservation on a mapped room.
- **Expected calls:** 1–2 `POST /availability` (0/1 single-unit model).
- **Fires:** `reservations/actions.ts markAriDirty(availability)` → `ari-sync.ts:618 drainAriDirtyRanges` → `channex-ari.ts:85 pushAri`. Ledger key `incremental_sync` (availability).

### 10 · Multi-date availability
- **UI path:** `/reservations` → **multi-night** reservation / closure, then cancel (room re-opens).
- **Expected calls:** 1–2 (consecutive days compressed).
- **Fires:** same as 9.

### 11 · Booking receiving (new / modify / cancel + ACK)
- **UI path (inbound):** trigger a Booking.com test revision (preferred) or the **Booking CRS** injector; watch `/channels` console + the reservation appear in `/reservations`.
- **Expected behaviour:** revision imported in one transaction; **ACK sent only after commit**; redelivery → zero duplicates.
- **Fires:** `webhook/[token]` → worker `runInboundPull` → `booking-import.ts` → `channex-bookings.ts:125 acknowledgeBookingRevision` (gated by `revisions.ts:247 markRevisionAcknowledged`, `import_status='imported'` WHERE clause). Ledger keys `inbound_new` / `inbound_modify` / `inbound_cancel` / `booking_ack`.

---

## Queue / retry / mapping talking points

- **Queue:** show a dirty range → queued job → worker drain → `synced`. FIFO per connection; duplicate enqueue is a DB no-op.
- **Retry / rate-limit:** a 429 opens the **circuit breaker** for the provider's `Retry-After`; ranges stay pending and drain after (`circuit-breaker.ts`; `check:channex-rate-limit-cooldown`).
- **Mapping:** `/channels` room-type + rate-plan mapping — physical room → one Channex Room Type (`count_of_rooms = 1`); local `plan × room` → one Channex Rate Plan.
- **One seam:** `check:channex-ari` forbids any other module from sending ARI.

---

## Closing · Ad-hoc changes readiness

Invite the reviewer to name **any** room, plan, date range and value. Perform it in
`/rates` Group Update or a reservation:

> "This is an arbitrary value you just chose — watch it fire from the same path."

The same evidence row appears with **their** value's Task ID. This proves values
propagate from the **database**, not from any documented test constant:

- Nothing is hardcoded to the test values. `projectAri` reads canonical
  `pricing_plan_rates` / availability rows from the DB — the value the operator types is
  the value Channex receives (no hidden remapping; `ari-payloads.ts` includes each field
  only when non-null).
- `check:channex-certification` asserts the arbitrary-value capability (Group Update
  drives calls from operator input) and that no test-only bypass exists in the send path
  (only the `fetchImpl` seam).
- `check:channex-ari` (47 assertions) proves the single send seam and that incremental
  ARI is structurally impossible before a clean initial Full Sync.

> הערת מנחה: אם קריאה נכשלת חי — הראה אותה נוחתת כשורת `failed`/`partial` בלדג'ר וה-range
> נשאר להישלח שוב. יושר הוא חלק מהמעבר.
