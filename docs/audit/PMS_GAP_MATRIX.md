# GuestHub — Mature-PMS Product Gap Matrix (Agent C)

- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Scope:** Compare current GuestHub capabilities against foundations normally present in stable commercial PMS products (Cloudbeds / Guesty / Little Hotelier class). Classification only — no implementation proposals.
- **Evidence base:** read-only code inspection of `/var/www/guesthub` plus the read-only data snapshot `guesthub_stage1_restore` (Docker `guesthub-testdb`). Every capability claim cites a file path or table name.
- **Data reality (snapshot):** 1 tenant, 60 guests, 81 reservations, 14 payments, 626 audit rows, 2 housekeeping tasks, 0 room closures.

**Classification legend**

| Tag | Meaning |
|---|---|
| **RS** | Required for operational safety now |
| **HV** | High-value near-term completion |
| **AP** | Architectural preparation only |
| **OF** | Optional future module |

Owning stage (RS/HV only): core-domain (reservations, inventory, pricing, payments, audit, properties/rooms) → **Stage 3**; communications, housekeeping, maintenance, tasks, reports/exports, Israel-market → **Stage 5**.

---

## 1. Reservations

**Current capability.** Mature core. ONE shared booking editor for create/edit (`src/components/reservations/BookingPanel.tsx`, `EditReservationPanel.tsx`, mounted globally via `NewReservationProvider.tsx`); ~1,500-line server-action layer (`src/app/(dashboard)/reservations/actions.ts`) with transactional writes + audit. Status model `draft/confirmed/checked_in/checked_out/no_show/blocked/cancelled` (`src/lib/inventory-rules.ts`), plus operator workflow statuses (migration `030_workflow_statuses_payment_methods.sql`). Cancellation captures actor/origin/reason and a cancellation-policy snapshot (`reservations.cancellation_policy_snapshot`, migrations 031/034). Multi-room stays via `guesthub.reservation_rooms` (snapshot max 2 rooms/reservation). Visible-number single source (`src/lib/reservations/visible-number.ts`). Print + PDF confirmation (`src/app/reservations/[id]/print/`, `src/app/api/reservations/[id]/pdf/route.ts`, `src/lib/pdf/BookingPdf.tsx`). List screen with lifecycle tabs incl. "הגעות היום"/"עזיבות היום" (`ReservationsScreen.tsx`). OTA identity fields + external revision tracking on `guesthub.reservations`.

**Gaps.**
- **Folio / itemized charges** — charges are two scalar columns (`extra_charges`, `discount_amount`); no line-item folio (item, qty, date, tax class) as in every commercial PMS. → **HV, Stage 3**
- **Automated no-show / stale-status handling** — `no_show` is a manual status change only (`actions.ts:619-620`); no end-of-day sweep flagging un-checked-in arrivals. → **HV, Stage 3**
- Group / allotment bookings (block of rooms under one master) → **OF**
- Waitlist → **OF**

## 2. Calendar

**Current capability.** Full tape chart: `src/app/(dashboard)/calendar/` — `CalendarGrid.tsx`, drag/move/resize with floating confirmation (`MoveConfirmDialog.tsx`, D43/D45), reservation + rate tooltips, room-closure panel (`ClosurePanel.tsx` over `guesthub.room_closures`), month separators, geometry single-sourced via CSS vars (D87/D88). Unknown-room (unassigned) availability handled since migration `006_availability_unknown_rooms.sql`.

**Gaps.** No material foundation missing at current scale; closure typing is covered under Maintenance (§8). Occupancy/ADR overlays belong to Reports (§11).

## 3. Guests

**Current capability.** Canonical `guesthub.guests` table (migration `000_init_schema.sql`: name, phone, email, id_number, country, language, is_vip, is_blocked, notes) with `reservations.primary_guest_id` linking every reservation. `/guests` read-model with honest per-guest-row aggregates — stays, no-shows, paid/outstanding, deliberately never summing across currencies (`src/app/(dashboard)/guests/data.ts`). Guest reuse on direct booking via explicit picker (`guest.id` path in `reservations/actions.ts:160-187`); blocked guests are filtered out of the picker (`actions.ts:1049`). Per-stay guest snapshot columns on `reservation_rooms` (`stayGuestCols`, `actions.ts:189-196`).

