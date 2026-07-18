# GuestHub — Domain Inventory (Audit §7)

- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** all migrations `db/migrations/000–036` (read in full), live introspection of the read-only snapshot DB `guesthub_stage1_restore` (information_schema / pg_catalog), and `grep` of `src/` for code ownership.
- **Scope:** the single `guesthub` schema — 60 base tables, 11 functions, ~60 triggers (mostly `set_updated_at`), 0 RLS policies (isolation is server-side by design, see §1).

---

## 1. Architecture of the schema

- **One isolated schema** (`guesthub`), created by `000_init_schema.sql`. Access is exclusively through the app's `porsager/postgres` connection (owner role). `anon`/`authenticated` are fully REVOKEd; PostgREST never sees the schema. **There is no RLS** — tenant isolation is enforced only in server code (`actor.tenantId` on every query).
- **Multi-tenant by column:** every business table carries `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` + an index. Only the newest tables (026 `sellable_unit_rooms`, 036 communications suite) add **composite tenant-safe FKs** (`(tenant_id, x_id) REFERENCES parent(tenant_id, id)`); all older child tables rely on app discipline.
- **`updated_at`** is maintained by a generic `set_updated_at()` (000) / `touch_updated_at()` (036) BEFORE UPDATE trigger on every table with the column.
- **Migrations are applied manually via psql and are idempotent by convention.** There is **no migration-ledger table** (no `schema_migrations`), the sequence contains **two different files numbered 009** (`009_phase4a_sellable_units.sql`, `009_phase4_card_channel.sql`) and **no 021 exists** (020 → 022).

---

## 2. Entity inventory by domain

Row counts are live tuples from the snapshot.

### 2.1 Tenancy & RBAC

| Table | Rows | Purpose / key columns | Relationships | Owning module |
|---|---|---|---|---|
| `tenants` | 1 | The property/account. `slug` UNIQUE, `timezone`, `currency`, `settings jsonb` (007: `vat_rate`; 011: `extra_guest` defaults; business profile). | Root of every FK tree. | `src/lib/channel`, `src/app/(dashboard)/settings` |
| `users` | 7 | Staff accounts. `UNIQUE(tenant_id, username)` + CI unique indexes (002) on lower(username)/lower(email); `auth_user_id` UNIQUE (Supabase auth link, no FK — cross-schema); `allow_google_auth`. | `role_id → roles` SET NULL. | `src/app/(dashboard)/staff`, `src/lib/auth` |
| `roles` | 6 | Per-tenant roles (`super_admin`, `admin`, `manager`, `receptionist`, …). `UNIQUE(tenant_id, key)`, `is_system`. | ← `users`, ← `role_permissions`. | `staff`, `permissions` pages |
| `permissions` | 60 | **Global** (not tenant-scoped) permission catalog; `key` UNIQUE. Seeded incrementally by 001/008/009/016/017. | ← `role_permissions`, ← `user_permission_overrides`. | `src/lib/auth` (`requirePermission`) |
| `role_permissions` | 171 | Role ⇄ permission join. `UNIQUE(role_id, permission_id)`. | — | `permissions` page |
| `user_permission_overrides` | 0 | Personal layer (003): `effect IN ('grant','revoke')`; effective = role ∪ grants − revokes. `UNIQUE(tenant_id, user_id, permission_id)`. | `user_id → users` CASCADE. | `staff`, `lib/auth` |

### 2.2 Physical inventory