**Gaps.**
- **Channel-import duplicate proliferation** — every inbound OTA booking inserts a NEW guest row (`src/lib/channel/booking-import.ts:343`); with no merge tool the guests list degrades into per-booking rows (60 guests / 81 reservations already). Merge/dedup tooling (operator-driven, never automatic) is a standard PMS foundation. → **HV, Stage 3**
- **No guest management UI** — `guests/actions.ts` exposes only `getGuestProfileAction`; no create/edit/VIP/block/notes editing outside the reservation flow. → **HV, Stage 3**
- Guest deletion / anonymization → classified under Israel-market privacy (§21).
- Company/agent profiles (corporate accounts, travel agents) → **OF**

## 4. Payments

**Current capability.** `guesthub.payments` is the authoritative ledger; `paid_amount`/`balance` are derived caches recomputed in-transaction (`src/lib/payments/ledger.ts`, migration `019`); collected money = `status='paid'` only; negative balance = honest credit. Collection view (`src/lib/payments/collection.ts`). PSP gateway seam exists and fails closed — no provider wired (`src/lib/payments/gateway.ts` returns `null`). Card vault encrypted at rest (`src/lib/card-vault.ts`, `CARD_VAULT_KEY`), CVV never stored (column dropped, migration `018_remove_stored_cvv.sql`); masked-only read path (`reservations/actions.ts` card select); manual card delete/replace exists (`card-actions.ts:402`). External-payment recorder for OTA-collected money (D46). Payment policies + stages configurable (`guesthub.payment_policies`, `payment_policy_stages`, `src/lib/commercial/payment.ts`). Idempotency key on payment rows.

**Gaps.**
- **Card-vault retention enforcement** — `reservation_cards.available_until` exists but NO job or hook ever purges expired card data; deletion is manual-only (`card-actions.ts:402`). Encrypted PANs accumulate indefinitely on a self-hosted box — PCI-scope and breach-blast-radius issue. → **RS, Stage 3**
- **Refund / void operator flow** — ledger statuses `refunded`/`voided` are recognized (`ledger.ts`), but no dedicated refund workflow surface was found in the reservation UI; refunds appear representable only as row edits. → **HV, Stage 3**
- **Payment-policy stage enforcement** — policies/stages are configurable in `/settings` but no scheduler enforces or alerts on due deposit stages. → **HV, Stage 3**
- PSP integration itself — seam is deliberately prepared (`gateway.ts`); connecting a provider is a business decision. → **AP**
- End-of-day cash-up / reconciliation report → Reports (§11).

## 5. Pricing

**Current capability.** Strongest area. Dual-scope pricing plans (`guesthub.pricing_plans`, migration `016`), canonical per-unit daily rates with full restriction set — `price, min_stay_arrival, min_stay_through, max_stay, closed_to_arrival, closed_to_departure, stop_sell` (`guesthub.pricing_plan_unit_rates` columns, verified in snapshot). ONE pricing engine (`src/lib/pricing/engine.ts`, 587 lines) and ONE reservation-price entry point used by ALL surfaces (`src/lib/pricing/reservation-pricing.ts`, migration `017`, D51). Effective sale-state derivation with reason codes (`src/lib/rates/effective-state.ts`, `rules.ts`). Rate grid + Group Update with honest preview (`src/app/(dashboard)/rates/`), inclusive-end datepicker semantics (D93). Extra-guest pricing with per-room overrides (`src/lib/commercial/extra-guest.ts`, `rooms` columns `extra_*_override`). Rate-plan simulator (`src/app/(dashboard)/rate-plans/SimulatorPanel.tsx`). Bulk update audit trail (`guesthub.bulk_rate_update_logs/_items`).

**Gaps.**
- **Restriction enforcement on direct entry** — min-stay/CTA/CTD are projected to Channex (`src/lib/channel/ari-payloads.ts`) but enforcement of these restrictions when an operator books directly was not evidenced in `createReservationAction`; verify and close. → **HV, Stage 3**
- Promotions / discount codes / packages → **OF**
- Derived (linked/percentage-offset) rate plans → **OF**

## 6. Inventory

**Current capability.** Sellable-unit layer over physical rooms (`guesthub.sellable_units`, `sellable_unit_rooms`, migrations `009_phase4a`/`026` lifecycle binding), canonical room identity as single source with mirror trigger (migration `028`). DB-level availability check `guesthub.check_room_availability` (migration `004`) exposed only via `src/lib/inventory.ts`, returning typed conflicts (room_missing / room_status / reservation / closure). Blocking-status single source (`src/lib/inventory-rules.ts`). Channel inventory holds (`guesthub.channel_inventory_holds`).

**Gaps.**
- Leftover `guesthub.sellable_units_backup_028` table in the live schema (migration artifact) — hygiene. → **AP**
- Channel-level allotment/overbooking buffers (sell N-1, per-channel caps) → **OF**
- Availability snapshot report → Reports (§11).

## 7. Housekeeping

**Current capability.** Foundations only. `guesthub.housekeeping_tasks` table exists (room, reservation, checkout_time, status, assigned_to, priority — schema `000`; 2 rows in snapshot). Room-status popover writes housekeeping task rows on cleaning-status change (`src/app/(dashboard)/rooms/actions.ts:752-765`); rooms carry a status from `room_statuses` lookup. A dedicated cleaner role exists ("עובד ניקיון" in `guesthub.roles`) and a mobile-first cleaner screen exists as an EMPTY-STATE STUB (`src/app/housekeeping/my-tasks/page.tsx` — "המסך המלא ייבנה בשלב הניקיון").

**Gaps.**
- **The housekeeping module itself** — automatic task generation from checkouts/stayovers, assignment, the real my-tasks mobile flow, clean/dirty/inspected room lifecycle tied to arrivals. This is table-stakes in the Cloudbeds class. → **HV, Stage 5**

## 8. Maintenance & out-of-order

**Current capability.** `guesthub.room_closures` (date range + free-text reason; 0 rows used to date) editable from the calendar (`ClosurePanel.tsx`); closures block availability via `check_room_availability` (§6). Rooms can be deactivated (`rooms.is_active`, `rooms.status`).

**Gaps.**
- **Typed out-of-order / out-of-service closures** — no OOO (removed from inventory) vs OOS (dirty but sellable) distinction, no closure categories, no link to a maintenance reason taxonomy. → **HV, Stage 5**
- Maintenance ticketing (fault reports, photos, resolution tracking) → **OF**

## 9. Tasks / operational follow-up

**Current capability.** No generic task entity. Light follow-up exists via operator workflow statuses on reservations (migration `030`, `WorkflowStatusSection.tsx` in settings) and channel external-change notifications requiring acknowledgment (migration `035`, `src/lib/channel/external-changes.ts`).

**Gaps.**
- Generic operational to-do/reminder module (assignable, due dates) → **OF** (workflow statuses + notifications cover the near-term need at 14 rooms).

## 10. Communications (D96/D97)

**Current capability.** Deep for its age. Provider layer: Gmail OAuth/SMTP email + GREEN-API/Twilio WhatsApp behind shared interfaces with encrypted tenant secrets (`src/lib/messaging/providers.ts`, `secrets.ts`, migration `020`). Guest-communications module (migration `036`): templates with versioning + block-based builder v2 (`guesthub.message_templates`, `message_template_versions`, `src/components/communications/TemplateEditor.tsx`, `src/lib/communications/renderer.ts` single-source), automations that are DRAFTS until human-enabled (`src/lib/communications/automation.ts`), scheduling (`schedule.ts`), outbox + delivery attempts with operator-visible delivery log (`guesthub.communication_delivery_attempts`, `communications/data.ts`), worker (`src/lib/communications/worker.ts`), per-reservation opt-out (`reservations.guest_communication_opt_out`). Webhooks with opaque tokens (`src/app/api/messaging/webhook/*`).

**Gaps.**
- **Guest-language template selection** — templates carry a `language` field and guests carry `guests.language`, but the automation path does not select a template variant by guest language (no language logic in `automation.ts`). → **HV, Stage 5** (also listed under Israel-market §21)
- Inbound reply handling / unified inbox (webhooks receive events; no conversation surface) → **OF**
- SMS channel → **OF**

## 11. Reports & exports