| Table | Rows | Purpose / key columns | Relationships | Owning module |
|---|---|---|---|---|
| `areas` | 2 | Buildings/wings (this installation's usage). | ← `rooms.area_id` SET NULL, ← `operational_areas.building_area_id`. | `rooms` pages |
| `operational_areas` | 0 | Non-room spaces (lobby/elevator/pool…, 013). `area_type`+`status` CHECKs. | `building_area_id → areas`. | `src/lib/rooms` |
| `room_types` | 3 | **Descriptive metadata only** since D64/024 — capacity/bed defaults + `base_price` fallback. NOT the Channex mapping unit. | ← `rooms`, `sellable_units`, dead mapping tables, `channel_inventory_holds`. | `lib/channel`, `lib/rates` |
| `rooms` | 14 | The physical room — canonical identity source (D74/028). `room_number` (CI-unique per tenant, 013), `status IN (available,inactive,out_of_order)` (009 folded `maintenance`), occupancy fields (000 + 012 `default/included/min_occupancy`), extra-guest override columns (012), website/content fields (013). Trigger `trg_rooms_mirror_identity` (028) mirrors identity into the sole-member sellable unit. | `area_id`, `room_type_id` SET NULL. | biggest fan-in: 84 files; `lib/channel`, `calendar`, `lib/rooms` |
| `room_translations` | 38 | Per-language (he/en/ar) content + SEO; `UNIQUE(room_id, lang)`; slug CI-unique per tenant+lang. | `room_id → rooms` CASCADE. | `lib/rooms` |
| `room_images` | 1 | Gallery; partial unique `room_images_main_uniq` = one main image per room. Files live on **local disk** (D55). | `room_id` CASCADE. | `lib/rooms`, `api/rooms/images` |
| `room_amenities` | 105 | Join room ⇄ `lookup_items` (category `amenities`); PK `(room_id, amenity_id)`. | both CASCADE. | `lib/rooms` |
| `room_closures` | 0 | Dated physical blocks (004, "סגור חדר"); half-open `[start_date, end_date)`; CHECK end>start. Feeds `check_room_availability` and both inventory projections. | `room_id` CASCADE. | `calendar` |
| `housekeeping_tasks` | 2 | Cleaning tasks; free-text `status`/`priority` (no CHECK). | `room_id` CASCADE, `reservation_id` SET NULL, `assigned_to → users`. | `lib/rooms` (thin) |

### 2.3 Sellable units & pricing (the canonical commercial model)

| Table | Rows | Purpose / key columns | Relationships | Owning module |
|---|---|---|---|---|
| `sellable_units` | 14 | The sell-side unit between rooms and channels (009_phase4a). `UNIQUE(tenant_id, code)`; `is_pooled` (unused in practice — all units are 1:1 with a room); identity (code/name/room_type_id) is a **mirror of the room** for sole-member units (028 trigger). Lifecycle guarded by 026: `archive_orphan_sellable_unit()` trigger archives a unit whose last member room disappears. | `room_type_id` SET NULL. | `lib/rates`, `lib/rate-plans` |
| `sellable_unit_rooms` | 14 | Membership; `UNIQUE(room_id)` — a room belongs to exactly one SU. Composite tenant FKs added in 026. | SU + room CASCADE. | `lib/rates`, `lib/channel` |
| `sellable_units_backup_028` | 12 | **One-shot backup table from migration 028 left permanently in the schema.** No PK/FK/triggers. | none. | none (orphan) |
| `pricing_plans` | 18 | **Dual-scope** entity (016): (a) SU-scoped base plans (`sellable_unit_id NOT NULL`, `is_base`, partial-unique one base per SU) = the base-ARI carrier; (b) tenant-level Rate Plans (`sellable_unit_id IS NULL`) with `plan_kind IN (base, derived_percentage, derived_fixed, independent)`, parent chain guarded by `pricing_plan_parent_guard()` trigger (same tenant, tenant-level parent, no cycles, depth ≤ 5), validity/booking-window/DOW CHECKs, policy links (012). | `parent_plan_id` self-FK RESTRICT; `cancellation_policy_id`/`payment_policy_id` SET NULL. | `lib/rate-plans`, `lib/rates`, `lib/channel` |
| `pricing_plan_rates` | 6,633 | **The canonical nightly commercial store** (replaces `rates`): price, `min_stay_through`/`min_stay_arrival`/`max_stay` (3 separate axes), CTA/CTD, `stop_sell`. `UNIQUE(pricing_plan_id, date)`. Read via `effective_sell_state()`. | SU + plan CASCADE. | `lib/rates` (service, effective-state), `rates` page |
| `pricing_plan_units` | 56 | Assignment of a tenant-level Rate Plan to an SU (016); `UNIQUE(pricing_plan_id, sellable_unit_id)`; per-unit `adjustment_value` override. | plan + SU CASCADE. | `lib/rate-plans`, `lib/channel` |
| `pricing_plan_unit_rates` | 0 | Sparse per-(plan, unit, date) overlay: independent-plan prices / exact-date overrides. `UNIQUE(plan, unit, date)`. | plan + SU CASCADE. | `lib/rate-plans`, `lib/pricing` |
| `rates` | **0** | **Legacy Phase-1 ARI store, retired by 009_phase4a §10** (migrated into `pricing_plan_rates`). Table still exists with all its indexes; one residual live read remains (`rooms/actions.ts:463` counts it for delete-blocking). | room/room_type CASCADE. | retired |
| `bulk_rate_update_logs` / `bulk_rate_update_items` | 27 / 10,685 | Group Update audit: one log per run + one item per (room/type, date) old→new price. Items still carry legacy `room_id`/`room_type_id` columns. | `log_id` CASCADE. | `rates` page, `lib/rates` |

### 2.4 Reservations, guests & payments

| Table | Rows | Purpose / key columns | Relationships | Owning module |
|---|---|---|---|---|
| `guests` | 60 | Guest profiles; `is_vip`, `is_blocked`. No dedup constraint (email/phone not unique — by design). | ← `reservations.primary_guest_id`, ← `outbound_messages`. | `guests` pages, `lib/communications` |
| `reservations` | 81 | The booking aggregate. `UNIQUE(tenant_id, reservation_number)`; `CHECK(check_out > check_in)`; **`status` is free text with NO CHECK constraint** (canonical set in app: draft/confirmed/checked_in/checked_out/cancelled/no_show/blocked; blocking subset defined by SQL function `inventory_blocking_statuses()` = `{confirmed, checked_in, blocked}`). Three status domains (030): technical `status`, workflow `workflow_status_id → lookup_items` (RESTRICT), payment state derived from ledger. Money columns `total_price`/`paid_amount`/`balance` are **caches** of the payments ledger (019). External identity (029): `channel_connection_id` + `external_booking_id` with partial-unique dedup gate; OTA metadata columns; cancellation history columns (031); `expected_arrival_time`(+source) (033/034); `cancellation_policy_snapshot jsonb` (034); `booking_origin` NOT NULL CHECK (036). | `primary_guest_id`, `source_id → lookup_items`, `created_by`, `cancelled_by_user_id`, `channel_connection_id`. | `reservations`/`calendar` actions, `lib/channel/booking-import` |
| `reservation_rooms` | 82 | Per-room stay line (locked per-room model, D33). Own `check_in/check_out` (half-open), per-room guest fields (004), `rate_per_night`/`price_total`, `is_manual_rate` (009), `rate_plan_id → pricing_plans` SET NULL + **immutable `pricing_snapshot jsonb`** (017). `room_id` FK is **RESTRICT** since 015 (history keeps its room). **No overlap/exclusion constraint** — see §5. | `reservation_id` CASCADE. | `lib/pricing`, reservations/calendar actions |
| `reservation_cards` | 2 | Card vault (008): **one card per reservation** (`UNIQUE(reservation_id)`); PAN only as app-layer AES-256-GCM ciphertext (`pan_encrypted`, `key_version`), masked `brand/last4/exp_*`; source/channel metadata (009_phase4); **CVV column added by 010 and permanently dropped by 018** — no CVV at rest. | `reservation_id` CASCADE. | `card-actions.ts`, `lib/channel/card-ingest` |
| `reservation_payment_methods` | 0 | PSP token references (030, Stripe-only CHECK): `provider_ref` + safe display metadata; `UNIQUE(reservation_id, provider)`. No charge path is live (D46: charge disabled, no PSP). | `reservation_id` CASCADE. | `lib/payments`, `lib/channel` |
| `payments` | 14 | The authoritative money ledger. `status CHECK IN (paid,pending,failed,voided,refunded)` (019); only `paid` sums into `paid_amount`. `idempotency_key` partial-unique per tenant (030) = DB-enforced double-charge guard. `method` free text. | `reservation_id` CASCADE. | reservations actions, `lib` |
| `lookup_items` | 87 | **Polymorphic tenant-scoped list model**: categories in use — `sources`, `amenities`, `payment_methods`, `workflow_statuses` (030, with hex-color CHECK + one-active-default partial unique). `UNIQUE(tenant_id, category, key)`. | ← `reservations.source_id` (SET NULL), ← `reservations.workflow_status_id` (RESTRICT), ← `room_amenities`. | reservations pages, `lib/channel`, settings |
| `audit_logs` | 626 | Append-only audit: polymorphic `entity_type/entity_id` (no FK, by design), before/after jsonb, `ip_address`/`session_info` (009_phase4). No immutability trigger — UPDATE/DELETE are physically possible. | `user_id` SET NULL. | `lib` (audit helper), `lib/channel` |

### 2.5 Commercial policy templates (011)

| Table | Rows | Purpose | Relationships |
|---|---|---|---|
| `cancellation_policies` | 1 | Template library; CI-unique `code` per tenant among non-archived; one default per tenant (partial unique); `distribution_scope` CHECK. | ← `pricing_plans.cancellation_policy_id`; tiers CASCADE. |
| `cancellation_policy_tiers` | 1 | Ordered fee rules: `trigger_type`/`time_unit`/`fee_type`/`calc_base` CHECKs; `UNIQUE(policy_id, sort_order)`. | `policy_id` CASCADE. |
| `payment_policies` | 5 | Same pattern for collection policies. | ← `pricing_plans.payment_policy_id`. |
| `payment_policy_stages` | 5 | Ordered stages: trigger/amount/retry CHECKs; `methods jsonb` references `lookup_items` payment_methods **by key only (no FK)**. | `policy_id` CASCADE. |

Owning module: `src/lib/commercial`, `settings` pages.

### 2.6 Channel manager (Channex)

| Table | Rows | Purpose / key columns | Owning module |
|---|---|---|---|
| `channel_connections` | 1 | 1 per (tenant, provider='channex', environment). State machine CHECK; encrypted `api_key_ciphertext` + `api_key_hint`; `webhook_token_hash`; property mapping columns (023: `channex_property_id/title/method/snapshot/verified_at/reconcile_state`); connection-test stamps (022); sync toggles + watermarks. | `lib/channel` (12 files) |
| `channel_room_mappings` | 13 | **The live inventory mapping (D64/024): ONE physical room ⇄ ONE Channex Room Type** (`count_of_rooms=1`). `UNIQUE(connection_id, room_id)`; partial-unique on `channex_room_type_id`; status machine incl. `reconciliation_required`; `room_id` RESTRICT. | `lib/channel` |
| `channel_room_rate_mappings` | 52 | **The live rate mapping (D65/025): (room × local Rate Plan) ⇄ ONE Channex Rate Plan.** `UNIQUE(connection_id, room_id, local_rate_plan_id)`; partial-unique on `channex_rate_plan_id`; hangs off `channel_room_mapping_id` RESTRICT. | `lib/channel` |
| `channel_room_type_mappings` | **0** | **Dead** (005 model, keyed on room_type). Superseded by `channel_room_mappings`; still FK-referenced by `channel_sync_jobs.room_type_mapping_id`. | 1 file |
| `channel_rate_plan_mappings` | **0** | **Dead** (005 model, room_type + free-text `local_plan_code`). Superseded by `channel_room_rate_mappings`; still FK-referenced by `channel_sync_errors.rate_plan_mapping_id`. | 1–2 files |
| `channel_dirty_ranges` | 537 | Transactional ARI outbox, **re-keyed in 027 from room_type to `room_id` (+ optional `local_rate_plan_id`)**; monotonic `revision` seq (009); bounded retry columns; partial indexes for pending/runnable. Availability rows must have NULL plan (CHECK). | `lib/channel/outbox`, worker |
| `channel_sync_jobs` | 1,271 | Durable job queue; 15 job types (widened by 024/025); claim = `FOR UPDATE SKIP LOCKED` FIFO per connection; partial-unique idempotency over active states; retry/backoff/dead_letter columns. | `lib/channel` worker |
| `channel_sync_errors` | 579 | Structured sync error log. | `lib/channel` |
| `channel_booking_revisions` | 65 | Inbound revision store; `UNIQUE(connection_id, provider_revision_id)`; `import_status` (pending/imported/**quarantined**/failed) + `ack_status`; redacted payload; encrypted card staging (`card_pan_encrypted`, `card_meta`; CVV column dropped by 018); `local_reservation_id` SET NULL. | `lib/channel/revisions`, booking-import |
| `channel_webhook_events` | 65 | Webhook dedup/journal; unique `(connection_id, dedup_key)`; `tenant_id` nullable. | webhook route |
| `channel_inventory_holds` | 0 | Room-type-level holds for unassigned OTA bookings (005 §R). Counted by `room_type_inventory()`; **unused in practice** (import assigns physical rooms). | calendar (1 file) |
| `channel_external_changes` | 1 | One operator-visible record per external date-move revision (035): old/new dates, `apply_status IN (applied, conflict)`, reconcile + email lifecycle. `UNIQUE(connection_id, provider_revision_id)`. | `lib/channel` |
| `channel_inbound_rate_plan_aliases` | 10 | Inbound-only alias adoption (032): external rate-plan UUID → proven physical room (+ optional canonical plan). Self-heals owner-side Channex UI mappings (D78). | `lib/channel` |
| `channel_worker_state` | 1 | Singleton worker heartbeat (`id='singleton'` CHECK). | `lib/channel` worker |

Dropped along the way: `channel_sync_state` (watermark, created 009 → dropped 027).

### 2.7 Messaging & guest communications (020 + 036)

| Table | Rows | Purpose | Notes |
|---|---|---|---|
| `messaging_provider_connections` | 1 | Encrypted per-tenant provider secrets; `provider CHECK IN (gmail, gmail_smtp, green_api, twilio)`; `UNIQUE(tenant_id, provider)`. | `lib/messaging` |
| `message_templates` | 4 | Template identity + mutable **draft** surface (036); `UNIQUE(tenant_id, channel, slug)`; lifecycle draft/published/archived; `current_published_version_id` composite-FK RESTRICT. | `lib/communications`, communications pages |
| `message_template_versions` | 1 | **Immutable** published versions — `reject_message_template_version_mutation()` trigger blocks UPDATE/DELETE; `UNIQUE(template_id, version_number)`. | — |
| `communication_automations` | 1 | Trigger → template binding; version policy CHECK (`latest_published` XOR `locked_template_version_id`); status draft-first (D96: sends nothing until enabled). | — |
| `communication_events` | 5 | Event outbox; dedup `UNIQUE(tenant_id, event_type, aggregate_type, occurrence_key)`; lease columns (owner+expiry paired CHECK). Composite FK → reservations RESTRICT. | worker |
| `outbound_messages` | 8 | The delivery row (020, heavily extended by 036): status lifecycle CHECK (13 states), rendered content, idempotency partial-unique, once-per-event partial-unique, lease columns, `manual_resend` provenance CHECK. **Carries duplicate FKs**: 020's SET NULL FKs on `reservation_id`/`guest_id`/`template_id` coexist with 036's composite RESTRICT FKs on the same columns. | `lib/communications/outbox` (`FOR UPDATE SKIP LOCKED`) |
| `communication_delivery_attempts` | 5 | Per-attempt journal; `UNIQUE(delivery_id, attempt_number)`; attempt ≤ 10. | — |
| `communication_settings` | 1 | Per-tenant singleton (PK = tenant_id): sender identity, quiet hours, `default_language='he'` CHECK. | — |
| `message_events` | 0 | Provider webhook callbacks; `UNIQUE(provider, dedup_key)`. | `lib/messaging` |

---

## 3. DB functions & business-critical triggers

| Object | Defined | Role |
|---|---|---|
| `inventory_blocking_statuses()` | 004 | Single source of truth for statuses that consume inventory (`confirmed`,`checked_in`,`blocked`); mirrored in `src/lib/inventory.ts`, asserted equal by `scripts/check-inventory.mjs`. |
| `check_room_availability(tenant, rooms[], in, out, exclude[])` | 004, hardened 006 (`room_missing`) | THE server-side availability check: room status + overlapping blocking reservations + closures, half-open overlap rule. |
| `room_type_inventory(tenant, from, to)` | 005 | Per-room-type daily projection (incl. holds). |
| `sellable_unit_inventory(tenant, from, to)` | 009 | Per-SU physical projection. |
| `effective_sell_state(tenant, from, to)` | 009 | Fuses physical availability with base-plan ARI; price falls back to `room_types.base_price`. Consumed by grid, engine, payload builder. |
| `pricing_plan_parent_guard()` trigger | 016 | Parent-chain integrity for derived rate plans. |
| `archive_orphan_sellable_unit()` trigger | 026 | Archives an SU when its last member room row disappears (DB backstop for direct SQL). |
| `mirror_room_identity_to_unit()` trigger | 028 | Room rename/re-type mirrors into sole-member SU. |
| `reject_message_template_version_mutation()` trigger | 036 | Immutability of published template versions. |

---

## 4. Duplicate / competing / orphan models

1. **`rates` vs `pricing_plan_rates`** — `rates` (000) is the retired Phase-1 ARI store: 0 rows, fully migrated by 009 §10, all app read/write paths moved to `pricing_plan_rates` (6,633 rows). The table, its 4 indexes and its CASCADE FKs remain, and one live code path still queries it (`src/app/(dashboard)/rooms/actions.ts:463` — room-delete reference count).
2. **Four channel mapping tables, two generations** — 005 built `channel_room_type_mappings` + `channel_rate_plan_mappings` (keyed on room_type). D64/D65 declared the physical room the mapping unit and built `channel_room_mappings` (13) + `channel_room_rate_mappings` (52). The 005 pair is permanently empty ("0 rows and always will" — 025 header) yet still exists and is still FK-referenced by `channel_sync_jobs.room_type_mapping_id` and `channel_sync_errors.rate_plan_mapping_id`.
3. **`room_types` vs `sellable_units`** — room_types survive only as descriptive metadata + `base_price` fallback in `effective_sell_state()`; sellable_units are the real sell unit but are today strictly 1:1 with rooms, their identity a trigger-maintained mirror of `rooms`. Three entities (room / SU / room type) describe what is operationally one thing; two triggers (026, 028) exist solely to keep the redundancy consistent.
4. **`sellable_units_backup_028`** — a one-shot migration backup (12 rows) permanently resident in the production schema; no PK/FK; contains stale identity data.
5. **`channel_inventory_holds`** — designed for room-type-level unassigned OTA bookings; the import path assigns physical rooms directly, so it has 0 rows and only one reader (calendar's unassigned lane).
6. **`areas` vs `operational_areas`** — deliberate split (buildings vs facility spaces), documented in 013; not a defect, listed for completeness.
7. **Duplicate FKs on `outbound_messages`** — the 020 `SET NULL` FKs and the 036 composite `RESTRICT` FKs coexist on `reservation_id`, `guest_id`, `template_id`. RESTRICT wins operationally: a guest or reservation that has ever been messaged can no longer be hard-deleted, silently changing 020's intended SET NULL semantics.

---

## 5. Where double-booking prevention lives

**There is no DB-level overlap guard.** Introspection confirms **zero exclusion constraints** (`pg_constraint.contype='x'` returns nothing) and no `pg_advisory_lock` usage anywhere in `src/` or the migrations. `reservation_rooms` has only `CHECK (check_out > check_in)` and btree indexes.

The actual mechanism (D34), entirely at the application layer:

1. **`lockRooms(tx, tenantId, roomIds)`** (`src/lib/inventory.ts:38`) — `SELECT id FROM guesthub.rooms … FOR UPDATE` inside the write transaction, serializing concurrent writers per room. Callers: `reservations/actions.ts`, `calendar/actions.ts`, `lib/channel/booking-import.ts`.
2. **`guesthub.check_room_availability()`** — called after the lock in the same transaction; zero returned conflicts ⇔ all rooms free (half-open overlap, blocking statuses, closures, `room_missing` tenant guard).
3. `p_exclude_rr` excludes only the rows an edit rewrites — sibling rooms of the same reservation still conflict.

Consequences: correctness depends on **every** write path following the lock-then-check protocol. Any bypass — direct SQL (which has already happened in production twice: rooms 302/303 deletion in 026 forensics, renames in 028 forensics), a future code path that forgets `lockRooms`, or a non-blocking `status` typo (see Finding 2) — can create overlapping stays that the DB will happily store. `channel_sync_jobs` claiming and the communications outbox correctly use `FOR UPDATE SKIP LOCKED` for their queues.

---

## 6. ER diagram (main entities)

```mermaid
erDiagram
    TENANTS ||--o{ USERS : has
    TENANTS ||--o{ ROOMS : has
    ROLES ||--o{ USERS : "role_id"
    ROLES }o--o{ PERMISSIONS : role_permissions
    AREAS ||--o{ ROOMS : "area_id"
    ROOM_TYPES ||--o{ ROOMS : "descriptive type"
    ROOM_TYPES ||--o{ SELLABLE_UNITS : "base_price fallback"
    ROOMS ||--|| SELLABLE_UNIT_ROOMS : "UNIQUE(room_id)"
    SELLABLE_UNITS ||--o{ SELLABLE_UNIT_ROOMS : members
    SELLABLE_UNITS ||--o{ PRICING_PLANS : "SU-scoped base plan"
    PRICING_PLANS ||--o{ PRICING_PLAN_RATES : "nightly ARI (canonical)"
    PRICING_PLANS ||--o{ PRICING_PLAN_UNITS : "tenant plan ⇄ SU"
    PRICING_PLANS }o--o| CANCELLATION_POLICIES : links
    PRICING_PLANS }o--o| PAYMENT_POLICIES : links
    GUESTS ||--o{ RESERVATIONS : primary_guest
    LOOKUP_ITEMS ||--o{ RESERVATIONS : "source / workflow_status"
    RESERVATIONS ||--o{ RESERVATION_ROOMS : stays
    ROOMS ||--o{ RESERVATION_ROOMS : "RESTRICT"
    PRICING_PLANS ||--o{ RESERVATION_ROOMS : "rate_plan_id + snapshot"
    RESERVATIONS ||--o{ PAYMENTS : ledger
    RESERVATIONS ||--o| RESERVATION_CARDS : "one card"
    CHANNEL_CONNECTIONS ||--o{ CHANNEL_ROOM_MAPPINGS : "room ⇄ Channex room type"
    CHANNEL_ROOM_MAPPINGS ||--o{ CHANNEL_ROOM_RATE_MAPPINGS : "× rate plan"
    CHANNEL_CONNECTIONS ||--o{ CHANNEL_DIRTY_RANGES : "ARI outbox (room-keyed)"
    CHANNEL_CONNECTIONS ||--o{ CHANNEL_SYNC_JOBS : queue
    CHANNEL_CONNECTIONS ||--o{ CHANNEL_BOOKING_REVISIONS : inbound
    CHANNEL_BOOKING_REVISIONS }o--o| RESERVATIONS : imports
    CHANNEL_CONNECTIONS ||--o{ RESERVATIONS : "external identity"
    MESSAGE_TEMPLATES ||--o{ MESSAGE_TEMPLATE_VERSIONS : "immutable versions"
    MESSAGE_TEMPLATES ||--o{ OUTBOUND_MESSAGES : renders
    RESERVATIONS ||--o{ OUTBOUND_MESSAGES : about
    GUESTS ||--o{ OUTBOUND_MESSAGES : to
```

---

## 7. Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | **High** | No DB-level double-booking guard: zero exclusion constraints, zero advisory locks. Prevention is exclusively app-transactional (`lockRooms` FOR UPDATE + `check_room_availability`), and production forensics already document two direct-SQL bypass incidents. A GIST exclusion constraint on `reservation_rooms (room_id, daterange(check_in, check_out))` filtered to blocking statuses would make the invariant self-defending. | `pg_constraint` query (no `contype='x'`); `src/lib/inventory.ts:38`; forensics in 026/028 headers |
| 2 | **High** | `reservations.status` has **no CHECK constraint** although it drives inventory: only statuses in `inventory_blocking_statuses()` block availability, so any typo'd/unknown status silently frees the room while looking like a live booking. Every sibling status column in the schema is CHECKed. | snapshot constraint dump for `reservations` (no status CHECK); `004 §3` |
| 3 | **Medium** | No migration ledger + broken numbering: migrations applied manually, no `schema_migrations` table, **two different files share number 009**, and **021 does not exist**. Replay order/completeness on a fresh environment is convention, not fact. | `ls db/migrations/` (009_phase4a_sellable_units.sql + 009_phase4_card_channel.sql; 020→022) |
| 4 | **Medium** | Two dead channel mapping tables (`channel_room_type_mappings`, `channel_rate_plan_mappings`, both 0 rows and by-design permanently empty) remain in the schema and are still FK-referenced by the live queue/error tables — a trap for future queries and for anyone reading the schema. | 025 header ("0 rows and always will"); FKs `channel_sync_jobs.room_type_mapping_id`, `channel_sync_errors.rate_plan_mapping_id`; row counts |
| 5 | **Medium** | Tenant isolation is single-layered for most of the schema: no RLS, and only 026/036-era tables have composite `(tenant_id, id)` FKs. Older FKs (`reservations.primary_guest_id`, `rooms.area_id`, `reservation_rooms.room_id`, `pricing_plan_units.*`, …) permit cross-tenant references if any server query mis-scopes. | 000 header (design note); FK dump — composite FKs only on `sellable_unit_rooms` + communications tables |
| 6 | **Medium** | Legacy `rates` table (0 rows) is retired but not dropped, and one live code path still reads it (room-delete reference counting), keeping a phantom dependency on a dead store. | `src/app/(dashboard)/rooms/actions.ts:463`; row count 0; 009 §10 |
| 7 | **Medium** | Conflicting duplicate FKs on `outbound_messages` (`reservation_id`, `guest_id`, `template_id`): 020's `SET NULL` and 036's composite `RESTRICT` both active — RESTRICT wins, so guests/reservations that were ever messaged can never be hard-deleted; the 020 semantics are silently dead. | FK dump: e.g. `outbound_messages|guest_id|guests|SET NULL` **and** composite `RESTRICT` rows |
| 8 | **Medium** | `reservations.paid_amount`/`balance` are denormalized caches of the payments ledger with no DB-side consistency mechanism (no trigger); drift already occurred once (fixed by 019's one-shot reconcile) and depends on app code (`recomputePaymentAggregates`) forever after. | 019 header + body |
| 9 | **Low** | `sellable_units_backup_028` — one-shot migration backup permanently in the schema; no PK/FK; contains stale room identity (12 rows). Should be exported and dropped. | migration 028 §1; table exists in snapshot |
| 10 | **Low** | `lookup_items` polymorphism is not FK-safe: `reservations.workflow_status_id` FK does not enforce `category='workflow_statuses'` (any lookup row is accepted at DB level), and `payment_policy_stages.methods` references payment-method keys as JSONB text with no referential check. | 030 §2; 011 §C |
| 11 | **Low** | Free-text status/enum columns without CHECKs beyond finding 2: `housekeeping_tasks.status/priority`, `payments.method`, `rooms.floor`. Low traffic today, same drift risk pattern. | 000 table definitions; snapshot constraint dump |
| 12 | **Low** | `audit_logs` is append-only by convention only — no trigger prevents UPDATE/DELETE, and card-reveal/charge audits (009_phase4) rely on it as evidence. | 000/009_phase4; trigger dump (no audit trigger) |
| 13 | **Info** | CVV history: 010 stored encrypted CVV (reversing D42), 018 permanently dropped the columns. Current schema is clean (no CVV column anywhere), but **pre-018 database backups may still contain encrypted CVV values** — retention of old dumps is a PCI-scope question outside the schema itself. | 010, 018 |
| 14 | **Info** | `channel_inventory_holds` (0 rows) and `is_pooled` sellable units are designed-but-unused capacity; `channel_dirty_ranges` retains 537 processed rows and `channel_sync_jobs` 1,271 — no retention/pruning policy exists for the channel journals. | row counts |