**Current capability.** Effectively NONE. The dashboard is an explicit empty-state stub (`src/app/(dashboard)/dashboard/page.tsx` — "כרטיסי הדשבורד … ייבנו בשלבים הבאים"). No CSV/export code exists anywhere in `src/` (grep `text/csv|toCsv|\.csv` → 0 hits). Operational lists exist only as interactive screens: arrivals/departures/in-house tabs on `/reservations` (`ReservationsScreen.tsx:37-38`), per-guest paid/outstanding on `/guests`. The only PDF is the single-reservation confirmation (`api/reservations/[id]/pdf`).

**Gaps** (the essential commercial-PMS report set, all absent):
- Arrivals / departures / in-house daily lists as printable/exportable reports → **HV, Stage 5**
- Cancellations report → **HV, Stage 5**
- Occupancy report (occ %, room-nights) → **HV, Stage 5**
- Revenue report (by period/room/plan; ADR/RevPAR) → **HV, Stage 5**
- Balances-due / debtors report → **HV, Stage 5**
- Payments / cash-up (end-of-day, by method) → **HV, Stage 5**
- Availability report → **HV, Stage 5**
- Channel production report (per-OTA volume/value; data exists on `reservations.channel_connection_id`/`ota_name`) → **HV, Stage 5**
- Audit export → **HV, Stage 5**
- Dashboard KPIs (today's arrivals/departures/occupancy) → **HV, Stage 5**

## 12. Data import / export

**Current capability.** No operator-facing import or export of any entity. The only structured data paths are: inbound channel booking import (Channex/BDC — `src/lib/channel/booking-import.ts`, LIVE) and the nightly ops backup (`scripts/nightly-backup.sh`).

**Gaps.**
- Reservation/guest/payment CSV export (also serves accountant handoff and privacy data-portability) → **HV, Stage 5**
- Bulk import (legacy-system migration, guest lists) → **OF**

## 13. Audit history

**Current capability.** Strong write side: `guesthub.audit_logs` (before/after JSONB, ip, session; 626 rows) written transactionally with the domain mutation via one primitive (`src/lib/audit-write.ts`) from ~20 action files across reservations, cards, rooms, rates, settings, staff, permissions, communications (grep evidence). Read side: ONLY a per-reservation last-10 activity feed (`reservations/actions.ts:1424-1431`).

**Gaps.**
- **Audit viewer** — no screen to search/filter audit history by entity/user/action/date, no diff rendering, no full per-entity history (feed is capped at 10, action names only). → **HV, Stage 3**
- Audit retention/archival policy (table grows unbounded) → **AP**
- Audit export → Reports (§11).

## 14. Users & permissions

**Current capability.** Complete for single-property: `guesthub.users/roles/permissions/role_permissions` + per-user overrides (`user_permission_overrides`, migration `003`), 6 seeded roles incl. super-admin and cleaner (snapshot `guesthub.roles`), permissions matrix UI (`src/app/(dashboard)/permissions/PermissionsMatrix.tsx`), staff management with per-module permissions (`src/app/(dashboard)/staff/`), server-side guards (`src/lib/auth/guards.ts`, `permission-check.ts`), charge permission fails closed (D42), per-user Google OAuth gate (`users.allow_google_auth`), `is_active` deactivation.

**Gaps.**
- **MFA/2FA for operator accounts** — none; operators can view masked card data and trigger money-adjacent actions on a password-only login. → **HV, Stage 3**
- Session/device management, forced logout, password policy surface → **OF**

## 15. Multi-property support

**Current capability.** None, by design: one tenant = one property. Business identity lives in `tenants.settings.business_profile` (snapshot key list; `src/lib/business/profile.ts`), and the channel model binds a tenant to ONE Channex property (`guesthub.channel_connections`, migration `023`). All tables are cleanly `tenant_id`-scoped.

**Gaps.**
- Property as a first-class entity under a tenant (multi-property inventory, cross-property reporting) — nothing needed now at 1 property/14 rooms; preserve strict tenant scoping so a property dimension can be introduced later. → **AP**

## 16. Channel management

**Current capability.** The most invested area. Channex staging connection with verified credentials (`src/lib/channel/connection-test.ts`, migration `022`), operator-gated property create/adopt (`channex-properties.ts`, `023`), room-type + rate-plan mapping (`024`/`025`, `channex-room-types.ts`, `channex-rate-plans.ts`), 3-axis ARI projection + sync worker under PM2 (`ari-projection.ts`, `ari-sync.ts`, `worker.ts`, `scripts/channel-worker.cjs`), operator-gated Full Sync with persisted progress + DB-enforced duplicate prevention (D68/D69), LIVE inbound BDC booking import with revision tracking, persist-then-quarantine on normalize failure, recovery-by-ID job (`booking-import.ts`, `revisions.ts`, migrations `029`/`035`, D76/D82), inbound rate-plan alias self-healing (`032`), reconcile module (`src/lib/channel/reconcile.ts`), sync-error + worker-state tables (`guesthub.channel_sync_errors`, `channel_worker_state`), diagnostics UI on `/channels` (`src/app/(dashboard)/channels/*Section.tsx`), opaque webhook tokens (`api/channel/webhook/[token]`).

**Gaps.**
- **Operator alerting on sync failure / quarantine** — errors and quarantined revisions are persisted and visible on `/channels`, but no push notification to the operator was evidenced (tenant `settings.ops_notification_email` exists; wiring to channel failures unverified). A silently stopped sync corrupts inventory truth. → **HV, Stage 3**
- Production (non-staging) Channex certification/cutover — this IS the current program, not a new gap.
- Additional OTAs (Airbnb/Expedia) beyond BDC → **OF**

## 17. Direct booking readiness

**Current capability.** Data model is website-ready: `rooms.show_on_website`, `room_translations`, `room_images` with main-image promotion, `room_amenities` (migrations `013`/`014`, `src/lib/rooms/service.ts`). Pricing/restrictions per day are canonical (§5). No public routes beyond `/login`, print, uploads and APIs — no booking engine, no public availability endpoint, no online payment capture.

**Gaps.**
- Direct booking engine (public availability/quote/booking + online payment) — model is prepared; keep the pricing engine and availability check as the single quote source when it lands. → **AP** (engine itself **OF** as a module)

## 18. Business configuration (/settings)

**Current capability.** Two-pane settings (`src/app/(dashboard)/settings/`): Business Profile with Google Maps picker (`BusinessProfileSection.tsx`, `LocationPicker.tsx`), VAT rate (`VatSection.tsx`, `src/lib/vat.ts`), Israel-aware check-in/out schedules (holiday/erev/Shabbat via hebcal — `src/lib/check-in-check-out.ts`), extra-guest pricing, cancellation-policy templates with tiers (`guesthub.cancellation_policies/_tiers`), payment policies, workflow statuses, messaging providers. Lookup taxonomies seeded (`guesthub.lookup_items`: sources, currencies, languages, statuses, amenities…).

**Gaps.**
- Multi-currency handling formalization — `reservations.currency` exists and code honestly refuses to sum across currencies (`guests/data.ts`), but there is no FX/display strategy. → **AP**
- City/tourism taxes, additional fees taxonomy → **OF**

## 19. Operational control / diagnostics

**Current capability.** Above class-average for this size: `/channels` diagnostic surface (§16), realtime pg-NOTIFY hub → SSE + worker wake (`src/lib/realtime/`, `api/events/route.ts`), ~60 `check:*` mutation-verified scripts (`package.json`, `scripts/check-*.mjs`), fail-closed production deploy guard + marked prod runtime (`scripts/deploy-production.sh`, `scripts/production-deploy-guard.mjs`, `docs/PRODUCTION_RUNTIME.md`), E2E-safety guard (`check-e2e-safety.mjs`).

**Gaps.**
- Operator-facing health panel (worker heartbeat, outbox depth, delivery failures in one place) → **OF** (data already exists in `channel_worker_state`, delivery tables).
- Sync-failure alerting → counted in §16 (**HV, Stage 3**).

## 20. Data recovery

**Current capability.** Nightly schema-scoped `pg_dump` + uploads tarball, 14-day rotation, via cron on prod (`scripts/nightly-backup.sh` → `/home/ubuntu/guesthub-backups`). Restore practice is real: the audit snapshot itself is a restored dump (`guesthub_stage1_restore` in `guesthub-testdb`). Channel-side data recovery exists (recovery-by-ID re-import job, D76).

**Gaps.**
- **Off-site backup copy** — backups live on the SAME host as the database and uploads; host loss = total data loss beyond 0 days. 14-day window also caps point-in-time depth. → **RS, Stage 3**
- **Backup success monitoring + documented restore runbook/drill** — cron logs to a file; no failure alert; restore procedure is practiced but not codified. → **HV, Stage 3**

## 21. Israel-market readiness

**Current capability.**
- **VAT:** tenant VAT rate in `/settings` (`VatSection.tsx`), display-only, totals stay VAT-inclusive, included-VAT derivation (`src/lib/vat.ts`); changing the rate never rewrites reservations (honest).
- **Hebrew/RTL:** RTL-first throughout; app-wide design-system gate (`scripts/check-design-system.mjs`, D89); Hebrew-calendar-aware check-in/out scheduling incl. חג/ערב חג/שבת (`src/lib/check-in-check-out.ts` using `@hebcal/core`); RTL PDF/print (D53).
- **Guest language:** `guests.language` captured; template `language` field exists (§10).
- **PII posture:** CVV never stored (migration `018`), card PAN encrypted at rest with masked-only reads (`card-vault.ts`), `id_number` stored per guest, repo-public discipline (no secrets/screenshots).

**Gaps.**
- **Tourist VAT zero-rating** — `reservations.tax_exempt` column exists in schema but has ZERO code references (grep across `src/` → none): no UI, no pricing effect, no passport-evidence capture. Foreign-tourist zero-rating is a baseline Israeli hotelier need. → **HV, Stage 5**
- **Invoice/receipt seam** — no invoice/receipt concept anywhere in code (grep `invoice|חשבונית|receipt|קבלה` → icon/unrelated hits only). Israeli law requires חשבונית מס/קבלה for collected money; an external-provider seam (Green Invoice class) is acceptable, but today there is no seam at all. → **HV, Stage 5**
- **Guest-language communications** — automation does not pick template by `guests.language` (§10). → **HV, Stage 5**
- **Privacy-law PII handling (Amendment 13)** — no retention policy, no purge, no guest deletion/anonymization capability anywhere (grep `retention|purge|anonymi` → 0; no `DELETE FROM guesthub.guests` path). Minimization is otherwise reasonable. → **HV, Stage 5**
- Foreign-guest registration capture (passport details as zero-rating evidence) — fold into the tourist-VAT item. → **HV, Stage 5**

---

## Consolidated matrix

| Area | Item | Classification | Owning stage | Evidence |
|---|---|---|---|---|
| Payments | Card-vault retention enforcement (no purge of expired `available_until` card data; manual delete only) | Required for operational safety now | Stage 3 | `reservation_cards.available_until`; `card-actions.ts:402`; no purge job in `src/`/`scripts/` |
| Data recovery | Off-site backup copy (backups on same host as DB, 14-day window) | Required for operational safety now | Stage 3 | `scripts/nightly-backup.sh` (`DEST=/home/ubuntu/guesthub-backups`) |
| Reservations | Folio / itemized charges | High-value near-term | Stage 3 | `reservations.extra_charges` scalar; no folio table |
| Reservations | Automated no-show / stale-status sweep | High-value near-term | Stage 3 | `reservations/actions.ts:619` (manual only) |
| Guests | Guest merge/dedup tooling (channel import inserts new row per booking) | High-value near-term | Stage 3 | `booking-import.ts:343`; `guests/data.ts` header comment |
| Guests | Guest management UI (edit/VIP/block outside reservation flow) | High-value near-term | Stage 3 | `guests/actions.ts` (read-only profile) |
| Payments | Refund/void operator workflow | High-value near-term | Stage 3 | `ledger.ts` statuses; no refund UI found |
| Payments | Payment-policy stage enforcement/alerts | High-value near-term | Stage 3 | `payment_policies/_stages`; `commercial/payment.ts` |
| Pricing | Restriction enforcement (min-stay/CTA/CTD) on direct entry — verify & close | High-value near-term | Stage 3 | `pricing_plan_unit_rates` columns vs `createReservationAction` |
| Audit | Audit viewer/search + full per-entity history | High-value near-term | Stage 3 | write-only `audit_logs`; only `actions.ts:1424` last-10 feed |
| Users & permissions | MFA/2FA for operators | High-value near-term | Stage 3 | `lib/auth/*` (password + gated Google only) |
| Channel management | Operator alerting on sync failure/quarantine | High-value near-term | Stage 3 | `channel_sync_errors`; `tenants.settings.ops_notification_email` (wiring unverified) |
| Data recovery | Backup monitoring + codified restore runbook | High-value near-term | Stage 3 | `nightly-backup.sh` cron log only |
| Housekeeping | Full housekeeping module (task generation, assignment, mobile flow, clean/dirty lifecycle) | High-value near-term | Stage 5 | `housekeeping_tasks` (2 rows); stub `housekeeping/my-tasks/page.tsx`; `rooms/actions.ts:752` |
| Maintenance | Typed OOO/OOS closures with categories | High-value near-term | Stage 5 | `room_closures` (free-text reason, 0 rows) |
| Communications | Guest-language template selection in automations | High-value near-term | Stage 5 | `guests.language`; template `language`; absent in `automation.ts` |
| Reports | Arrivals/departures/in-house printable daily reports | High-value near-term | Stage 5 | screens only (`ReservationsScreen.tsx:37`); no export code |
| Reports | Occupancy + revenue reports (ADR/RevPAR) | High-value near-term | Stage 5 | dashboard stub `dashboard/page.tsx` |
| Reports | Balances-due / debtors report | High-value near-term | Stage 5 | per-guest only (`guests/data.ts`) |
| Reports | Payments / end-of-day cash-up report | High-value near-term | Stage 5 | `payments` table; no report surface |
| Reports | Cancellations, availability, channel-production reports | High-value near-term | Stage 5 | data present (`reservations.ota_name` etc.); no surfaces |
| Reports | Audit export | High-value near-term | Stage 5 | `audit_logs`; no export |
| Reports | Dashboard KPIs | High-value near-term | Stage 5 | `dashboard/page.tsx` empty-state |
| Data import/export | Reservation/guest/payment CSV export | High-value near-term | Stage 5 | grep `csv` → 0 hits in `src/` |
| Israel | Tourist VAT zero-rating (+ passport evidence capture) | High-value near-term | Stage 5 | `reservations.tax_exempt` dead column (0 refs); `vat.ts` display-only |
| Israel | Invoice/receipt seam (external provider acceptable) | High-value near-term | Stage 5 | no invoice/receipt code anywhere |
| Israel | PII retention + deletion/anonymization capability (Amendment 13) | High-value near-term | Stage 5 | no purge/delete path for `guests` |
| Payments | PSP integration behind existing seam | Architectural preparation only | — | `payments/gateway.ts` |
| Inventory | Drop `sellable_units_backup_028` artifact | Architectural preparation only | — | snapshot table list |
| Audit | Audit retention/archival policy | Architectural preparation only | — | unbounded `audit_logs` |
| Multi-property | Property-as-entity readiness (keep tenant scoping strict) | Architectural preparation only | — | `channel_connections` 1-property binding (023) |
| Direct booking | Public engine reuse of canonical pricing/availability | Architectural preparation only | — | `rooms.show_on_website`, `room_translations`; `lib/pricing`, `lib/inventory.ts` |
| Business config | Multi-currency/FX strategy | Architectural preparation only | — | `reservations.currency`; `guests/data.ts` non-summing |
| Reservations | Group/allotment bookings; waitlist | Optional future module | — | — |
| Guests | Company/agent profiles | Optional future module | — | — |
| Pricing | Promotions/discount codes; derived rate plans | Optional future module | — | — |
| Inventory | Per-channel allotment/overbooking buffers | Optional future module | — | `channel_inventory_holds` |
| Maintenance | Maintenance ticketing | Optional future module | — | — |
| Tasks | Generic operational task module | Optional future module | — | workflow statuses (030) cover near-term |
| Communications | Unified inbox / inbound conversations; SMS | Optional future module | — | webhook routes exist |
| Data import | Bulk legacy import | Optional future module | — | — |
| Users | Session/device management surface | Optional future module | — | — |
| Channels | Additional OTAs beyond BDC | Optional future module | — | — |
| Direct booking | Booking engine module | Optional future module | — | — |
| Business config | City/tourism taxes | Optional future module | — | — |
| Ops | Operator health panel | Optional future module | — | `channel_worker_state` |
