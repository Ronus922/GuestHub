# DECISIONS — Phase 1

Conservative choices made where `PROJECT_OVERVIEW.md` / `phase-1-prompt.md` left a detail
unspecified or where two authoritative sources conflicted. Per work-mode rule: pick the most
conservative reasonable option, record it here, continue.

## D1 — Design tokens: rendered design system wins over prose palette
`PROJECT_OVERVIEW.md` §16 (prose) lists primary `#1e40af`, active `#eff6ff`, hover `#f4f2fc`,
border `#dad9e3`. The **rendered** reference `ref/screens/design-system.png` (a screenshot — the
primary visual source of truth per §17.1) publishes a complete, internally-consistent token set
with primary **`#2540C8`**, and `login.png` + `sidebar.png` were clearly built from it.
Because the binding DoD is "נראה לפי reference" (matches the pixels), we adopt the full
design-system token set. Primary `#2540C8`, dark `#1C2E9A`, App BG `#F1F3F8`, Surface `#FFFFFF`,
Field `#EFF2FB`, Line `#E7EAF1`, Ink `#182233`, Muted `#6B7385`, Faint `#9AA1B4`, Hover `#F2F4F8`.
Status colors from the same sheet feed `lookup_items` colors.

## D2 — Font: Assistant (not Noto Sans Hebrew)
Overview §3 prose says "Noto Sans Hebrew". The committed scaffold (`app/layout.tsx`) and the
rendered `design-system.png` ("גופן יחיד: Assistant") both specify **Assistant (Google Fonts)**.
Two concrete sources agree; keep Assistant.

## D3 — Icons: lucide-react via single mapper
Overview §3 names `lucide-react` through one mapper `components/shared/Icon.tsx`; the design sheet
displays Material Symbols glyphs. We use **lucide-react** (overview's explicit implementation
choice, React-native, no icon-font CDN) and pick the closest lucide glyph per reference icon.

## D4 — DB isolation: `guesthub` schema in the shared `postgres` DB
The committed migration (`db/migrations/000_init_schema.sql`) creates a **`guesthub` schema**
(not a separate database). All tables live there. Supabase Auth (`auth.users`) shares the same
`postgres` DB, so `guesthub.users.auth_user_id` can reference it. App connects with porsager
`postgres` through the Supavisor **session** pooler (`localhost:5432`).

**Schema qualification (not `search_path`):** the Supavisor pooler drops the `search_path` startup
param, and — critically — the shared `postgres` DB's `public` schema already hosts **another
project** (mail/invoice) with colliding table names (`users`, `roles`, `permissions`,
`lookup_items`, `audit_logs`). Setting a role-level `search_path` would shadow and break it. So the
guesthub app **fully qualifies every table** (`guesthub.<table>`) and never mutates the shared role.

## D5 — Migration executed via `docker exec supabase-db psql`
Direct, reliable DDL path (the raw Postgres port is not published to the host; only the pooler is).
Seed inserts run through the pooler with porsager.

## D6 — Auth users created via GoTrue Admin API (signup disabled)
`GOTRUE_DISABLE_SIGNUP=true`, so the 4 seed users are provisioned with the service-role key via
`supabase.auth.admin.createUser` (email confirmed), then linked into `guesthub.users.auth_user_id`.
Login accepts **email or username**: a non-email input is resolved to its email server-side, then
`signInWithPassword`. Seed password (dev only): `Guesthub!2026`.

## D7 — Seed users = 4 key roles
6 system roles seeded (`super_admin, admin, manager, receptionist, staff, cleaner`); 4 users, one
each for **manager, receptionist, staff, cleaner** (§20 "one per key role"). The proof login is the
manager, whose role carries broad business permissions so the full shell renders.

## D8 — Money `numeric(12,2)`, dates `date`, times `time`, IDs `uuid` (`gen_random_uuid()`).
`reservation_number` is per-tenant running, generated in seed as `tenant_seq` integers rendered as
text (`unique(tenant_id, reservation_number)`); a real running allocator is a Phase-4 concern.

## D9 — Sidebar shows the full nav from `sidebar.png`, but only Phase-1 routes navigate
Phase 1 builds no business screens. Implemented routes: `/dashboard` (empty placeholder) and
`/housekeeping/my-tasks` (cleaner placeholder, no shell). Every other nav item renders per the
reference but is inert (no `href`) so the shell matches the picture without dead 404 links.
The reference's numeric badges (הזמנות `3`, אישור בקשות `5`) are **omitted** — real counts belong
to their modules and fabricating them would violate the no-mock-data rule (§4.9/§23).

## D10 — Overlaps in seed are valid data
§20 requires overlapping reservations. Two **blocking** reservations never share a room+date range
(that would be invalid double-booking). Overlaps are created as blocking-vs-`cancelled` on the same
room, and back-to-back (checkout day = next check-in day), exercising the availability rule honestly.

## D11 — Single pnpm lockfile
The scaffold shipped `package-lock.json` (npm) but the DoD uses `pnpm`. Standardized on pnpm;
removed `package-lock.json` in favor of `pnpm-lock.yaml`.

## D12 — guesthub schema is NOT exposed to PostgREST; anon/authenticated revoked
The initial scaffold migration granted `anon`/`authenticated` full privileges and its comment
suggested exposing the schema via `PGRST_DB_SCHEMAS`. Since the app talks to Postgres **only**
through porsager as the owning `postgres` role, those grants were pure attack surface — with the
public anon key they let anyone read/write every tenant's data via `/rest/v1` (verified live during
review). The migration now `REVOKE`s all privileges from `anon`/`authenticated` (grants to
`service_role` only), and the live DB was hardened the same way (anon probes now return 401).
Tenant isolation is enforced solely server-side via `actor.tenantId`. If PostgREST exposure is ever
required, it must come with RLS + tenant-scoped policies on every table.

## D14 — base.css reconciled to the freshly-rendered design system
`ref/html/design-system.html` was rendered headless (past "Unpacking…") and captured to
`ref/proof/design-system-*.png`; tokens were read from the rendered DOM. This resolved the earlier
OCR ambiguity from D1 and surfaced small conflicts, now corrected in `base.css`:
- **Ink** `#182233` → **`#1B2233`** (the rendered value; D1 had the OCR'd hex).
- **`.field`** radius `12px` → **`13px`**, min-height `48px` → **`52px`** (rendered input).
- **`.btn`** font `15px/600` → **`14px/700`**, horizontal padding `16px` → **`20px`** (rendered button).
- **`.btn` min-height kept at 44px** though the sheet draws 42px — the 44px touch-target floor wins.
The full token/typography/component spec now lives in the binding `DESIGN_SYSTEM.md`.

## D13 — Session-without-active-user is signed out (no redirect loop)
The Edge middleware only knows the GoTrue session; `getActor()` additionally requires an active
`guesthub.users` row. A valid session with no active user (deactivated, unlinked, or a foreign
GoTrue user from the shared auth) would otherwise loop `/login ↔ /`. Such a state now redirects to
`/auth/signout`, which clears the session and returns to `/login`; `loginAction` also rejects +
signs out an authenticated-but-inactive user at login time.

---

# Phase 2 — Users & Permissions

## D15 — Added `staff.*`/`permissions.*` permission keys (not reused `users.*`/`roles.*`)
Phase 1 seeded `users.{view,create,edit,delete}` and `roles.{view,edit}`. The Phase-2 brief specifies
`staff.{view,create,update,disable}` and `permissions.{view,update}` — a cleaner fit (`staff.disable`
vs a generic `users.delete`; there is no user deletion in Phase 2, only disable). These were missing,
so `db/migrations/001_phase2_permissions.sql` adds them (idempotent `ON CONFLICT DO NOTHING`) and
grants them to `super_admin`/`admin`/`manager`; `scripts/seed.mjs` mirrors them for fresh rebuilds.
The old `users.*`/`roles.*` keys remain in the catalog (harmless) and appear in the matrix.

## D16 — Phase 2 stacks on the (still-open) Phase-1 branch
PR #1 (`phase-1-db-auth-shell`) is **not yet merged** to `main` (`mergedAt: null`), though the brief
said Phase 1 was merged. To build on the real Phase-1 code without merging main myself (an
outward-facing action not requested), Phase 2 branches off the Phase-1 tip and its PR bases on
`phase-1-db-auth-shell`, so the review diff is Phase-2-only. **Phase 1 must be merged first.**

## D17 — Disable = `is_active=false` + GoTrue ban (defense in depth)
`getActor()` filters `is_active=true`, so a disabled user fails auth on their very next request and is
sent to `/auth/signout` (verified live). Additionally the action bans the GoTrue user
(`ban_duration ~100y`) so the auth token itself is invalidated and re-login is refused; enable unbans.

## D18 — Self role-change blocked entirely (covers self-demote)
Rather than only blocking a "lower" role, `canChangeRole` blocks **any** change to the actor's own
role — simpler and safe against both self-demote and odd self-escalation. Guards live in pure,
directly-testable predicates (`src/lib/auth/guards.ts`), enforced in every action (never UI-only).

## D19 — Status-tint tokens for badges
`--color-status-success-050` / `--color-status-warning-050` were added to `base.css @theme` (matching
the DESIGN_SYSTEM status palette) so the `Badge` component uses tokens only — no invented hex.

---

# Employees screen rebuild (per employees-list/add reference)

## D20 — Only 2 of the 6 named reference files exist; sources per artifact
The brief referenced six files; only `ref/screens/employees-list-screen.png` and
`ref/html/employee-add-screen.html` exist on disk. Sources of truth used:
**list** = the PNG; **add panel** = the HTML bundle rendered headless (screenshots in scratchpad);
**edit panel** = mirrors the add-panel structure with edit semantics (username + optional password
reset always shown; status switch; no reference existed). The reference's "אזורי דיווח" header
button was omitted — no such screen exists in the app yet.

**Addendum:** the remaining reference PNGs (`employee-edit-screen.png`,
`employee-permissions-screen.png`, `employee-add-screen.png`) were added later. The edit panel was
then restructured to tabs (פרטי עובד / התחברות וגישה / תפקיד / הרשאות בתוקף) and gained the
reference's read-only "מידע נוסף" (only the fields the schema has: last sign-in, join date). The
reference's remaining tabs (דיווח/פעילות/משימות/דיווח שעות) and its per-user module-override
matrix (צפייה/עריכה/מחיקה + "אפס לברירת המחדל") require models that do not exist
(user-permission overrides, per-module CRUD triads) — building them was explicitly out of scope
("do not invent a new permissions model"; no dead tabs). Effective permissions render read-only
from `role_permissions`, with a link to the approved editor (the /permissions matrix).

## D21 — Login-method model mapped to the real auth system
The rendered add screen offers two methods (Google / username+password) and marks email
"required only for Google". In the current system every login resolves to a GoTrue email identity
(username login is resolved server-side to the email, then `signInWithPassword`), so **email is
required always**; the hint copy was adjusted accordingly. `allow_google_auth` remains a stored
flag only (Phase-2 constraint: no OAuth yet) — its description says so. When username+password is
OFF, the GoTrue user is created **without a password** and the username is **derived from the
email local-part** (tenant-unique, numeric suffix on collision) because `users.username` is NOT
NULL. Both method toggles default ON (the reference defaults Google-only, which would create
users that cannot log in today). At least one method is required. Phone is required on create
(the reference marks it so).

## D22 — אזורי דיווח column renders "—" (no data model)
`guesthub.areas` exists but nothing links users to areas. The column is kept for reference
fidelity and honesty renders "—" for every row; counts will appear when a user↔areas model ships.
"כניסה אחרונה" is real data — `auth.users.last_sign_in_at` via LEFT JOIN (verified readable
through the pooler). A `has_password` flag from the same join was removed after live testing:
GoTrue stamps a hash even for passwordless creates, so it cannot honestly distinguish
login methods (and it leaked auth-layer state to `staff.view` holders).

## D23 — `admin` protected by rank, and disable-permission enforced on the edit path
Review findings (Phase-2 adversarial review) fixed while rebuilding the affected files:
(1) role **rank** model in `guards.ts` (`super_admin`=3, `admin`=2, others 1) — you cannot manage
a target above your rank nor assign a role above your rank; previously only `super_admin` was
special-cased, letting any `staff.create/update` holder mint or hijack a full-bypass `admin`
account. Enforced in create + update actions and mirrored in the UI (role cards hidden).
(2) `updateUserAction` now requires `staff.disable` whenever `is_active` changes (both
directions), matching `setUserActiveAction`. Guards are covered by a runnable check:
`node scripts/check-guards.mjs` (27 assertions).

## D24 — base.css component classes moved into `@layer components`
`.field`/`.btn`/`.thin-scroll`/focus-ring were unlayered, so they silently beat every Tailwind
utility (v4 puts utilities in a cascade layer; unlayered author CSS wins over all layers) —
e.g. `field ps-11` for icon inputs never applied. Wrapping them in `@layer components` restores
the intended precedence: utilities override component classes per-instance.

## D25 — Employees-screen adversarial review round (fixed vs deferred)
Fixed: (1) auth-layer sync in `updateUserAction` now runs **before** the DB write and fails
loudly (a failed GoTrue email/password update previously reported success and wrote a false
audit entry); the ban call stays best-effort because `getActor`'s `is_active` filter is the hard
backstop (D17). (2) **Dominance guard** `canControlRole`: an actor cannot create, re-role, or
password-reset an account whose role holds a sensitive permission
(`permissions.update`/`staff.*`) the actor lacks — closes lateral takeover via `staff.update`
password resets one tier below the D23 rank rule. (3) Case-insensitive unique indexes on
`users(tenant_id, lower(username|email))` (`002_users_unique_ci.sql`, applied live as
`supabase_admin` — the `postgres` role does not own guesthub tables) backstop the check-then-act
dup queries. (4) GoTrue errors are no longer surfaced raw (cross-tenant email-existence oracle +
English text). (5) Form labels wrap their controls; errors are `role="alert"`; switch got an
accessible name, RTL ON-at-end direction, and a ≥44px hit area; protected targets' real role
shows read-only; digits-only phone search; phone column aligned per reference.
Deferred, deliberately: badge text-on-tint contrast (needs darker `-700` text tokens —
DESIGN_SYSTEM reconciliation, affects all screens); blocking removal of a user's "last login
method" on edit (no reliable per-method flag exists — Google login is a stored flag only, and
GoTrue password state proved unknowable per D22); audit-write atomicity (pre-existing, known).

## D26 — Per-user permission overrides layered on the role model (supersedes the D20 addendum)
The reference's per-user override matrix is now a real model:
`guesthub.user_permission_overrides` (003, applied live) — one row per
tenant/user/permission with `effect ∈ {grant, revoke}`, FK-cascading, unique per
(tenant_id, user_id, permission_id), updated_at trigger, service_role-only grants.
**Resolution** (server-side, single source in `effectivePermissionKeys`):
`effective = role_permissions ∪ grants − revokes`; `getActor` builds
`actor.permissions` from it, so `requirePermission`/`hasPermission` and every guard
consume the effective set automatically. Roles remain the default layer and are still
edited only in /permissions; overrides are edited only in the employee panel's הרשאות
tab — the two mechanisms never mix.
**Save model:** the client sends the desired effective matrix (full vector); the server
diffs against role defaults + existing rows, so a checkbox matching the role default
deletes the row — redundant overrides cannot persist. On role change, grants the new
role already includes and revokes of keys the new role lacks are auto-deleted
(`override_cleanup` audit entry); overrides that still change the result survive.
**Guards:** `permissions.update` required (strongest existing key governing permission
management); `canManageUserOverrides` blocks self-editing, protected-role targets
(admin/super_admin bypass permission checks — overrides would be dead rows), and
above-rank targets; `canControlRole` dominance now runs against the target's
*effective* set (a personal grant of a sensitive key protects the account like a role
key, incl. password reset + role change); `canGrantOverride` stops a non-protected
actor granting a sensitive-area key (`staff./permissions./roles./users./settings./
lookups./audit.`) they don't hold. All covered in `scripts/check-guards.mjs`.
**Audit:** every override change writes `override_grant/override_revoke/override_clear`
with before/after effect + effective state; the override rows and their audit entries
commit in one transaction (`writeAudit` accepts a tx handle) — the older non-atomic
audit pattern still applies to the other actions (deferred, known).

## D27 — super_admin bootstrap lives in the seed (no DB-only admin)
During Phase-2 verification, the super_admin `admin` (admin@ginot.co.il) was created
directly in the DB and not in the seed — so a reseed/reset would silently drop the only
full-access user (the seed truncates `guesthub.users`; the GoTrue auth user survives but
has no domain row). Fixed: `scripts/seed.mjs` now seeds `admin` (role `super_admin`) as
the 5th user, and explicitly truncates `guesthub.user_permission_overrides` (added by
migration 003 after the seed was written; the previous `TRUNCATE … CASCADE` already
covered it implicitly).
**Recovery procedure after any DB reset/reseed:** run `pnpm db:seed` and log in as
`admin` with the seed password. The seed is the only sanctioned super_admin creation
path — it runs server-side with `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`; there is
no signup, API, or client-side path that can create or escalate to super_admin.
The two demo overrides on `reception` (grant staff.view / revoke guests.view) used for
Phase-2 verification were removed via the panel's reset link (audited `override_clear`
pair); the live DB ships Phase 2 with zero override rows.

## D28 — Owner login adopts the pre-existing shared GoTrue identity (r@bios.co.il)
The shared self-hosted Supabase serves several projects and GoTrue enforces email
uniqueness instance-wide (`users_email_partial_key` on `auth.users`). `r@bios.co.il`
already existed as a live Google identity (`auth.users` `d94e462c-…`, provider
`google`, actively used by other apps on the instance), so GuestHub's staff-create
flow — which always *creates* a GoTrue user — was rejected with `email_exists`,
while no GuestHub UI could show why (the blocker lives below `guesthub.users`).
**Resolution (2026-07-04, data-only, no code change):** the identity was adopted,
not recreated — `guesthub.users` `a70bd403-…` (username `ronen`, role `super_admin`,
`allow_google_auth=true`, tenant גינות הים) links `auth_user_id d94e462c-…`. The row
and its `create` audit entry (with `adopted_existing_auth_identity=true`) committed
in one statement. Nothing in `auth.*` was created or modified (before/after field
hash identical) and no password was set or changed anywhere.
Note: the login page's Google button is still a stub ("התחברות Google תופעל בשלב
הבא"), so Google sign-in for this account is testable only once that flow ships;
the staff screen already resolves the linked identity (last-login via the auth join).
Future phase: staff-create could offer an explicit "adopt existing auth identity"
branch instead of masking the GoTrue 422.

## D29 — Google OAuth login ships via the shared GoTrue, gated per-user (supersedes D28's stub note)
The login stub is now a real flow (google-oauth skill, Route A — adapted, not
copied): the button calls `signInWithOAuth` with `redirectTo`
`NEXT_PUBLIC_APP_URL/auth/callback`; the new `/auth/callback` route exchanges the
PKCE code server-side (cookies staged and bound to the final redirect, like
/auth/signout) and then gates every non-password provider by the guesthub layer:
`auth_user_id` match AND `is_active` AND `allow_google_auth` AND a real tenant.
Unknown identity / flag off / inactive collapse into ONE neutral Hebrew error
(`google_not_allowed`) — the shared auth.users must not become an email-existence
oracle. Login never creates or adopts guesthub rows and grants nothing; all
authorization stays in getActor/effectivePermissionKeys. Redirects are built only
from `NEXT_PUBLIC_APP_URL` (behind nginx, request.url is the internal upstream).
`/auth/callback` is exempt from the middleware auth redirect (a callback is
unauthenticated by definition). Infra (outside the repo): guesthub origins were
appended to `ADDITIONAL_REDIRECT_URLS` in /opt/supabase/docker/.env and the auth
container re-upped — Google provider + Console redirect URI were already
configured instance-wide. No app-side Google secrets exist (they live in GoTrue).

## D30 — OAuth auto-provisioning audit + callback restricted to Google-only (pre-push review, 2026-07-04)
**Provisioning risk (verified on the running instance, no settings changed):** the
shared GoTrue already runs `GOTRUE_DISABLE_SIGNUP=true` (flipped instance-wide
between 2026-05-10 and 2026-07-03, before this feature) and has **no** GoTrue hooks
configured (zero `GOTRUE_HOOK_*` vars). An unknown Google account completing OAuth
is therefore rejected by GoTrue itself with `signup_disabled` — **no `auth.users`
or `auth.identities` row is created**; GuestHub's callback never even sees a code.
Known ceiling: GoTrue auto-*linking* is not signup — a Google account whose
verified email equals an EXISTING `auth.users` email gets a `google` identity row
linked to that existing user and a session (which GuestHub's gate then rejects).
That only adds an identity to the email's legitimate owner, never a new user.
Compatibility: the instance is shared by invoice, mail-system, pms, sea-tower and
guesthub (almog uses a separate hosted supabase.co project). None of them calls
`auth.signUp` — all provision users via admin/service-role — so the already-active
global signup block breaks nothing and no hook is needed.
**Callback tightened (code):** D29's gate covered "every non-password provider" and
let `provider=email` sessions through ungated — too broad for a route that serves
exactly one flow. `/auth/callback` now requires the session itself to be a Google
OAuth login: JWT `amr[0].method === "oauth"` (decoded from GoTrue's own
server-to-server exchange response) AND a `google` identity on the user; anything
else (magic-link/recovery codes, future providers) is signed out behind the same
neutral `google_not_allowed` error. amr can't name the provider — google is the
only enabled OAuth provider instance-wide; revisit if a second one is enabled.
**Infra persistence:** `ADDITIONAL_REDIRECT_URLS` gained exactly
`https://guesthub.bios.co.il/**` and `https://guesthub.bios.co.il/auth/callback`
(all four prior invoice/pms entries intact — verified by diff against the backup
`/opt/supabase/docker/.env.bak-guesthub`, taken 2026-07-03 before the change).
The value lives in `/opt/supabase/docker/.env`, which `docker-compose.yml` (line
148) maps to `GOTRUE_URI_ALLOW_LIST` — a `docker compose up -d` recreate rereads
it, so the config survives redeploys. Restarted service: `supabase-auth`
(compose service `auth`, project `supabase`).

---

# Phase 3 — Occupancy Calendar + Channex-ready foundation

## D31 — Temporary closures are a dedicated `room_closures` table
Overview §8 lists a `blocked` reservation status, but no runtime data or code used it and a
closure-as-fake-reservation would need a reservation_number, pollute future reservation lists
and blur §Q diagnostics (occupied vs closed counted separately). `guesthub.room_closures`
(004) is a clean date-range mechanism: start-inclusive/end-exclusive like every stay, checked
inside the SAME `check_room_availability()` — so nothing can be booked/moved/resized over a
closure. `rooms.status` stays a permanent state and is never used for temporary closures.
The `blocked` status remains honored by the blocking set (defensive compatibility).

## D32 — One overlap model, one blocking-status source
The hotel-night rule lives once per layer and is asserted equal across layers:
`src/lib/dates.ts` (`rangesOverlap`: `a.start < b.end AND b.start < a.end`, checkout-exclusive)
and `guesthub.check_room_availability()` / `room_type_inventory()` in SQL. Inventory-consuming
statuses = §8's `confirmed, checked_in, blocked` — single SQL source
`guesthub.inventory_blocking_statuses()`, TS mirror in `src/lib/inventory-rules.ts`;
`scripts/check-inventory.mjs` fails if they ever diverge, and also asserts the projection and
the availability function agree per room-type/day (with closures and holds, rolled back).
`cancelled`/`draft`/`checked_out`/`no_show` never consume inventory; `cancelled` never renders.

## D33 — Locked per-room reservation model; parent keeps derived aggregates
`reservation_rooms` gained nullable per-room guest fields (004). Calendar cards render one item
per reservation-room with the shared reservation_id. The parent `reservations` columns
(check_in/out, occupancy, totals) are derived: min/max of room dates, summed occupancy,
Σ price_total − discount + extra_charges — kept in sync by every write path (KPIs/lists stay
correct). The former global-stay semantics are not restored.

## D34 — Concurrency: room-row FOR UPDATE + in-transaction re-check
Every availability-checked write (create / edit / move / resize / closure) runs in one
transaction: `lockRooms()` (SELECT … FOR UPDATE on the target+source room rows, tenant-scoped,
throws on foreign rooms) → `check_room_availability()` → mutate → audit → dirty-range mark.
Two concurrent writers on the same room serialize on the row lock, so both can never pass the
same check. Reservation-number allocation locks the tenant row; the unique index is the
backstop. No exclusion constraint needed (status lives on the parent table).

## D35 — Channex foundation: structural, tenant-scoped, and OFF
005 adds channel_connections (state machine disconnected→…→active, api_key ciphertext-only +
masked hint, webhook token hash), room-type/rate-plan mappings (unique per connection, audit on
change), transactional dirty ranges (written ONLY when an active outbound-enabled connection
exists — none does, so local ops stay no-op and no backlog forms; coalescing merges
overlapping/adjacent pending ranges), a jobs queue (idempotency-key partial unique, FOR UPDATE
SKIP LOCKED claim, FIFO per connection, backoff+jitter retries, dead_letter), booking revisions
(unique per connection+revision, quarantine on unmapped, acknowledgement structurally
impossible before import), webhook events (dedup unique, redacted payloads), inventory holds
(§R: room-type-level, reduce availability immediately, calendar lane renders only when they
exist), and sync errors. The provider boundary (`src/lib/channel/provider.ts`) is pure:
`createChannelProvider` yields Disabled unless `CHANNEX_ENABLED=true` AND an active connection,
and even then Phase 3 resolves to DryRun — NO HTTP client exists in the repo at all
(check-calendar asserts no fetch/XHR in the channel modules). Base URLs live only in
`src/lib/channel/config.ts` (server-only). The webhook route 404s unless an active
inbound-enabled connection matches the hashed token — i.e., always, in Phase 3.

## D36 — Channel management is super_admin-only, stricter than requirePermission
`canManageChannels` (guards.ts) admits ONLY `super_admin` — `admin` does not qualify, unlike
the generic requirePermission bypass, because integration credentials/mappings outrank ordinary
full access. Every action in `src/lib/channel/admin.ts` enforces it server-side; no channel UI
ships this phase (foundation only). Covered in check-guards.

## D37 — Rates schema unchanged; Channex fields derived in the payload builder
guesthub.rates already carries price/min_nights/max_nights/closed/CTA/CTD. Channex-only
concepts map at projection time (closed→stop_sell, min_nights→min_stay_arrival,
max_nights→max_stay) in the pure builders (`payloads.ts`) instead of duplicating columns.
Effective price priority stays: room-level rate → type-level rate → room_type.base_price
(one resolver used by server pricing AND the calendar's empty-cell strip). Restrictions are
enforced on new sales and blocking-status reschedules; a calendar operation can never pass
what the reservation engine rejects.

## D38 — Phase-3 verification data
Manual verification created reservation #1039 (guest "בדיקה יומן", 2 rooms) through the real
booking flow, exercised move/resize/invalid-drop/status-edit against it, then CANCELLED it via
the real cancel flow — it remains in the DB as a cancelled reservation with its ₪300 payment
row and full audit trail (nothing was deleted; seed was not run). A test closure on room 102
was created and removed through the UI. Proof screenshots: docs/proof/phase-3-*.png.

## D39 — Phase-3 visual/interaction correction pass (reference-exact board)
The /calendar board, booking wizard and edit window were rebuilt pixel-close to the rendered
references (ref/html/rooms-calendar.html + booking-window.html, ref/screens/edit-booking-modal,
new-booking-step-*, Tooltip.png), whose computed CSS was extracted from the live pages and
ported 1:1 into `app/styles/calendar.css` (`cb-*`) and `app/styles/booking-window.css` (`bw-*`).
Geometry is now FRACTION-based like the reference (equal-width flex day columns; pills at
`(nights(from,ci)+0.5)/days → (nights(from,co)+0.5)/days` of the strip), all computed by ONE
pure module `src/lib/calendar-interactions.ts` shared by committed pills, drag ghosts and
resize previews — checked by `scripts/check-calendar-ui.mjs` (which caught a real half-column
checkout-edge bug during the pass). Card color = PAYMENT state only, using the exact reference
families (paid `#DFF2E7/#4FB47E/#0F6B3C`, partial `#EAF7EE/#93D3A5/#1F7A3D`, unpaid
`#FDEBEC/#EFA3A9/#B4232D`); checked-out stays use the reference's neutral gray family
(`#EAEEF4/#AEBACB/#3C4A5E`), drafts render dashed. The legend keeps only the four chips our
data model really has (הכל + three derived payment states) — the reference's extra
transfer/failed/refunded chips would fabricate unsupported payment states. Click opens the
reference popover (`.cb-pop`, 316px, avatar/badge/rows/עריכה); עריכה opens the full-screen
edit window; the popover's "אישור הזמנה" button for pending bookings was deliberately NOT
added because draft→confirmed changes inventory consumption and would need a new write path
(the editor's status field, fully validated server-side, covers it). Drag is pointer-captured
on the card, threshold 6px, rAF-throttled, and paints ONLY an imperative transform-positioned
ghost — zero React renders per pointer move (React renders happen exactly at threshold-cross
and release, row-scoped via memo). Wizard/editor moved from the 55% SidePanel to the
reference's full-screen window (FullWindow) — the reference visual for these flows overrides
the site-wide side-panel rule for the calendar pair only. The reference step-3 credit-card
form and VAT split were not reproduced (no gateway, no VAT model — no fake data).

## D40 — Phase-3 second correction pass (tooltip, direct edit, range-create, card fields)
User-directed pass over D39 with new authoritative references (Tooltip.png,
edit-booking-modal.png, new-booking-step-3, updated booking-window.html, day-header shot).
INTERACTION MODEL CHANGED: hovering a pill (mouse, 380ms deliberate delay / 140ms leave grace,
`TOOLTIP_OPEN_MS`/`TOOLTIP_CLOSE_MS`) opens the reference `.pop` card as an interactive
TOOLTIP (`ReservationTooltip`, renamed from ReservationPopover, with the reference caret);
CLICKING a pill now opens the edit flow directly (click = movement ≤6px; drags and the
resize handle never open). [Corrected in D41: the tooltip is INFORMATIONAL ONLY — its
"אישור הזמנה" button was removed; the tooltip performs no server write of any kind, and
draft confirmation happens only inside the validated editor. The full-screen edit window
was also replaced by the site-wide side panel — see D41.] SHORTEN-PREVIEW ROOT CAUSE:
`.cb-resbar:hover/.sel` z-index 4 out-stacked the z-2 ghost, hiding the shorten band beneath
its own pill (extend bands sat outside the pill, masking the bug); fixed by suppressing pill
elevation while any drag session is live, plus a red HATCH band for removed nights and an
invalid state when shortening under the check-in cell's min-stay (same rule the server
enforces; commit is also client-blocked). EMPTY-CELL RANGE CREATE: pointer-drag across free
cells (mouse/pen only — touch pans; horizontal-dominant beyond 6px activates, vertical aborts
— explicit input rule in `createActivated`) paints a dashed brand band over WHOLE day cells
(`cellRangeGeometry`) with a live nights label, clamps to the cell min-stay, rejects
occupied/closed ranges (red band + toast, no window), and on valid release opens the wizard
prefilled (roomId/checkIn/checkOut); no DB writes before the wizard submits. CARD FIELDS
(supersedes D39's omission per the new reference): the reference `.ccbox` renders in step 3
and the editor. [Corrected in D41: transient-only card state was NOT sufficient — manual
card entry with protected server-side storage is now an explicit approved requirement.
The PAN is encrypted (AES-256-GCM) through a dedicated guarded action; CVV remains
prohibited and was removed from the form entirely; "סלוק עכשיו" stays permanently disabled
(no gateway → no charge) and saving a card never affects payment status.]
Step-3 additions: the reference's 4 payment chips drive REAL fields only (unpaid→paid=0,
paid→paid=total, partial→focuses the amount input, ממתין לאישור→creates the reservation as a
DRAFT — a status the create action already supports); the VAT line is display-only over the
VAT-inclusive total. [Corrected in D41: the previously hardcoded 17% was replaced by a
tenant-configurable VAT setting (Settings → שיעור מע״מ), initialized to 18.] Edit
window per edit-booking-modal.png: phone/mail field icons, room rows render as summary +
"החלף חדר" (select only while switching), quick actions = בצע צ׳ק-אין (same validated save
with status=checked_in) and העבר לחדר אחר (scrolls to the stays card). UNSUPPORTED reference
concepts documented and omitted rather than faked: header print/PDF/WhatsApp/email actions,
"שלח אישור הזמנה" quick action (no messaging infra), an ACTIVE charge button, and בסיס אירוח
(no board-basis model). TOOLBAR DATE PICKER: the reference bundle has none (nav-only
rangebox), so a design-language month popover was built (`cb-dpop`): label-button opens it,
Escape/outside close, day click navigates the board. DAY HEADER scaled to the supplied
screenshot (row 64px, weekday 11.5px amber on weekends, date 20px/800 in a 34×30 pill).
RTL BUG FIXED: fixed-position popups computed a physical viewport LEFT but applied it as
inset-inline-start under dir=rtl, mirroring them across the screen (tooltip, cell context
menu, closure popover — now physical `left`). Read-only hardening: StayEditor gained a
`disabled` prop so view-only editors expose zero enabled controls. Perf preserved and
re-measured on scripted 120-move drags: 59–60fps, worst frame 17–50ms, exactly ONE grid class
mutation per gesture (the threshold-cross React commit) — pointer moves stay ref+rAF+ghost.

## D41 — Phase-3 final correction (tenant VAT setting, protected card storage, side-panel restoration)
User-directed final pass over D40. TENANT VAT SETTING: the VAT display rate is now a tenant
business setting (`guesthub.tenants.settings` jsonb, key `vat_rate`, migration 007) edited in
the new /settings screen (nav הגדרות, gated by `settings.edit` in the UI AND in
`updateVatRateAction`), validated by ONE pure rule (`src/lib/vat.ts`: 0–50, ≤2 decimals,
malformed/negative/oversized rejected), initialized to 18 only where absent, audited
(`tenant_settings`/`update_vat_rate` with before/after), and rendered dynamically in the
booking wizard + editor as "מע״מ ({rate}%) — כלול" (trailing zeros trimmed). Displayed prices
remain VAT-INCLUSIVE; changing the setting changes the display line only and NEVER recalculates
existing reservations — there is still no tax accounting engine. PROTECTED CARD STORAGE:
manual card entry + persistence is now an explicit approved requirement (supersedes D40's
transient-only stance). One active card per reservation in `guesthub.reservation_cards`
(tenant+reservation FKs, UNIQUE(reservation_id)); the PAN is encrypted at the application
layer with AES-256-GCM (`src/lib/card-vault.ts`), fresh random 96-bit IV per value, ciphertext
`v1.<iv>.<tag>.<data>` carrying the key/format version for rotation; key from env
`CARD_VAULT_KEY` (never in DB, never client-side); missing key FAILS CLOSED (no plaintext
fallback — the save action refuses). brand/last4/expiry/holder are stored separately for
masked display; CVV is NEVER stored — it has no column, no form field, no payload field
anywhere (with no gateway there is no immediate authorization, so it is not collected at all).
Guarded server actions (`card-actions.ts`): save/replace + delete require
`payments.card_manage`; full-PAN reveal requires `payments.card_reveal` (new catalog keys,
migration 008; manage→super_admin/admin/manager/receptionist, reveal→management only) —
enforced server-side via requirePermission, tenant+reservation ownership re-verified, PAN
Luhn+length validated, expiry validated, nothing logged, PAN never in error text, save
returns masked metadata only. The normal reservation payload (`getReservationAction`) carries
masked metadata only and never selects `pan_encrypted`; reveal decrypts ONE card per explicit
request, is audited (`card_reveal`, no digits beyond last4 anywhere in audit), auto-remasks
on hide/panel close/reservation switch/45s inactivity. SAVING A CARD IS NOT A PAYMENT:
status, paid amount and payments rows are untouched; "סלוק עכשיו" remains permanently
disabled. This is encryption-at-rest + access control, NOT a PCI-DSS certification claim;
production must set `CARD_VAULT_KEY` (rotation = new key version + re-encrypt; deploy blocks
card features when unset) and serve over HTTPS only. SIDE PANELS RESTORED (supersedes D39/D40
full-screen deviation): the booking wizard and the reservation editor render inside the
site-wide `SidePanel` shell (55% desktop / full-width mobile, RTL slide from the left,
z-90 above all calendar layers, sticky header + action footer, focus trap, Escape) — the
calendar stays mounted and visible behind, scroll/range/filters preserved; `FullWindow.tsx`
and its window-only CSS were deleted; ONE `PanelState` in CalendarScreen is the single source
of truth (booking/edit/closure, one open at a time). Dirty forms get an explicit footer
discard-confirmation (the project's inline-confirm pattern) on Escape/X/overlay. TOOLTIP IS
INFORMATIONAL ONLY: the "אישור הזמנה" button and its mutation/loading state were removed —
the hover card performs zero writes; hover=info, click=edit side panel, status changes only
inside the validated editor. Checks: new `scripts/check-cards.mjs` (crypto round-trip, unique
IVs, tamper rejection, fail-closed, Luhn/brand/expiry/mask, VAT rules, source-level
sensitive-data assertions) + check-calendar-ui extended (tooltip has no write path, panels
use SidePanel, FullWindow gone, single panel state, z-order). Pointer architecture untouched
(capture + refs + rAF ghosts); panel open/close never remounts the grid.

## D42 — Rate Plans module + ONE central pricing engine (Phase 5)
Tenant-level Rate Plans extend guesthub.pricing_plans DUAL-SCOPE (migration 016): the
Phase-4A SU-scoped base plans stay the Rates-grid base ARI layer untouched (same
UNIQUE(pricing_plan_id, date), same writeRateCells ON CONFLICT — check-rate-grid G intact);
tenant-level plans have sellable_unit_id NULL, a tenant-scoped live-unique code, plan_kind
base | derived_percentage | derived_fixed | independent, parent_plan_id + adjustment_value
(a fixed ADJUSTMENT, never a fixed final price), refundability, policy links (012),
stay-date validity, booking window, arrival-DOW, plan-default restrictions, visibility and
archive state. Parent chains are guarded twice: pricing_plan_parent_guard trigger
(same-tenant, tenant-level parent, cycle rejection, depth ≤ 5) AND the engine re-guard.
Assignment = NEW pricing_plan_units (plan ↔ sellable unit; unique pair, active flag,
per-unit adjustment override, validity) — an assignment NEVER creates inventory; physical
availability stays derived (reservations/closures/status), so one reservation blocks the
room under EVERY plan. Exact-date data = NEW pricing_plan_unit_rates (plan, unit, date —
sparse; independent-plan prices AND per-date overrides + restrictions + note). A separate
overlay table (not a widened ppr key) was chosen deliberately: dev+prod share the DB, and
widening ppr's unique key would break the RUNNING prod grid writer between migration and
deploy. THE ENGINE (src/lib/pricing/: types, resolve [pure], messages [Hebrew layer],
engine.ts): calculateQuote(db, req) — batched loads only; price precedence
override → assignment-adjustment → plan-adjustment → parent-resolved → base (ppr →
room_type.base_price), every amount carries its source label; restrictions merge
base-layer + plan overlay through the SAME stayRestrictionViolation (now
stayRestrictionViolationStructured + Hebrew wrapper, messages byte-identical); extra
guests via the EXISTING canonical resolver + calculateChargeableGuests (included_occupancy
is the threshold, never default_occupancy; fails closed on unconfigured pricing); VAT
extracted from gross per lib/vat.ts (inclusive, whole-currency, tenant settings); cents
summing (no fp drift); deterministic sha256 quoteFingerprint over resolved commercial
values (no timestamps) + engineVersion 1.0.0. Structured PricingError codes (29) — no
message parsing, no silent fallbacks. UI: /rate-plans (rate_plans.* + pricing.simulate
permission keys, manager granted, admin bypass) — list with formula labels (planFormulaLabel,
never raw enums), 3-step wizard (live preview calls applyPlanAdjustment — the SAME central
util), overlay editor, and the simulator panel that calls the REAL engine
(simulateQuoteAction → calculateQuote, source pricing_simulator). Reservations/booking
UI/Channex NOT touched: manual reservations keep resolveStayPrice snapshots; future
consumers call the engine and store immutable quote snapshots (contract in §25 of the
phase brief). Checks: scripts/check-rate-plans.mjs (20 model/constraint checks, :5433) +
scripts/check-pricing-engine.mjs (35 checks: pure resolution rules compiled from the real
modules + end-to-end quotes on :5433, rolled back). NO real Rate Plans were fabricated —
the tenant starts with zero tenant-level plans and the screen shows the setup-required
state.

## D52 — Manual reservations & payments production closure: CVV retention removed, ledger reconciled, credit-aware balance

The manual reservation + payment flow is closed on the D51 canonical architecture
(calculateReservationPrice, immutable pricing snapshots, one payments ledger) — nothing in
the pricing/VAT/availability/snapshot path was rewritten. Three concrete gaps were fixed.

**(1) CVV/CVC retention removed entirely (§2).** Reverses D43's "CVV stored ENCRYPTED". The
system no longer collects, stores, encrypts, reveals, logs or audits a CVV — not even
encrypted. Removed: card-rules cvvValid/formatCvv/maskedCvv; card-vault
encryptCvv/decryptCvv; the cvv param + cvv_encrypted column write + reveal + hasCvv flag in
card-actions; the CVV input field and the masked/revealed CVV display in CardFields; the cvv
payload from BookingPanel/EditReservationPanel saves; has_cvv from getReservationAction; and
the channel ingest CVV paths (card-ingest, revisions, payloads — the PAN is still
encrypt-staged, any CVV is discarded; redactPayload still scrubs cvv/cvc from stored
payloads). Migration 018 records COUNT-ONLY remediation and permanently DROPs
guesthub.reservation_cards.cvv_encrypted (2 rows destroyed on prod) +
guesthub.channel_booking_revisions.card_cvv_encrypted (0). The gateway seam keeps a
transient cvv? field (a single live PSP authorization only, discarded immediately — hosted
fields preferred). No future write path remains.

**(2) Payment-ledger reconciliation (§6).** Root-caused a live balance bug: legacy seed rows
misused the RESERVATION state 'partial' as a PAYMENT-ROW status for real captured partial
payments, so the ledger (SUM FILTER status='paid') excluded them — stored paid_amount already
diverged from the ledger for 8 reservations, and the next payment/edit would have silently
wiped the collected amount. Canonical model: a payment ROW is
'paid'|'pending'|'failed'|'voided'|'refunded' (only 'paid' counts); partial/overpaid are
DERIVED reservation states. Migration 019 relabels 'partial'→'paid' (no money changes), adds a
CHECK constraint on the canonical set, and rebuilds paid_amount/balance from the ledger for
all reservations (0 divergent after). seed.mjs now writes 'paid'; ledger.ts exports
COLLECTED_PAYMENT_STATUS.

**(3) Credit-aware balance everywhere (§7/§9).** The calendar tooltip floored a negative
balance to ₪0. New ONE shared formatter in inventory-rules: balanceOf (NOT floored) +
formatBalance ({due|settled|credit}) + paymentState extended with 'overpaid'. The tooltip, the
reservation panel balance tile, the PaymentBadge, the calendar PAY_STYLE palette and the
payment legend all now show an overpayment as "זיכוי ללקוח -₪X" (customer credit), not a zero
balance. The DB ledger balance was already un-floored (D51) — this removes the display-only
divergence; the UI formats money but never computes commercial totals.

Extra-guest setting UNCHANGED and confirmed: tenants.settings.extra_guest =
{extra_adult/child/infant: 200, per_night, inclusive}, inherited by all 14 rooms (0
overrides). Not retroactively repriced.

Verification: build + tsc clean; check-pricing-equality 22/22 (manual create, all rate plans,
multi-room, extra guests, VAT, partial/full/overpayment credit, availability, snapshot
immutability, repricing-on-edit, override permission, ledger authority) on the isolated :5433
DB with the full 000→019 chain; check-cards, check-payments, check-channel-card-ingest,
check-calendar updated to assert CVV is GONE + credit semantics. Browser (headless, new build
on :3099, throwaway ZZQA data removed): no CVV field, ₪200 extra-guest line,
partial→full→overpayment showing "זיכוי ללקוח -₪200" in panel + tooltip + DB, 390px layout OK.
Public booking engine and Channex NOT started.

## D53 — Guest messaging platform (Gmail + WhatsApp) + booking action toolbar

The booking editor header action toolbar (email/WhatsApp/PDF/print/close) — documented-and-omitted in D40 "no messaging infra" — is now built on the ONE canonical messaging platform this repo lacked. No parallel systems; the editor depends on shared interfaces, never on a provider SDK.

REAL providers (per product decision): **Email = Gmail** (OAuth 2.0 API preferred, `users.messages.send`, no SDK — plain fetch; SMTP App-Password fallback via nodemailer). **WhatsApp = GREEN-API OR Twilio**, selectable per property in Settings, behind one `WhatsAppProvider` interface with separate adapters; the active provider is a NON-secret pointer in `tenants.settings.messaging`. Interfaces: `EmailProvider`/`WhatsAppProvider` (`src/lib/messaging/types.ts`).

SECRETS: `messaging_provider_connections.secret_ciphertext` — AES-256-GCM (`src/lib/messaging/secrets.ts`, key `MESSAGING_SECRETS_ENCRYPTION_KEY`, fail-closed, same construction as the card vault). Never returned to a client (actions expose `••••••••XXXX` hints only), never in logs/audit/errors. Provider config is super_admin-only (`canManageMessaging`, mirrors channels). Sends require `reservations.edit`.

HONEST STATUS lifecycle (`outbound_messages.status` CHECK): draft · validation_failed · provider_not_configured · queued · submitting · submitted · sent · delivered · read · failed · undelivered. "sent" ≠ mere acceptance: GREEN-API accept → `submitted` (delivery confirmed later by webhook); Gmail `messages.send` → `sent`; Twilio via `mapTwilioStatus`. Webhooks (`/api/messaging/webhook/{green-api,twilio}/[token]`) resolve tenant THROUGH the stored message (never the payload), verify authenticity (green-api token=webhookSecret/instanceId; twilio X-Twilio-Signature HMAC + accountSid path token), and are idempotent via `message_events (provider, dedup_key) UNIQUE` → monotonic `advanceMessageStatus`.

TEMPLATES: `message_templates` (channel-tagged email/whatsapp, editable, seeded Hebrew booking defaults). ONE canonical variable set resolved from the SAVED reservation (`src/lib/messaging/templates.ts`, `resolveBookingVariables`) — the composer reloads canonical data server-side on send, so unsaved edits never leak; a dirty booking is blocked with a Hebrew save prompt before send/PDF/print.

COMPOSER: full-panel OVERLAY inside the existing SidePanel (new optional `headerActions` + `overlay` props) — booking stays mounted, scroll preserved, no navigation. Custom + template modes, live preview, variable chips, provider-not-configured + missing-contact honest Hebrew errors, loading/success/failure states.

PDF: `@react-pdf/renderer` + bundled Rubik (Hebrew static Regular/Bold, `public/fonts/`) → true one-click `/api/reservations/[id]/pdf` download (`booking-<num>-<slug>.pdf`), full RTL, canonical data, masked card (last4 only — D52 removed CVV/PAN entirely), audited `pdf_generated`. PRINT: separate RTL A4 HTML route `/reservations/[id]/print` (outside the dashboard shell → no nav/sidebar), `window.print()`, audited `print`.

MIGRATION 020 (4 tables + seed) is NOT applied to the shared prod DB by this change — apply via the documented flow. Verified idempotent + constraints on the isolated :5433 test DB. Live sending stays "not configured" until per-property creds are entered in Settings (Communications). Runnable check: `scripts/check-messaging.mjs`.

## D64 — Channex inventory unit = the PHYSICAL ROOM (not the room category)

The old `/channels` metric "מיפוי סוגי חדרים 0/3" implied the three GuestHub room categories (סטודיו / סוויטה / חדר שינה וסלון) were the Channex inventory mapping unit. They are not — they are descriptive metadata. Mapping them would have produced 3 aggregated Channex Room Types and destroyed per-room identity, per-room pricing and per-room availability, which the whole GuestHub model is built on (rooms are independent products — D50/D51). The metric is replaced by four honest numbers: categories (3) · physical rooms (13) · mapped physical rooms (n/13) · Channex Room Types (n).

**Model:** one active physical room → one Channex Room Type → `count_of_rooms = 1`. `count_of_rooms` is the number of physical units of that Room Type, NOT date availability: Channex documents "Availability of all rooms created will be defaulted to 0". Nothing here pushes ARI.

**Canonical mapping:** new table `guesthub.channel_room_mappings` (migration 024). `channel_room_type_mappings` (005) keys on `room_type_id NOT NULL` and still anchors the room-type-scoped ARI machinery (`channel_dirty_ranges`, `channel_sync_state`, `sync-step.ts`), so it cannot represent a physical room without acquiring two mutually exclusive meanings. No generic local-entity mapping table existed. Uniqueness: `UNIQUE (connection_id, room_id)` (one mapping per tenant+provider+environment+room, since the connection is unique on those three) and a partial `UNIQUE (connection_id, channex_room_type_id)` (one external Room Type ⇄ one physical room).

**Occupancy (evidence, not assumption):** Channex `occ_children` = "Child only bed spaces … Children can sleep in adult beds also". GuestHub `rooms.max_children` = maximum children ALLOWED — proven by 5 of 13 live rooms having `max_adults == max_occupancy` with `max_children > 0` (1006, 1142, 1237, 1242, 1329) and 6 rooms with `max_adults + max_children > max_occupancy`. So `max_children` is never copied to `occ_children`. The one deterministic helper (`deriveChannexOccupancy`) is:
`occ_adults = max_adults` · `occ_children = clamp(max_occupancy − max_adults, 0, max_children)` · `occ_infants = max_infants` · `default_occupancy = min(rooms.default_occupancy, occ_adults)` (Channex forbids `default_occupancy > occ_adults`; room 1102 is capped 4→3 and the cap is shown in the preview — GuestHub's value is never rewritten). Missing/contradictory rooms (no `default_occupancy`, `max_adults < 1`, `max_adults > max_occupancy`, negative/non-integer capacity, no room category) are BLOCKED, never guessed.

**Title:** exactly `חדר <room_number> - <category name>` (normal hyphen, one space each side), validated against the documented 255-symbol limit. No tenant/db id, building, floor, "GuestHub" or "Staging".

**Safety:** creation happens in exactly ONE call site, inside an explicitly confirmed operator action. Channex does NOT reject duplicate titles, so a run REFUSES to POST whenever the property's Room Type listing is truncated, holds an unmapped external Room Type, or any room sits in an ambiguous state. Each room reserves a durable `creating` mapping row plus a deduplicated `create_room_type` job (key = property + room + operation) under a per-room advisory lock; no DB transaction is held across the network call. On 201 the external UUID is written to the job's `provider_task_id` BEFORE the mapping row, so an external-success/local-failure can never lose the entity. Ambiguous outcomes (timeout / network / 5xx / unparseable 2xx) mark the room `reconciliation_required` and STOP the run — never a blind retry. A refresh that returns a complete listing with zero unmapped Room Types is positive proof the room was not created, and only then does it become retryable. Runs are wall-clock bounded and resumable over the remaining rooms only. `DELETE /room_types` is never called. Runnable check: `scripts/check-channex-room-types.mjs`.

**Postal code:** `postal_code` is canonical on the Business Profile only (there is no Channex-only postal field). It is now a visible, editable text field in `/settings` → מיקום, placed after street/street-number and before city/country, auto-filled from Google Places when available. Channex reads `zip_code` from it via `buildChannexUpdatePayload`, and the PUT preview shows the change before it is sent.

## D65 — one local Rate Plan × mapped physical rooms → Channex Rate Plans (structure only, born unsellable)

The local GuestHub Rate Plan (tenant-scoped `pricing_plans` row, `sellable_unit_id IS NULL`) is defined ONCE and never duplicated locally. Each Channex Rate Plan belongs to exactly one Channex Room Type, and D64 fixed the inventory unit as the physical room — so every eligible local plan fans out to one external Rate Plan PER mapped room. The required set is always CALCULATED: `active channel-visible local plans × active mapped rooms` (today 4×13=52; adding a 5th plan makes it 65 with no code change). The per-unit "מחיר בסיס" rows are the internal pricing substrate, never channel Rate Plans. Eligibility: plan `is_active AND NOT is_archived AND is_visible_channels` (validity dates gate bookable nights, not the plan's existence); room `is_active` with a COMPLETE D64 mapping.

**Canonical mapping:** new table `guesthub.channel_room_rate_mappings` (migration 025). The 005 `channel_rate_plan_mappings` keys on the descriptive `room_type_id NOT NULL` + free-text plan code, so it cannot identify a (physical room × pricing_plans row) combination; it stays untouched (0 rows) and the ARI milestone will re-point `sync-step.ts` at the canonical table. Uniqueness: `UNIQUE (connection_id, room_id, local_rate_plan_id)` and partial `UNIQUE (connection_id, channex_rate_plan_id)`.

**Title:** exactly `חדר <room_number> - <local plan name>` (255-symbol limit validated). Channex requires titles unique per property, so two active plans sharing a trimmed name block their combinations (`validation_required`) rather than colliding.

**sell_mode = per_person (evidence, not assumption):** the pricing engine (engine.ts §11) computes `nightly total = plan base price + extra-guest fee × chargeable guests beyond rooms.included_occupancy` — "included_occupancy is the extra-guest threshold, default_occupancy is NEVER used for charging" — with flat per-night fees from `tenants.settings.extra_guest` (₪200). The nightly price therefore varies deterministically with adult count; `per_room` would silently lose additional-adult pricing. Options: one per possible adult count `1..occ_adults` of the mapped Room Type (from the verified D64 snapshot), exactly one primary at `min(included_occupancy, occ_adults)` — the occupancy whose price IS the base price. A room without `included_occupancy` fails closed here exactly as it does in the engine (`EXTRA_GUEST_PRICING_INCOMPLETE`).

**children_fee / infant_fee are NOT mapped:** GuestHub charges extra_child/extra_infant only for guests BEYOND the included occupancy; Channex fees are flat per-child/per-infant surcharges. Different semantics → nothing fabricated; the fields are omitted (Channex defaults "0.00") and child/infant channel pricing stays pending until ARI.

**Born unsellable:** every plan is created with `rate_mode: manual`, ALL occupancy option rates 0 (a placeholder, never a GuestHub price) and `stop_sell: [true×7]` (Channex accepts the 7-weekday boolean array at creation). No real price, availability, min-stay, restriction push, OTA cancellation-policy mapping, webhook or booking is issued; DELETE/PUT never called. The local plan's cancellation policy (`ללא דמי ביטול` → policy b9b395ce) is a GuestHub concept — creating the external plan does NOT configure a Booking.com/Expedia policy; that belongs to the channel-connection milestone.

**Durability (same construction as D64, hardened):** the parent run mutex (advisory lock + durable deduplicated `sync_rate_plans` job) is claimed BEFORE the external listing, so the listing, the ambiguity-clearing and every POST run strictly serialized. A complete listing with zero external-unmapped plans is positive proof that ambiguous (`creating`/`reconciliation_required`, external id NULL) combos were never created — they flip to retryable `failed`, making the single button self-healing after a timeout. Truncated listing / external-unmapped plans / pending reconciliation BLOCK the run (Channex duplicate titles make silent re-POSTs dangerous). Per combo: stale-item-job reaper → `FOR UPDATE` recheck → deduplicated `create_rate_plan` job (key = property+plan+room+operation) → persisted `creating` row → single POST (no txn across the network) → on 201 the external UUID lands on the job's `provider_task_id` BEFORE the mapping commit; post-commit audit is best-effort and can never downgrade a mapped combo. Ambiguous outcome → `reconciliation_required` + STOP. Runs are wall-clock bounded (25s); the minimal UI resumes automatically until done, creating ONLY missing combinations.

**Minimal UI (explicit scope correction):** one compact card on `/channels` — plan count + names, mapped rooms, required/mapped combination counts, errors only when present — one button (`יצירת תוכניות התעריף ב־Channex Staging`) and one confirmation dialog. No simulator, no pricing editor, no per-room table or per-plan buttons, no adoption UI (none needed while 0 external unmapped plans exist; an orphan would block creation with an explicit message and its UUID is preserved on the durable job). super_admin only, server-enforced. Runnable check: `scripts/check-channex-rate-plans.mjs`.

## D68 — the existing Bulk Update / Rate Plans workflows drive Channex ARI (no new operator surface)

**Scope correction discovered in the audit.** The Phase-3 ARI machinery keyed every dirty range, watermark and mapping on `room_type_id` → the three descriptive `room_types` categories. D64 fixed the Channex inventory unit as the individual **physical room** (13 rooms ⇄ 13 Channex Room Types) and D65 fixed the commercial unit as **(room × local Rate Plan)** ⇄ one Channex Rate Plan (52 mappings). `channel_room_type_mappings` and `channel_rate_plan_mappings` therefore held — and would forever hold — 0 rows, so `sync-step.ts` resolved `no_mapping` on every range and `drain.ts` could never emit a single value. Both, plus the pooled-availability / lead-SU-price builders in `payloads.ts` and the never-constructed `ChannelManagerProvider` factory, are deleted rather than left as a second, contradictory projection.

**Canonical reuse, not reimplementation.** `ari-projection.ts` owns no pricing, availability or restriction rule. Availability comes from `guesthub.sellable_unit_inventory()` — the same function booking validation, the occupancy calendar and the rate grid read (blocking reservations, closures, `rooms.status`/`is_active`, start-inclusive/end-exclusive). Nightly price comes from `resolveChainNightPrice()` + `resolveParentChain()`, which were **extracted out of `engine.ts` into the pure `resolve.ts`** so the quote path and the channel path are literally the same code. Restrictions come from `mergeRestrictionRows()`. Occupancy pricing (Channex `sell_mode=per_person`) comes from `calculateChargeableGuests()` + `roundMoney()`. `check-channex-ari.mjs` asserts the projected rate for **every** occupancy equals `calculateQuote()`'s `nightTotal` for the same (room, plan, night) — a divergence between what we sell and what we publish is a test failure.

**Outbox re-keyed (migration 027).** `channel_dirty_ranges` now names a `room_id` and, optionally, one `local_rate_plan_id` (NULL = every channel-visible plan of that room — what a Bulk Update means, since it writes the unit's BASE plan rows from which every derived plan is computed). `channel_sync_state` is dropped: the drain always recomputes the payload from current canonical state at send time, so a late or duplicate drain is naturally idempotent and a watermark could only drop a range. Ranges gained bounded retry (`attempts`, `next_attempt_at`, `last_error_code`, status `failed`).

**Hooks.** `writeRateCells` (the ONE path the Rate Grid and Bulk Update share) marks rates+restrictions per room, never availability. Rate Plan mutations mark the plan **plus its transitive children** (a derived plan's price is computed from its parent's resolved price) on their assigned rooms, and — on an assignment change — on the rooms observed *before* the write, so a dropped room is republished rather than forgotten. `savePlanOverridesAction`, which previously reached Channex not at all, marks its exact units/dates. Reservation create/modify/cancel/move mark old **and** new ranges; closures and room status mark availability over the published horizon (`ARI_HORIZON_DAYS`, in the import-free `ranges.ts` so no save path pulls in the HTTP client; 500 at the time of this entry — **720 since D111**: Beds24 rejects a range crossing its ~24-month limit wholesale rather than clipping it, so the horizon is pinned to the documented 24 months minus a 10-day margin).

**Withdrawal is a publication.** A plan that is archived, deactivated or hidden from channels is still projected — as `stop_sell` with no rate. Filtering it out would leave its Channex Rate Plan selling the last prices we published.

**Fail closed (§6).** A (room, plan, date) whose price cannot be resolved is never guessed, never zero, never copied from another room: it is published with `stop_sell` and NO rate, and the reason is reported. Channex requires `rate > 0`; a zero rate cannot leave the process (`validateAriBatch`).

**The 200-with-warnings trap.** Channex answers a partially-rejected ARI update with HTTP 200 and a populated `meta.warnings`. Treating that as success silently drops the rejected dates. A response carrying any warning is `partial`, never clean success: the affected ranges stay retryable, the connection is not activated, and only the warning **field names** + dates + entity UUIDs are stored — never the upstream text, body, headers or api-key.

**Delivery: a real PM2 worker, not a request hook.** `guesthub-channel-worker` (declared in `ecosystem.config.cjs`, compiled by `npm postbuild` → `dist/worker`) polls the durable queue every 20s. Next.js `after()` was rejected: synchronisation must continue when nobody is using the app, and one trigger avoids competing drains. There is no cron, no timer inside Next, and no HTTP trigger. Claims are atomic (`FOR UPDATE SKIP LOCKED`) and FIFO per connection; a crashed worker's claim expires after `JOB_LEASE_MINUTES` and is reclaimed. The worker also sweeps for due-but-unclaimed ranges each tick, so a transiently-failed range retries without waiting for the next operator save.

**Gate.** Only `state='active' AND outbound_sync_enabled AND NOT full_sync_required` is ever drained — reachable solely through the operator's Full Sync on `/channels`, which is the **existing** `requestFullSyncAction` behind the **existing** (previously disabled) button. A failed Full Sync dead-letters rather than auto-retrying: ARI is never re-sent without an operator click. Before the first Full Sync, `markAriDirty` is a no-op, so no backlog forms and nothing can be sent during development, tests, migrations or deployment.

**Not built (deliberately):** no ARI editor, simulator, preview grid, second calendar, wizard, per-room/per-plan sync button, new ARI settings category, or new pricing route. Prices, restrictions and availability remain editable only in Bulk Update (`/rates`) and Rate Plans (`/rate-plans`). No Channex Property, Room Type or Rate Plan is created; no OTA channel, webhook or booking functionality is added.

**Also fixed:** `check:channel-card-ingest` ran against **production** (`:5432`, no fail-closed guard) and had begun failing outright once a real Channex connection existed. It now targets `guesthub-testdb` (:5433) and refuses production markers like its siblings. Migration 005's `idx_dirty_pending` is now guarded on its column existing, so the whole migration chain stays replayable (every check script replays it).

## D69 — real, persisted progress for the existing Channex Full Sync

Progress lives on the EXISTING job row: `channel_sync_jobs.payload.progress` (the job id IS the run id; `status`/`started_at`/`finished_at` already existed). No new table, no new column, **no migration**. It is written with jsonb `||` so the `task_ids`/`warnings` the run records separately are never clobbered, and writes are throttled (phase change or terminal always flush; otherwise ≤1 write per 900 ms) — never one write per date. Because it is persisted, it survives a page refresh, navigation, a closed browser, a client disconnect and a web-process restart.

**One writer.** Only `runInitialFullSync` writes progress, and it only ever runs inside the PM2 channel worker. The web process reads. There are no competing writers, and no ARI calculation moved into the browser.

**Milestone-based percentage, never a timer.** `src/lib/channel/ari-progress.ts` is pure and *import-free*: it cannot reach `Date.now`, `performance.now`, `setInterval` or `new Date()` — a check asserts that at the source level. `phasePercent(phase, done, total)` interpolates inside a phase's band from REAL processed counts (rooms projected / total; (room × rate plan) combinations projected / total). A stalled run therefore stops advancing. Bands: validating 0–10, availability projection 10–30, availability submission 30–45, rates projection 45–75, rates submission 75–90, warnings/verification 90–97, activation 97–**99**. 99, not 100 — **only `completed` may be 100**, and it is reachable solely from a clean, warning-free run. A failed run FREEZES at the percentage it actually reached; it never shows 100.

To report the two projection phases honestly, `projectAri` gained an `include: { availability, commercial }` switch and an `onProgress` callback fired at room / combination boundaries (never per date). The fused single loop became two passes with byte-identical output — the price-equality check against `calculateQuote` still passes. The incremental drain now also skips the half it never needed, which is a free efficiency win.

**Warnings are not success.** A 200-with-warnings ends the run at `failed` with `errorCategory='partial_warnings'`, below 100%, and does **not** activate incremental sync. Availability-sent-but-rates-failed is surfaced as a partial failure that preserves the successful availability task reference and stops in `submitting_rates`.

**Duplicate prevention is the database**, not the button: the partial unique index `uq_jobs_idempotency` makes a second live `full_sync` row impossible; the action answers a duplicate with the ALREADY-ACTIVE run's id and status. The disabled button is cosmetic.

The UI extends only the existing ARI card: a determinate `role="progressbar"` (aria-valuenow/min/max, RTL, visible %), the phase label, started/elapsed time, real counters, and a note that the sync continues if the page is closed. Polling runs at 2.5 s **only while a run is live** and stops on completion, failure, no-run and unmount. No new page, no wizard, no log viewer, no fake timer bar. The percentage is read, never computed client-side.

## D70 — the "Java2026" credential-field defect: browser autofill, not GuestHub

**Proven source: (B) browser / password-manager autofill.** Evidence: `Java2026` occurs in **zero** tracked or untracked files, zero build output, zero git history and zero environment variables; the server-rendered `/channels` HTML contains no `Java2026`, no api-key and no ciphertext; the only DTO, `ChannexConnectionView`, exposes `apiKeyHint` alone; the React state initialised to `""` with no `defaultValue`, no seeding effect and no server prop. The page rendered exactly **one** `type="password"` input (`id="channex-key"`), permanently mounted, relying on `autocomplete="off"` — which Chrome and Firefox deliberately ignore on password fields. The browser filled its saved credential for the origin into it.

**The stored key was never overwritten.** It decrypts to a 64-character value that is not `Java2026`; `api_key_hint` derives from it; a live `GET /properties/options` returns **200** with 1 property accessible. The audit trail shows the last `channex_credential_replaced` (2026-07-09 21:59:08) was followed six seconds later by a successful test, and nothing since. No credential replacement occurred. The key was preserved untouched.

Fixes, strongest first:
1. **The replacement input no longer exists in the DOM until the operator clicks "החלפת מפתח API".** Password managers fill on page load; there is nothing to fill. It lives in its own component (`ChannexKeyReplacementForm`), so cancel/success *unmount* it and React destroys the value; a `key={mountId}` forces a fresh instance on every open.
2. `autocomplete="new-password"` on the input (managers offer to generate, they do not fill), a unique non-generic `name`/`id` (`channex-api-key-replacement-value` — never `password`/`apiKey`/`key`/`secret`), `spellCheck={false}`, `autoCapitalize="none"`, `autoCorrect="off"`, plus 1Password/LastPass/Dashlane opt-out attributes.
3. The saved key is **read-only text** — `מפתח API מוגדר: ••••IBaJ` — never an input value, never `value="********"`.
4. **Verify before persist:** `saveChannexApiKeyAction` authenticates the candidate against Channex (one `GET /properties/options`, never ARI) and writes it **only on 200**. A working credential can no longer be replaced by a rejected or unverifiable one — even if something did submit an autofilled value. On failure the operator is told the existing key was preserved.
5. A save can only happen from an explicit submit; the button is disabled while the field is empty. No effect ever calls the save action.

An off-screen autofill decoy was deliberately **not** added: it is unverifiable here, browser-version dependent, and a screen-reader hazard. The four structural defences above do not depend on browser cooperation.

`testChannexConnectionAction()` takes **zero parameters** by construction, so the replacement input, unsaved React state, query parameters, localStorage and cookies have no path into it; it and the new Full Sync preflight share one `probeStoredChannexKey(tenantId)` that decrypts the stored ciphertext. Every category (401/403/404/429/5xx/timeout/network/malformed/missing-key) has a fixed, safe Hebrew message and is rendered visibly, with `role="alert"`.

**Full Sync now fails fast (§7).** `requestFullSyncAction` probes the stored key *before* creating the job row, and `runInitialFullSync` re-authenticates during `validating` before it projects anything — so a job enqueued before a credential rotated can never reach an ARI request. A rejected key produces: no run, no projection, **no ARI**, a bar frozen below 10%, and a visible `unauthorized` message.

## D76 — Channex inbound booking import: feed → revision → canonical reservation

**The dormant Phase-3 inbound foundation was activated, not rebuilt.** `channel_booking_revisions` (005/010), `persistBookingRevision` / `quarantineRevision` / `markRevisionImported` / `markRevisionAcknowledged` (revisions.ts), the webhook route, and the `pull_booking_revisions` job type all existed with no caller. D76 adds the caller: a real worker job in the existing PM2 `guesthub-channel-worker` that pulls the property-filtered Booking Revision Feed oldest-first, persists each revision idempotently, imports it in ONE transaction, and acknowledges it only after that transaction commits. The webhook stays a wake-up signal (validate token → persist redacted event → enqueue the same pull job → return); a low-frequency fallback poll inside the existing worker loop (5 min, deduped by idempotency key) means a missed webhook can never lose a booking.

**Identity.** One reservation per (channel_connection_id, external_booking_id) — a partial unique index (migration 029, additive), not application code. Revisions map rooms by external UUID through the canonical D64 `channel_room_mappings` (Channex Room Type → physical room) and D65 `channel_room_rate_mappings`; the room-type-keyed Phase-3 mapping tables and `channel_inventory_holds` stay untouched and unused — under the physical-room model an OTA booking lands directly on its one mapped room, so no "unassigned lane" exists.

**Revision behavior.** NEW creates the one canonical reservation + reservation_rooms (channel price is authoritative: `is_manual_rate=true`, `pricing_snapshot NULL`); MODIFIED updates the SAME reservation, releasing old and consuming new occupancy atomically (operator-advanced `checked_in`/`checked_out` are preserved); CANCELLED cancels — never deletes — with the same release semantics as the local cancel action. Every import runs `lockRooms` + `check_room_availability` (excluding only its own rows) and marks ARI dirty in the same transaction, so Channex availability stays consistent through the existing outbound machinery. Unmapped room, wrong property, or a local conflict → visible quarantine on the revision row (never a guessed room, never an overwritten local stay, never an ack).

**Card safety.** The normal endpoint's masked guarantee is stored as metadata only (brand, derived last4, expiry, holder, virtual flag, masked display) on the revision row — a masked string never enters a PAN field and no reservation_cards row is created without a real encrypted PAN. `raw_message` (which embeds masked card text) joined the redaction list. CVV is never read, staged, or stored (D52 unchanged). Hotel-collect arrives honestly unpaid: no payment row is fabricated; balance derives from the ledger.

**Operator surface.** /channels gained one compact inbound card: enabled state, webhook registration, last import/pull, pending pull, imported/unacked/quarantined counts, last sanitized error, and a super_admin "משיכת הזמנות עכשיו" that only enqueues the same idempotent durable job. Enabling inbound generates the hashed per-connection webhook token and registers the Channex webhook (`event_mask=booking`, `send_data=false`); registration failure is a warning, not a blocker — the poll alone imports everything.

Verified by `scripts/check-inbound-bookings.mjs` (16 assertions on the isolated :5433 DB): lifecycle, idempotent duplicate delivery, ack-after-commit and ack-impossible-before-import, quarantines, tenant isolation, fallback poll, worker retry, masked/real card handling, calendar visibility through the calendar's own query.

---

## Program hardening + certification (Stages 2–7, 2026-07-18)

The 7-stage hardening program (branch `feat/pms-hardening-channex-certification`, draft PR #92) established these canonical decisions. Full detail in `docs/program/` (charter, V2, STATE, per-stage reports) and `docs/architecture/adr/`.

**Sources of truth (ADR-0001).** One resolver per concern: pricing via `calculateReservationPrice`; availability via `sellable_unit_inventory`/`room_type_inventory`/`check_room_availability` (physical room, 0/1 model — D64); Channex base URL via `config.channexBaseUrl(env)`; balance via `recomputePaymentAggregates`. No second writer/reader for any of these.

**Safety boundaries (V2 §3).** Dev/prod share the shared supabase-db (:5432) — it is READ-ONLY for this program; all migrations/destructive work run only on the dedicated staging DB (:5434) or disposable (:5433). No production cutover, no Channex production activation, no merge/deploy. 45 migrations replay from zero (proven).

**Integrity (Stage 3).** Double-booking is impossible at the DB (exclusion constraint, proven under concurrency); payments derive from one ledger formula; refunds are negative contra rows; tenant isolation is server-side canonical + a data backstop.

**Channex (Stage 4).** Environment routing is crossover-proof (one resolver); production is guarded off by `CHANNEX_PRODUCTION_ACTIVATION` (built + inactive); an append-only evidence ledger records Task IDs for every scenario; Full Sync = 500 days / 2 requests with a 10MB byte preflight; rate limits are handled by a 429 cooldown + circuit breaker; inbound bookings ACK only after commit. Live cert execution needs a Channex Staging channel (external dependency, V2 §2).

**PMS capabilities (Stage 5).** Housekeeping tasks auto-generate on checkout; maintenance OOO removes availability + syncs while OOS stays sellable; one unified task store (no per-module fork); reports are read-only server-side with injection-hardened CSV; tourist VAT zero-rating + guest anonymization (Amendment 13) + a fail-closed invoice seam.

**Security/ops (Stage 6).** No secrets in code or git history; dependency audit clean; runtime pinned; PAN + log retention purges (H8/H11); performance measured (500-day projection ~13ms); observability + actionable alerts documented. Zero unresolved Critical/High; residual Medium/Low documented with plans.

**Verification discipline.** Every claim is guarded by a runnable `check:*` script; each stage was independently verified by Agent N (a non-implementing verifier) before its tag. No implementing agent self-certifies.

---

## Mobile Readiness Audit — scope reconciliation (2026-07-19)

**Module list mismatch (resolved by auditing what exists).** The audit brief named 17 modules (automations, billing, bulk-update, documents, finance, maintenance, permissions, rate-plans, reports, reservations, rooms, settings, staff, suppliers, calendar, channels, dashboard, guests, housekeeping). The live app under `src/app/(dashboard)/` has **14**: calendar, channels, communications, dashboard, guests, housekeeping, permissions, rate-plans, rates, reservations, rooms, settings, staff, tasks. Non-existent in code: automations, billing, bulk-update, documents, finance, maintenance, reports, suppliers. Not in the brief but present: communications, rates, tasks. Mapping: the brief's "bulk-update / yield / rate-grid" = the **`rates`** module. Decision: audit the 14 modules that exist; `claude/MOBILE_AUDIT.md` is authored against the real routes.

---

## D77 — Hospitable as second channel provider (dispatch-by-provider, no interface)

**Why.** Booking.com certification via Channex stalled on external staging provisioning (STATE.md). The operator connected the properties through Hospitable — itself a channel manager fanning out to Airbnb/Booking/Vrbo — so GuestHub integrates with ONE upstream: pushes price+availability+min-stay to Hospitable's per-property calendar and imports reservations from it. GuestHub remains the ARI source of truth from day one. Channex code, tables, and behavior are untouched; both providers coexist per tenant (`UNIQUE (tenant_id, provider, environment)` already allows it).

**No provider interface — deliberately.** Consistent with D68 (the dead `ChannelManagerProvider` factory was deleted), the second provider is per-provider modules (`hospitable-*.ts` mirroring `channex-*.ts`) plus explicit `provider` dispatch at exactly three seams: `worker.ts#runJob`, the worker's connection loaders, and provider-named admin actions. The provider-neutral core — outbox → `channel_dirty_ranges` → `channel_sync_jobs` → PM2 worker, `projectAri`, evidence ledger, circuit breaker, quarantine — is reused verbatim.

**Model mapping.** Hospitable has no room-type/rate-plan axes: one physical room (sellable unit) ↔ one Hospitable property UUID (`channel_hospitable_property_mappings`, migration 044) plus ONE designated local pricing plan whose base-occupancy rate is the pushed price. `stopSell` → `available:false`; CTA/CTD → `closed_for_checkin/checkout`; `minStayArrival` → `min_stay`. Prices push as integer cents.

**Inbound without a feed.** Hospitable exposes reservation GETs + UI-registered webhooks — no revision feed, no ack. Inbound reuses `channel_booking_revisions` with a synthetic content-hash revision id (`"{reservation_uuid}:{sha256(payload)[:16]}"`): the existing `UNIQUE (connection_id, provider_revision_id)` makes re-polls idempotent, and a changed reservation naturally produces a new revision row → the D76 modified-import path. Rows insert pre-acknowledged. The webhook stays a wake-up signal; the 5-minute fallback poll is the correctness backstop. The post-normalize import core was lifted out of `booking-import.ts` as `importNormalizedRevision` (pure mechanical extraction; Channex path behavior-identical).

**Production-only + PAT expiry.** Hospitable has no sandbox — `environment='production'` is the only value for hospitable rows, and every write reaches live OTA listings; the D-gate (nothing drains before an operator Full Sync) plus a read-scope-first rollout bounds the blast radius. PATs are JWTs expiring after one year: `exp` is decoded at save time into `channel_connections.api_key_expires_at` and the /channels UI warns ≥30 days ahead. Webhooks carry no HMAC — authentication is the existing hashed webhook-token URL (source IP range 38.80.170.0/24 optionally allowlisted at nginx).

---

## D87 — Reservation-card UX: holder auto-fill, paid-amount default, CVV restored, full-card auto-reveal

**Owner decision (Ronen), made with the trade-off stated explicitly.** Four changes to the one credit-card section (D86) and the payment block, driven by the front-desk flow of keying card details into an EXTERNAL terminal (no PSP is integrated in GuestHub).

1. **Holder auto-fill.** שם בעל הכרטיס now defaults to the guest's `firstName lastName`, editable. BookingPanel syncs it via an effect until the operator edits the field (a `holderTouched` ref); EditReservationPanel seeds it when the operator opts into manual entry.

2. **Paid-amount default = total (create only).** In BookingPanel סכום ששולם defaults to the running סה״כ לתשלום until the operator edits it or picks another payment chip (`paidTouched` ref). Deliberately NOT applied to EditReservationPanel: its "תשלום נוסף" field feeds the append-only ledger, and auto-defaulting it to the balance would record a phantom payment on any incidental save.

3. **CVV storage restored — reverses D52 for the MANUAL card only** (migration 047 re-adds `reservation_cards.cvv_encrypted`; migration 018 is the drop template). Encrypted at rest with the same AES-256-GCM vault (`encryptCvv`/`decryptCvv`), validated 3–4 digits, never logged/audited/echoed, returned only by the audited reveal. The channel-ingest path is UNTOUCHED — an OTA-attached card is always `cvv_encrypted IS NULL`, and the only cvv column in the schema is the manual card's.
   ⚠️ **PCI-DSS Req. 3.2 ceiling:** retaining a CVV after authorization is a violation. This is accepted ONLY because no PSP authorizes inside GuestHub. The moment a real gateway is wired, DROP the column again and collect the CVV transiently per-authorization.

4. **Full-card auto-reveal (D52 masking friction removed).** For a viewer with `payments.card_reveal`, a stored card's PAN + CVV are shown automatically on open — the audited `revealReservationCardAction` fires once per stored card (still permission-guarded, still audit-logged), and the inactivity auto-mask (`REVEAL_TIMEOUT_MS`) is gone. Encryption-at-rest is unchanged; the manual hide affordance remains; values still drop from client state on card/reservation switch and unmount.

The D52/D87 guardians (`check-cards.mjs`, `check-channel-card-ingest.mjs`) were flipped to assert the new manual-path behavior while still proving the channel path carries no CVV.

---

## D88 — Drag-and-drop dispatch board for /housekeeping + /tasks (the PMS board, reproduced)

**Why.** The two manager boards were flat lists with a per-row assign `<select>`. The owner wanted the PMS housekeeping dispatch board — columns per worker, drag a task onto a worker to assign, drag inside a column to reorder — reproduced faithfully in GuestHub.

**No new task store.** The board runs on the existing unified `housekeeping_tasks` table (D-Stage5 §9). Migration 048 adds only `order_index integer NOT NULL DEFAULT 0` (+ `(tenant_id, assigned_to, order_index)` index) — the persisted manual order, the same contract the PMS board uses. `/housekeeping` renders `scope="housekeeping"` (type-locked cleaning queue), `/tasks` renders `scope="all"` (every type, with a type filter + free-type create); both are the same `TaskDispatchBoard` client component on the same guarded Server Actions.

**Server Actions (housekeeping.manage).** `getTaskBoardAction(scope, date)` groups tasks into `byUser` + `unassigned`, columns = active users; date rule mirrors PMS (today → every active task; another day → that day's tasks by checkout/due). `assignTaskAction` now renumbers the destination bucket by natural sort (urgent → soonest checkout/due → age) so a dropped card lands in its natural place; `reorderTasksAction` persists a manual in-column order via `unnest … WITH ORDINALITY`; `setTaskStatusAction` / `updateTaskAction` / `deleteTaskAction` back the card pills and edit panel. Cleaner lifecycle (pending→in_progress→completed→inspected) is unchanged — `completed→inspected` stays the dedicated verify action.

**Drag engine ported verbatim.** The load-bearing concurrency machinery from the PMS board is copied exactly: three sensors (mouse 8px / touch 250ms long-press / keyboard), `pointerWithin`→`closestCenter` collision, the `dragSourceRef`/`dragDestRef`/`loadSeq`/`dragInFlight` quartet, the `onDragOver` optimistic move with the anti-bounce guard, 5s polling paused mid-drag, and Hebrew screen-reader announcements. Adapted to GuestHub: its own tokens (`bg-primary`/`bg-primary-050`/`bg-surface`/`border-line`), the canonical `SidePanel` (`open` prop) for the edit/create panels, an inline delete-confirm strip (GuestHub idiom, avoids the panel's blur/containing-block trap), no areas/image/guest-count axes (GuestHub schema has none), and `dnd-kit` added as a dependency. The old `TasksBoard.tsx` + `data.ts` were removed.

---

## D88.1 — Boards scoped by worker role; /tasks removed

**Columns are workers of the board's type, not "everyone".** `/housekeeping` columns = users with role key `cleaner`; `/maintenance` columns = users with role key `maintenance` (new system role "עובד תחזוקה", migration 049, seeded with `housekeeping.my_tasks` like the cleaner role — added to `scripts/seed.mjs` and `role-meta.ts` too). Managers, reception, admins and super-admins are never board columns. A task assigned to a non-worker of that board falls back to the unassigned pool (visible + reassignable), never an invisible bucket.

**`/tasks` deleted.** The unified "all types" board was not the right spec — a separate tasks module will be built elsewhere. Removed: the route, the sidebar item, and the `scope="all"` path (type filter chips, free-type create, the null type filter in `getTaskBoardAction`). The board now has exactly two type-locked scopes; `/tasks` revalidations were repointed to `/maintenance`. The `housekeeping_tasks` store, the auto-generation on checkout, and the `general` task_type value are untouched.

---

## D89 — סטטוס העבודה "הזמנה אושרה" מעיד על תשלום מלא (תצוגת טבלת ההזמנות)

**החלטת בעלים (2026-07-20, דיוק 2026-07-21).** סטטוס **העבודה** `approved` ("הזמנה אושרה") — ורק הוא — מעיד על תשלום מלא: **טבלת ההזמנות** מציגה הזמנה כזו כ"שולם מלא" עם יתרה 0, בלי קשר ל-ledger. כל עוד ההזמנה לא הועברה ל"הזמנה אושרה" (ישלם בהגעה / יתרה בהגעה / ממתין לאישור וכו') היא מוצגת לפי מצב התשלום האמיתי מה-ledger. הכלל אינו נגזר מסטטוס מחזור החיים (`confirmed`) — ניסיון ראשון שנגזר ממנו תוקן. המימוש: `displayPaymentState()` ב-`src/lib/inventory-rules.ts` (מקור יחיד), בשימוש ב-read model של `/reservations` (שורות, טאבי לא-שולם/חלקי, ופילטר התשלום — כולם מאותו כלל, כך שטאב לעולם לא סותר את השורות שהוא פותח).

**מה לא השתנה:** ה-ledger (`guesthub.payments`, `paid_amount`, `balance`, גבייה, PDF, פאנל ההזמנה) נשאר אמת חשבונאית — שום רשומת תשלום לא מפוברקת. "שולם ביתר" (זיכוי לאורח) לעולם לא מוסתר (D52 §7).

---

## D90 — כלל ה-Concurrency שורד רגנרציית קטלוג: CLAUDE.md הוא הבית הקנוני

**הבעיה.** סעיף "Concurrency — עבודה במקביל על אותו ריפו" (נוסף ידנית ב-`12ed557` אחרי שקומיט בלע עבודת CVV/PSP לא-מקומטת של סוכן אחר) נמחק בשקט מ-AGENTS.md: רגנרציית הקטלוג (`gen-catalog.sh` דרך `/master`) דורסת את הקובץ **כולו** מתבנית — אין סמני BEGIN/END — והתבנית לא כוללת את הסעיף. המחולל והתבניות חיים בקיט `~/DevOPS/` על ה-hub `ai2u-vs1` (rsync ל-~44 שרתים, cron 07:00+19:00) ואינם נגישים מהשרת הזה, כך שכל תיקון מקומי ב-AGENTS.md הוא זמני מיסודו.

**ההחלטה (הגנה בשכבות).**
1. **CLAUDE.md = הבית הקנוני של הכלל** — מתוחזק ידנית/ב-`/init` בתוך הריפו ואינו נדרס ע"י מחולל הקטלוג. הסעיף הוכנס אחרי כללי הברזל, אחד-לאחד מ-`12ed557`.
2. **AGENTS.md שוחזר** (מעל הקטלוג המרוגנר, 97 skills / 50 agents) — זה מה ש-Codex/OMX קוראים; מחיקה עתידית צפויה ומכוסה ע"י השומר.
3. **שומר `check:agents-concurrency`** (package.json) — grep שנכשל ברעש אם הסעיף חסר מ-AGENTS.md או מ-CLAUDE.md, עם הוראת שחזור.

**⚠️ Action item פתוח (hub בלבד):** להוסיף את הסעיף לתבנית ה-AGENTS.md בקיט `~/DevOPS/` על `ai2u-vs1` (`git commit && git push && kit-push`) כדי שכל רגנרציה בכל הצי תכלול אותו. עד אז — כל `/master` מקומי ימחק את העותק ב-AGENTS.md והשומר יתריע.

---

## D91 — ערוץ הפצה יחיד: Beds24. הסרת Channex ו-Stripe במלואם

**החלטת בעלים (2026-07-24).** Beds24 הוא מנהל הערוצים היחיד — חי בפרודקשן, קולט הזמנות מ-Booking.com ב-polling (job `pull_booking_revisions`) ושולח ARI יוצא (`sync_ari_range`/`full_sync`). Channex ו-Hospitable הוסרו לחלוטין: קוד, UI, סקריפטים, ותלויות.

**מה נעשה (בענף `chore/remove-channex-stripe`, worktree מבודד, אפס נגיעה בפרודקשן הרץ):**
1. **השבתה קודם כול (שלב A):** שני ה-UPDATE-ים הממוקדים העבירו את חיבורי `channex` (staging) ו-`hospitable` (production) ל-`state='paused'`, `outbound_sync_enabled=false`. אומת: 15 דקות ללא ג'וב חדש שלהם, Beds24 ממשיך להצליח.
2. **`channex-http.ts → channel-http.ts`** — שכבת ה-HTTP הגנרית שכל מודולי Beds24 מייבאים ממנה. שינוי-שם בלבד (קובץ + סימבולים), לפני כל מחיקה, כדי שהנתיב החי לעולם לא יישאר בלי תלות.
3. **worker Beds24-בלבד:** `booking-import.ts` צומצם לליבת הייבוא המשותפת (RoomResolver חובה); `booking-normalize` נוטרל (`externalRoomId`); `DrainSummary` עבר ל-`ari-projection.ts`; מתאמי Channex+Hospitable נמחקו; ל-worker נותרה דיספאץ' של Beds24 בלבד, וכל ספק אחר עושה dead-letter.
4. **UI:** `/channels` מציג את קונסולת Beds24 בלבד + כרטיס שינויי-ה-OTA (ניטרלי) + בריאות התור. כל סקשן Channex/Hospitable, בורר-הספק, ו-route הווב-הוק (`/api/channel/webhook`) + ה-bypass ב-middleware נמחקו (Beds24 הוא poll-only).
5. **Stripe:** `payments-admin.ts` (זרימת "Stripe Tokenization" של Channex, D77 §E) נמחק — היה מת (אפס מייבאים; migration 051 כבר דוחה `provider='stripe'`). **הטווח הסגור (Cardcom/Tranzila, card-vault, cvv_encrypted) לא נגע.**
6. **דיווח OTA בביטול הזמנה:** `reporting-admin`/`reporting-rules` (כפתורי דיווח כרטיס-לא-תקין/no-show ל-Booking.com דרך Channex API) נמחקו — לא היה להם backend עובד ל-Beds24. `CancelReservationDialog` שומר ביטול מקומי + ההודעה הכנה שביטול OTA מתבצע ב-Booking.com וחוזר כרוויזיה מבוטלת.
7. **סקריפטים:** 18 גרדיאני `check-channex-*`/אינטגרציית-Channex נמחקו; 17 גרדיאנים גנריים עודכנו ל-Beds24.

**מה נשאר במכוון (לא ניתן להסרה ללא מיגרציה — אסורה בטווח):** שמות עמודות ה-DB ההיסטוריים `channel_room_mappings.channex_property_id`/`channex_room_type_id` ו-`channel_room_rate_mappings.channex_rate_plan_id` (migration 024/025). ה-/rates grid עדיין קורא מ-`channel_room_mappings` דרך `grid-state.ts`. שינוי-שם ידרוש מיגרציה נפרדת. גם דוחות היסטוריים (audit/program/certification) שמתעדים מצב-עבר עם Channex נשמרים כרשומה היסטורית, כמו מיגרציות.

**מה לא השתנה:** סכימת ה-DB (אפס מיגרציות), טבלאות הערוצים, `CHANNEL_SECRETS_KEY`, וכל נתיב ה-Beds24 החי — כל שינוי בו היה שינוי-שם-יבוא בלבד.

---

## D92 — גבול ציור ביומן: יום היציאה שייך לפס (check_out >= from), המלאי נשאר חצי-פתוח

**הבאג (2026-07-24).** הזמנה שיוצאת ביום הראשון של הטווח המוצג (למשל יציאה היום כשהיומן נפתח על היום) לא צוירה כלל: תנאי המשיכה ב-`calendar/data.ts` היה `check_out > from` — חפיפת *לילות* חצי-פתוחה `[check_in, check_out)`, שמחזירה FALSE כש-`check_out = from`. הוכח על הזמנה 1020 (יציאה 24.07): התנאי הישן החזיר 19 שורות בלעדיה, `>=` מחזיר 20 כולל.

**ההחלטה.** ליומן יש **סמנטיקת גבול לציור** רחבה מסמנטיקת המלאי: הפסים רצים מאמצע-תא לאמצע-תא (`barGeometry`), ולכן הזמנה "נוגעת" ויזואלית גם ביום ה-check_out — חצי-סלוט היציאה. שאילתות ה-read-model של היומן (stays, closures, holds — שלושתן ב-`data.ts`) משתמשות לכן ב-`check_out >= from` בגבול ההתחלה. **כל שאר המערכת** (check_room_availability, KPIs, מחוון תפוס/פנוי, rangesOverlap) נשארת חצי-פתוחה — יציאה היום איננה תפיסת לילה.

**מה לא נדרש.** שכבת הרינדור לא שונתה: `barGeometry` כבר עושה clamping מלא (`clippedStart→start=0`, חצי-סלוט למקטע יציאה, `width=1` לחוצת-טווח) וה-CSS `cutR`/`cutL` כבר קיים. drag/resize עובדים על התאריכים האמיתיים של ההזמנה (לא החתוכים); ידית resize קיימת רק בצד היציאה — **אין בכלל ידית check-in**, ולכן אין מה לנטרל לפס חתוך.

**מחוון תפוס/פנוי (נבדק, לא שונה).** `occupiedNow` ב-RoomRow מחושב מאותה שליפה אך עם פרדיקט לילות משלו (`check_in <= today && check_out > today`) — חדר שיש בו רק יציאה היום מוצג "פנוי" הלילה, נכון גם לפני וגם אחרי התיקון.

---

## D93 — ביטולי OTA: פילטר status מפורש, reconciliation מחזורי, ופתח מילוט מפוקח

**הבאג (2026-07-24, הזמנה 1021).** `GET /bookings` של Beds24 **אינו מחזיר הזמנות מבוטלות כברירת מחדל**. שני חלונות המשיכה (אינקרמנטלי + backfill) לא שלחו פרמטר `status`, ולכן ביטול ב-Booking.com מעולם לא הגיע ל-import — ההזמנה נשארה `confirmed`, חסמה את החדר בלוח, וה-ARI היוצא המשיך להקרין תפוסה לכל הערוצים. ניואנס קריטי: `status=a,b` (CSV) מחזיר HTTP 400 — רק פרמטרים חוזרים (`status=a&status=b`) מתקבלים. שליפה לפי `id` מחזירה כל סטטוס.

**שלוש שכבות הגנה (בסדר הזה):**
1. **התיקון בצינור** — `BEDS24_STATUS_FILTER` (כל ששת הסטטוסים, פרמטרים חוזרים) על שני החלונות. סופרסט של ברירת המחדל: שום דבר שהגיע קודם לא אבד; מבוטלות זורמות עכשיו דרך `applyCancellation` הקיים.
2. **Reconciliation מחזורי (20 דק')** — `runBeds24BookingReconciliation` משווה כל הזמנה חיצונית תופסת מול סטטוס המקור לפי `id`. פער (מבוטלת במקור, תופסת אצלנו) משוחרר **אך ורק דרך המשיכה הממוקדת → המסלול הקנוני** + רישום בולט `cancellation_reconciled`. מדיניות: `checked_in` לעולם לא משוחרר אוטומטית — התראת `cancelled_at_source_checked_in` והחלטת מפעיל; היעדרות הזמנה מהתשובה איננה ראיה לביטול — רק סטטוס `cancelled` מפורש משחרר. מתוזמן בתבנית הג'ובים הקיימת (`reconcile_inventory`, idempotency per-connection) — בלי cron ובלי טיימר.
3. **פתח מילוט מפוקח** — `releaseChannelReservationAction` + כפתור בדיאלוג הביטול (ענף ה-OTA): מותר **רק** כשבדיקה חיה מול Beds24 מאשרת שההזמנה מבוטלת במקור; audit מלא של המפעיל; השחרור עצמו הוא אותה משיכה ממוקדת קנונית. `checked_in` חסום גם כאן.

**שומר:** `check:beds24-cancellation-sync` — mock שמקודד את חוזה Beds24 האמיתי (ברירת מחדל בלי מבוטלות, CSV→400) ולכן נכשל על קוד לא-מתוקן; תרחיש staging מלא על testdb דרך מודולי ה-dist האמיתיים: קליטה → ביטול במקור → שחרור בתוך מחזור אחד; פער-חלון → reconciliation; אורח בצ'ק-אין → התראה בלבד; ואינווריאנט הסיום — אפס מבוטלות-במקור-תופסות.

---

## D94 — שינוי בסינון משיכה מזיז סיכון בין מסלולים: כל שער תלוי-סטטוס חייב מעבר

**מה קרה.** התיקון של D93 (`BEDS24_STATUS_FILTER`, שכבה 1) עשה בדיוק את מה שנועד לעשות — הביא ביטולים לצינור. באותה תנועה הוא הפך את המסלול חסר-השער למסלול הראשי: `applyCancellation`, גרעין הייבוא, מעולם לא בדק `checked_in`. לפני D93 זה לא הזיק, כי ביטולים כמעט לא הגיעו לשם; אחריו כל ביטול OTA מגיע לשם תוך חמש דקות, כולל ביטול של אורח שנמצא פיזית בחדר.

בו-זמנית התיקון הפך את השער של D93 עצמו (שכבה 2, `runBeds24BookingReconciliation`) ל-dead code **בתרחיש הזה בלבד**: אחרי שה-pull הפך את השורה ל-`cancelled`, שאילתת ה-reconcile (`status IN ('confirmed','checked_in')`) כבר לא בוחרת אותה. שלוש שכבות ההגנה נראו שלמות בקוד, ובפועל השכבה שבאמת רצה לא הכילה את הכלל.

**הדפוס.** שינוי בסינון משיכה אינו שינוי בכיסוי — הוא **הזזה של סיכון בין מסלולים**. משיכה שמתחילה להחזיר סוג רשומה חדש משנה איזה קוד רץ בפועל, ולכן מבטלת את ההנחות של כל שער שמותנה בסטטוס — גם שערים שנראים ירוקים וגם שערים שהשומרים שלהם עדיין עוברים.

**הכלל.** כשמשנים סינון של משיכה נכנסת (סטטוס, טווח תאריכים, lookback, מיפויים): עוברים על **כל** שער שמותנה בסטטוס בצינור, ומוודאים שהוא נמצא במסלול שהמשיכה החדשה מפעילה בפועל — לא רק שהוא קיים איפשהו. שער שהיה מיותר לפני השינוי יכול להיות היחיד שקיים אחריו, ולהפך.

**תיקון (PR #112).** הפרדיקט חולץ למקום אחד (`blocksAutomaticRelease` ב-`inventory-rules.ts`) ושלושת המשטחים צורכים אותו. שער ה-reconciliation **נשאר** — הוא לא מיותר: הוא מכסה את פער-החלון (ביטול שנחתם לפני יותר מ-`LOOKBACK_DAYS=7` לעולם לא מגיע ל-`applyCancellation`), וכשחדר ההזמנה אינו ממופה `runBeds24InboundPull` נעצר לפני כל ייבוא — נמדד: אפס התראות D93 מכל מקור אחר. שני השערים מתועדים במקור זה כנגד זה, ו-`check:beds24-checkin-cancellation-guard` מפריד במפורש בין אסרשנים התנהגותיים (מה קרה ב-DB) לבין אסרשני מבנה/הגנה-לעומק, כדי שאדום עתידי יתאר את מה שבאמת נשבר.
## D95 — קריאה חוזרת של ה-ARI: מזהים סחיפה מול Beds24, לא מתקנים אותה; הקצב נגזר ממדידה חיה

**הפער.** D93 סגר את הכיוון הנכנס (ביטול OTA שלא הגיע ל-import והשאיר חדר חסום). הכיוון היוצא נשאר פתוח באותה מחלקת כשל בדיוק, במראה: **Beds24 מחזיק `numAvail: 1` על לילה שתפוס אצלנו וממשיך למכור אותו**. דחיפה יכולה ללכת לאיבוד, להידחות ברמת ערך על גבי 200, או להידרס אצל הספק — ואף מחזור לא בדק. כל הצינור היוצא הסתכל רק על מה ש**נשלח**, אף פעם לא על מה שהספק **מחזיק**.

**מה מומש.** `beds24-ari-readback.ts` — מודול אחד שרוכב על ג'וב ה-`reconcile_inventory` ה**קיים** (בלי סוג ג'וב חדש, בלי טיימר, בלי cron): מקרין את החלון דרך `projectBeds24Ari` + `buildBeds24CalendarRequests` (הצד ה"מצופה" הוא **בדיוק** ה-payload שהדחיפה הייתה שולחת — לא דעה שנייה עליו), קורא `GET /inventory/rooms/calendar`, פורש את שני הצדדים לתאים יומיים דרך **מרחיב אחד**, ומשווה.

**קריאה בלבד — לפי הגדרה.** אין ולא יהיה כאן מסלול תיקון אוטומטי: המודול אינו מייבא דבר מ-`beds24-ari.ts` (כלומר `pushBeds24Calendar` אינו נגיש ממנו כלל), יש בו אתר קריאה יחיד ל-`beds24Request` עם `method: "GET"` ונתיב קבוע אחד, והוא אינו כותב טווח מלוכלך, מיפוי או מצב חיבור. הסחיפה מדווחת למפעיל; התיקון הוא Full Sync/drain — החלטה של אדם, לא כתיבה שנולדת מקריאה.

**החלון: 14 ימים קדימה, לא 500.** Overbooking הוא בעיה של הגעות קרובות; מחיר מיושן 400 יום קדימה לא עולה דבר במחזור, ו-500 ימי השוואה הם רעש. מעבר לחלון — ה-Full Sync ממשיך לכסות `ARI_HORIZON_DAYS`.

**שמות ה-headers — הכרעה במדידה (2026-07-24, api.beds24.com, הטוקן הפרודקשן, GET בלבד).** התיעוד (`apiV2.yaml`) מכריז `X-RequestCost` / `X-FiveMinCreditLimit-Remaining`. **השרת לא שולח אותם.** שלוש קריאות רצופות החזירו בדיוק את קבוצת ה-headers הזו:

```
x-request-cost: 1     x-five-min-limit-remaining: 97.8 → 96.8 → 95.8     x-five-min-limit-resets-in: 288
```

`res.headers.get("x-fivemincreditlimit-remaining")` החזיר `null` בכל שלוש — כלומר השם המתועד פשוט אינו על החוט (חיפוש headers הוא case-insensitive, אז זו אינה שאלת אותיות גדולות). המונה זז ב-1.0 בדיוק בכל קריאה, ולכן העלות המדודה אמינה. הצרכן של המסקנה הזו הוא D97 (`beds24-credits.ts`) — הקריאה החוזרת עצמה אינה קוראת headers של קרדיט ואינה משכפלת את המנגנון.

**גזירת הקצב (לא בחירה):**

| גודל | ערך | מקור |
|------|-----|------|
| תקרה | 100 קרדיטים / 5 דק' מתגלגלות | תיעוד + המונה החי |
| עלות קריאת read-back | **1** | `x-request-cost` מדוד |
| כיסוי קריאה אחת | כל 14 החדרים הממופים × כל 14 הימים, `pages.nextPageExists=false` | תשובה חיה, 3,750 בתים |
| חדר בודד באותו חלון | גם כן 1 | המונה מחייב **לכל בקשה**, לא לכל חדר/תאריך |
| גבול עמודים | 3 | `BEDS24_READBACK_MAX_REQUESTS` |
| פרץ מקסימלי למחזור | 3 × 1 = **3 קרדיטים** = 3% מהתקרה | חישוב |
| מופחת בקצב 20 דק' | 3 × (5/20) = **0.75 קרדיטים לחלון** = 0.75% | חישוב |

לכן 20 דקות אפשריות בפער של יותר מפי 30 אפילו על מספר הפרץ, והקריאה החוזרת **אינה זקוקה לקצב משלה**: היא רוכבת על מחזור ה-reconciliation הקיים, שכבר מוציא עד `RECONCILE_LIMIT`=50 קרדיטים למחזור על ההתאמה הנכנסת — התוספת היא ≤6% מחשבון הג'וב עצמו. `ensureReconcileJobs` הורחב לאיחוד של החיבורים הנכנסים והחיבורים עם baseline יוצא (מפה אחת → ג'וב אחד, אף פעם שניים).

**מה משווים ומה לא.** `numAvail` (כל אי-התאמה; מצופה 0 מול מרוחק >0 = חתימת ה-overbooking) ו-`price1` — אך **רק כשאנחנו באמת מפרסמים מחיר**. תאריך חסום מתפרסם `numAvail:0` **בלי** `price1` (fail-closed), ולכן המחיר הישן נשאר אצל הספק: התראה עליו הייתה הופכת כל תאריך חסום ל-false positive ומאמנת את המפעיל להתעלם. הגבלות (`minStay`/`maxStay`) **אינן** מושוות: ה-API מתעד שבהיעדר ערך ביומן מוחזר ערך ברמת ה**חדר**, כך שאי-התאמה שם אינה מבחינה בין סחיפה לברירת מחדל.

**התראה בתשתית הקיימת.** `channel_sync_errors` (מה ש-/channels מציג) בקודים `ari_readback_oversell` / `ari_readback_drift` / `ari_readback_failed`, **שורה פתוחה אחת לכל (חיבור, קוד)** — סחיפה נמשכת עד שמפעיל מטפל, ורישום כל 20 דקות היה מציף את רשימת 10 השגיאות. הפירוט לכל מחזור נשמר ב-`channel_evidence_ledger` (`scenario_key='ari_readback'`) — היומן הוא העקבות, לא האזעקה.

**שומר:** `check:beds24-ari-readback` — mock שמקודד את החוזה המדוד (roomId כפרמטרים חוזרים, תשובה **דחוסה לטווחים** עם `to` כולל, בלי `includeX` → מערך יומן ריק, ושמות ה-headers האמיתיים), 11 טענות דרך מודולי ה-dist האמיתיים על testdb: הסכמה → אפס סחיפה; **הזמנה תופסת אצלנו מול `numAvail:1` אצל הספק → זוהה כ-oversell + התראה + evidence**; מחזור חוזר → עדיין מזוהה, ההתראה לא מוצפת; סחיפת מחיר → קוד נפרד; תאריך חסום → סחיפת זמינות בלבד (לא false positive על המחיר); דפדוף חסום ומדווח; ובכל מחזור — כל הבקשות GET לנתיב היחיד, אפס כתיבות. אומת אדום בשבע שבירות מכוונות (מחיקת ה-diff; התעלמות מתוצאתו; השוואת זמינות שתמיד-שווה; הסרת `includeNumAvail`; POST שמתחמק מהשומר הסטטי — פעמיים, כולל גרסה ששומרת את הליטרל; זיהוי בלי התראה; החלון 14→500) לפני שהוחזר לירוק.

**מה השומר לא מוכיח.** שהחוזה של Beds24 לא ישתנה (ה-mock הוא צילום של 2026-07-24), ושסחיפה **מעבר** ל-14 הימים תיתפס. ותיקון אוטומטי — מחוץ לתחום בכוונה.
## D96 — דיווחי מצב ל-Booking.com: שלוש פעולות מתועדות, יומן לכל ניסיון, ופער חוזה מוצהר

**מה נבנה.** Beds24 חושפת `POST /channels/booking` ("Alpha - Perform actions at Booking.com") עם שלוש פעולות בלבד: `reportInvalidCard`, `reportNoShow`, `reportCancel`. GuestHub לא יכלה לדווח כלום מאז הסרת הספק הקודם (D91) — למרות שמיגרציה 030 יצרה עוד אז את שלושת החותמים (`invalid_card_reported_at`, `external_cancellation_requested_at`, `no_show_reported_at`) בדיוק לצורך הזה, ואף אחד לא כתב אליהם. עכשיו יש מסלול מלא: קבוצת פעולות בהזמנה → מודאל אישור → פעולת שרת → הלקוח היחיד שמדבר עם ה-endpoint → יומן.

**פער החוזה — מוצהר, לא מוסתר.** `waivedFees` **אינו קיים באף מקום ב-apiV2.yaml** (סריקה של כל הקובץ: אפס מופעים). סכימת הבקשה מכילה שני שדות בדיוק: `bookingId` ו-`action`. לכן:
- **לא נשלח שדה שלא מתועד.** ניחוש על החוט אסור; `check:booking-com-reports` אוסר את השם `waivedFees/waiveFees` על מסלול החוט **וגם** מאמת בזמן ריצה ש-`Object.keys` של אובייקט הבקשה הוא בדיוק `["action","bookingId"]` — כך ששדה נוסף בשם תמים ייתפס גם הוא.
- **הטוגל נשמר, עם תיוג אמת.** `booking_channel_reports.waived_fees` הוא **רישום מקומי בלבד**: המפעיל מסמן שוויתר על דמי אי-הגעה כדי שהגבייה תדע לא לגבות. ה-UI אומר זאת במפורש ("רישום מקומי בלבד — הסימון הזה **אינו נשלח** ל-Booking.com... ויתור בפועל יש לבצע בממשק Booking.com"). הבחירה הזאת על פני מחיקת הטוגל: עמודה שנכתבת ומסבירה את עצמה עדיפה על מידע תפעולי שנעלם, כל עוד אף מסך לא מרמז שהוא הגיע לערוץ.

**שפה מקומית מול שפת חוט, בהפרדה מוצהרת.** `cancel_due_invalid_card` (הכוונה של המפעיל) הוא `reportCancel` (מה ש-Booking.com מבינה). המיפוי חי במקום אחד — `beds24-booking-reports.ts` — והיומן שומר את השם המקומי.

**ארכיטקטורה בשלוש שכבות** (הגבול של `check:calendar` נשמר — `reservations/actions.ts` לא נגעה):
1. `beds24-booking-reports.ts` — הלקוח היחיד ל-`POST /channels/booking`, דרך ה-core המשותף של `beds24-http` (ניסיון אחד, timeout חסום, הודעות עברית קבועות, טוקן לא מודלף). מלכודת ה-2xx-עם-שגיאות מטופלת כמו ב-ARI: כל `success:false` או `errors[]` = **כישלון**, לעולם לא הצלחה נקייה.
2. `booking-com-reports-core.ts` — כל השומרים והיומן, **חופשי מ-next/react** (נבנה ע"י `tsconfig.check.json` שיורש את מגבלות ה-worker), ולכן ניתן להוכחה מול DB מתכלה.
3. `booking-com-reports.ts` (`"use server"`) — סשן + `reservations.channel_report` + audit + revalidate, וזה הכל.

**יומן לכל ניסיון, לא לכל הצלחה.** `booking_channel_reports` (מיגרציה 055) מקבל שורה גם על דחייה מקומית (`status='failed'`, `error_message` בעברית, `response=NULL` — הבקשה מעולם לא יצאה) וגם על דחיית ספק. השורה היחידה שלא נכתבת היא "הזמנה לא נמצאה בטננט" — אין `tenant_id`/`reservation_id` להצביע עליהם.

**חלונות רכים בשעון הנכס** (`tenants.timezone`): `invalid_card` פתוח עד תחילת יום הצ'ק-אין; `no_show` מהצ'ק-אין ולמשך 48 שעות; `cancel_due_invalid_card` ללא שעון — התנאי שלו הוא דיווח `invalid_card` **מוצלח** קודם, ביומן. הכלל חי במודול טהור אחד (`booking-com-report-rules.ts`) שגם הדפדפן וגם השרת מייבאים, כדי שכפתור מושבת ודחיית שרת לא יסתרו. Beds24 היא הפוסקת — הבדיקות המקומיות רק מונעות קריאה בלתי-הפיכה שנועדה להיכשל, ואינן מתיימרות לסמכות.

**מה הפעולה לא עושה:** `cancel_due_invalid_card` **מבקשת** ביטול ומחתימה `external_cancellation_requested_at`. היא לא הופכת סטטוס ולא משחררת מלאי — הביטול נוחת רק כשחוזרת רוויזיה מבוטלת דרך המסלול הקנוני (D93).

**אפס נתוני כרטיס.** אלו דיווחי מצב. אין PAN/CVV/תוקף על המסלול, אין נגיעה ב-`reservation_cards`, ו-`response` שומר חילוץ מבני עם allow-list (`success/new/modified/errors[action,field,message]/warnings`, טקסט חתוך ל-300) — לעולם לא גוף תשובה גולמי.

**שומר:** `check:booking-com-reports` — 18 טענות: צורת החוט המדויקת, היומן בהצלחה ובכישלון, בידוד טננט, כלל הביטול (כולל שדיווח **כושל** לא פותח אותו ושדחייה לא שורפת קרדיט), גבולות החלונות, וקו הכרטיס בזמן ריצה מול כרטיס שמור אמיתי. חמשת השיבושים המכוונים (שם פעולה שגוי, שדה עודף על החוט, ביטול פילטר הטננט, ביטול כתיבת היומן, ביטול תנאי הביטול) הוכחו אדומים לפני השחזור.

## D97 — חלון הקרדיטים של Beds24: שמות ה-headers נמדדו, הסף נגזר מהמדידה, וה-worker מאט במקום לנסות שוב

**מה התגלה במדידה (2026-07-24).** ה-header שהקוד קרא — `X-FiveMinCreditLimit-Remaining` — **אינו קיים על החוט**. בדיקה חיה מול `api.beds24.com` עם הטוקן הפרודקשן (GET /bookings בדיוק בצורת הפילטר של ה-poll) החזירה שלושה headers אחרים:

```
x-five-min-limit-remaining: 97.6     x-five-min-limit-resets-in: 155
x-request-cost:             1.2
```

לכן `creditsRemaining` היה NULL ב-**100%** מהרשומות שנשמרו אי פעם (192 שורות `incremental_sync` + 9 `full_sync` ב-`channel_evidence_ledger`, ו-9 payloads של `channel_sync_jobs`). לוגי ה-PM2 של ה-worker אינם מכילים ולו מופע אחד של נתוני קרדיט. `GET /authentication/details` אינו מחזיר headers של קרדיט כלל — היעדר מד **אינו** "אפס קרדיטים".

**האריתמטיקה (פרודקשן, טננט 68139d06, 24 שעות עד 2026-07-24 21:42):**

| גודל | ערך | מקור |
|------|-----|------|
| תקרה | 100 קרדיטים / 5 דק' מתגלגלות / חשבון | תיעוד + אימות: 100 − 1.2 (poll) − 1.2 (probe) = 97.6 הנמדד |
| עלות קריאה | 1.2 | `x-request-cost` במדידה החיה (דגימה אחת, endpoint אחד) |
| קריאות שהחלון מממן | ⌊100/1.2⌋ = 83 | חישוב |
| poll נכנס | 287 ג'ובים / 24h ≈ 12/שעה ≈ קריאה אחת לכל חלון | `channel_sync_jobs` |
| חלון עמוס ביותר | 43 בקשות ARI + poll אחד = 44 קריאות = **52.8 קרדיטים (52.8%)** | `channel_evidence_ledger`, דלי 06:05 |
| חלון חציוני | קריאה אחת = 1.2 קרדיטים (1.2%) | 288 דליים, p50=1, p95=3 |
| תקרת ה-drain עצמו | `MAX_REQUESTS_PER_RUN`=120 × 1.2 = **144 קרדיטים** | חישוב — ריצה אחת יכולה לחרוג מהחלון ב-44% |

**גזירת הסף.** מה שאסור להרעיב הוא העבודה ה**נכנסת**: ה-poll (קריאה אחת ל-5 דק') וה-reconciliation (קריאה לכל הזמנת OTA פתוחה — 4 היום), כי הצמד הזה **הוא** רשת הביטחון לביטולי OTA (D93). ה-ARI היוצא נדחה בלי נזק — טווח מלוכלך שממתין נשלח שלם בהמשך. רזרבה = poll(1) + reconcile(4) + 2 בתעופה = 7 קריאות = 8.4 קרדיטים; מעוגל ל-**10 קריאות** של מרווח כי Beds24 מתעד את העלות כדינמית ו-1.2 היא דגימה אחת → `BEDS24_LOW_CREDIT_THRESHOLD = 10 × 1.2 = 12` קרדיטים (12% מהתקרה).

**מה מומש.** מודול טהור אחד (`beds24-credits.ts`: שמות ה-headers, הסף, `evaluateBeds24Credits`, `createBeds24CreditGate`) ושער אחד שכל שלושת לולאות הפרץ מקיימות — שולח היומן היוצא, מהלך העמודים הנכנס (MAX_PAGES=50 = 60 קרדיטים בג'וב אחד) וסבב ה-reconciliation (RECONCILE_LIMIT=50). כשה-remaining יורד מתחת לסף — או ש-Beds24 מחזיר 429 — הריצה מפסיקה להוציא קריאות וההמתנה נלקחת מ-`resets-in` של הספק (או מ-`Retry-After` כשנשלח), לעולם לא ניסיון חוזר עיוור. **429 הוא מסלול נפרד** גם ברמת ה-HTTP: `retryAfterMs` על 429 כבר אינו יכול להיות undefined.

**החלטת מדיניות: השהיית-קרדיט אינה כישלון טווח.** ב-drain האינקרמנטלי הטווחים ה"תפוסים" נדרכים מחדש ל-`now() + waitMs` **בלי** להעלות `attempts` — חיוב ניסיונות כאן היה מוביל ל-dead-letter של טווחים בריאים בחלון עמוס. ה-breaker (§16) נפתח לפרק הזמן המדויק שהספק הצהיר עליו: `failureKindOf('credit_paused')` ממופה ל-`rate_limited`, ולכן הצינון הוא `resets-in` ולא ההשהיה האקספוננציאלית.

**תצוגה.** ה-worker מצמיד את המד ל-`channel_sync_jobs.payload` של הג'וב שמדד אותו; `/channels` מציג את הרשומה החדשה ביותר (ה-poll רץ כל 5 דקות → אף פעם לא מיושן ביותר ממחזור אחד): נותרו/תקרה, בר עם אזור-סכנה בסף, `resets-in`, עלות הקריאה האחרונה וחותמת המדידה.

**שומר:** `check:beds24-credit-backoff` — mock שמגיש את שמות ה-headers **האמיתיים** (ולכן נכשל על קוד שקורא את השם הישן), 11 טענות דרך מודולי ה-dist האמיתיים: פענוח המד החי, גזירת הסף, שני התרחישים ברמת ההחלטה, השער, ה-breaker, ושלושה תרחישים DB-backed על testdb — חלון בריא מדפדף חופשי (50 קריאות), remaining נמוך עוצר אחרי **קריאה אחת**, ו-429 עוצר מיד וממתין את ה-`resets-in`. אומת אדום בשלוש שבירות מכוונות (מחיקת ענף ה-429, הסרת עצירת השער, אי-דיווח 429 לשער) לפני שהוחזר לירוק.

---

## D99 — `maxStay`: NULL הוא "ללא הגבלה" גם על החוט (2026-07-25)

**הבעיה.** `pricing_plan_rates.max_stay IS NULL` פירושו אצלנו "ללא הגבלה". ל-Beds24
אין ערך כזה, ואין לו פעולת מחיקה. נמדד חי מול פרודקשן (אין staging), חדר 1318,
7 ימים, 191 יום קדימה, כל וריאנט אחרי סמן `maxStay=5` שאומת בקריאה חוזרת:

| מטען | HTTP | תוצאה |
|---|---|---|
| `0` | 201 + warning `"capped to 1"` | **1** — הגבלה חמורה יותר, לילה אחד |
| `null` / `""` / השמטה | 201, בלי `modified`, בלי warning | **התעלמות שקטה** |
| `3650` | 201 + warning `"capped to room maxStay 365"` | 365 |

הטווח הקביל הוא `[1, תקרת החדר]`, והתקרה (365 בכל 15 החדרים) היא **קשיחה**.
בונה המטען **השמיט** את השדה כשהערך המקומי NULL, ולכן ההגבלה הישנה נשארה אכיפה
אצל Beds24 **לנצח**: הממשק הראה "ללא הגבלה" בזמן שהערוץ דחה שהייה מעל 31 לילות.
4,830 שורות על 15 יחידות היו במצב הזה, בלי מסך ובלי שגיאה שמראים אותו.

**ההחלטה — לשלוח את תקרת החדר, לא 3650.** שתי הדרכים מגיעות לאותו ערך אפקטיבי,
אבל 3650 מחזיר warning בכל דחיפה, ו-`inspectEnvelope` מסמן **כל** מערך `warnings`
כ-`partial` — כל דחיפה מסחרית הייתה נקראת חלקית לנצח והאזהרות האמיתיות היו
נטבעות. שליחת התקרה עצמה מחזירה 201 נקי.

**ההחלטה — לקרוא את התקרה מהספק, לא לקבע 365.** כל 15 החדרים מחזיקים 365 היום,
אבל חדר שתקרתו תשתנה בפאנל היה נשבר בשקט. `beds24-room-ceilings.ts` קורא
`GET /properties` לכל חדר, cache 6 שעות, ו**fail-open**: תקרה שלא נקראה ⇒ השדה
מושמט (ההתנהגות הקודמת). תקרה לעולם אינה מומצאת — ניחוש כותב הגבלה **אמיתית**
על ליסטינג חי.

**נלווה:** `stayField` ו-`priceField` ב-`validation/rates.ts` הועלו ל-`.min(1)`
(`0` מפיל את כל המטען; `price = 0` סוגר חדר בשקט), וברירת המחדל של `maxStay`
בעדכון הקבוצתי שונתה מ-**7** ל-"ללא הגבלה" — ברירת מחדל שהמפעיל לא ביקש היא
המנגנון שילד את ה-31.

**השומר:** `check:beds24-maxstay-no-limit` — הניקוז האמיתי מול DB משלו, מאחורי מוק
**מצבי** שמממש את החוזה שנמדד (כולל ה-no-op של השמטה), וקורא את המצב בחזרה.
עובר A (אדום **התנהגותי**: `enforcing [31,31,31,31,31,31]`) ושתי מוטציות B2.
`check:beds24-ari-drain` הורחב לנקוב בנקודת הקצה השנייה, עם אסרשן שסופר את
הקריאות ונכשל מעל אחת.

**הביצוע.** מוזג ב-#115, דופלל כ-`5944c0ad`, ואז נוקו **4,830 השורות** דרך
`writeRateCells` (המסלול הקנוני, patch `{ max_stay: null }` בלבד) בטרנזקציה אחת.
אומת חי: 15/15 היחידות אוכפות עכשיו 365, **אפס אוכפות 31**; אפס שגיאות סנכרון,
אפס warnings, 30 טווחים `synced` ב-`attempts = 0`. עלות: 2.4% מחלון הקרדיטים.
צילום ברמת השורה: `docs/MAXSTAY_CLEANUP_SNAPSHOT.csv`.

### פתוח — דורש הכרעה של רונן, לא הוכרע כאן

1. **תקרת ה-365 עצמה.** "ללא הגבלה" אינו בר-השגה מהקוד מעבר ל-365 — הרחבתו
   דורשת שינוי בפאנל Beds24. **המלצה: להשאיר 365.** פתיחה לא מכוונת גרועה
   מחסימה; הזמנה של 300 לילות שהתקבלה אינה חוזרת לאחור בקוד.
2. **התנגשות מספר מיגרציה בענף LOS.** `fix/quote-window-long-stay` (לא ממוזג,
   וקיים **רק כ-ref מקומי**) מביא `055_length_of_stay_discounts.sql` בזמן ש-main
   מחזיק `055_booking_com_channel_reports.sql`. הוא יצטרך **057**, וגם יישוב
   חפיפה ב-`GroupUpdatePanel.tsx`. לא נגענו — כלל concurrency.
3. **`minStayThrough` (ברירת מחדל 2) ו-`minStayArrival` (1)** חולקים בדיוק את
   אותו דפוס של ברירת מחדל שהמפעיל לא ביקש. לא שונו — מחוץ לתחום D99.
4. **מגבלת ההבחנה.** הקריאה החוזרת מדווחת את הערך ה**אפקטיבי** ואינה מבחינה בין
   "אין דריסה יומית, יורש 365" לבין "יש דריסה יומית ששווה 365". זו מגבלת הספק.

---

## פתוח (לא הוכרע) — תמחור הערוץ ותוכנית `fee07a5b` (נמדד 2026-07-25)

**אין באג ואין פער טכני.** אבחון קריאה-בלבד (`docs/PRICE_DIAGNOSIS.md`) מדד
75/75 תאים על 15 יחידות ומצא **אפס סטיות** בין המחיר המקומי לזה שאצל Beds24.
מה שנמצא הוא פער **מסחרי**, וההכרעה בו אינה טכנית ולכן אינה נעשית כאן.

**העובדות שנמדדו:**

- כל 15 המיפויים מצביעים על `fee07a5b` — `"ללא החזר"`, ברמת הדייר,
  `plan_kind='base'`, `adjustment_value = NULL`, `is_refundable = false`.
- **היא מחזיקה 0 שורות תעריף**, ו-`pricing_plan_unit_rates` — הטבלה שממנה
  הפרויקציה קוראת overlay — **ריקה לחלוטין ברמת הדייר**. המחיר על החוט מגיע
  מתוכנית ה-`is_base` של היחידה. `fee07a5b` היא **שער ומקור ברירות-מחדל**, לא
  מקור מחיר.
- שלוש תוכניות-בת קיימות, פעילות, מסומנות `is_visible_channels`, ומשויכות
  ל-16 יחידות כל אחת — ו**אינן ממופות לאף חדר**, ולכן לעולם אינן מתפרסמות:
  `d71e8c1f` שבועי **−15%** (min 7) · `f0a97bb8` חודשי **−30%** (min 30) ·
  `8d4c2e8a` ביטול גמיש **+5%**.

**ההחלטות שנותרו לרונן:**

1. **האם למכור "ללא החזר" במחיר תעריף הבסיס המוחזר?** זה מה שקורה היום. האורח
   אינו מקבל תמורה לוויתור על הביטול, והמלון אינו גובה פרמיה על ביטול גמיש —
   `8d4c2e8a` (+5%) נבנתה בדיוק לשם כך ואינה מתפרסמת.
   *הצעה (לא בוצעה):* או שהמיפוי יצביע על תוכנית ה-`is_base` של היחידה, או
   ש-`fee07a5b` תהפוך ל-`derived_percentage` עם הנחה אמיתית מתחת לבסיס.
2. **שהייה ארוכה מתומחרת במחיר לילה מלא.** ‎−15%‎ ו-‎−30%‎ אינם מגיעים לערוץ, על
   15 יחידות ועל מלוא האופק. מיפוי Beds24 נושא תוכנית אחת לחדר; פרסום התעריפים
   המוזלים דורש החלטה על מבנה המיפוי.
3. **המחיר 750 ל-1318.** נוצר בלוג `4d8f1b62` (`replace 750`, 1318 בלבד,
   25/07/2026→30/04/2027) וניקה קפיצה קודמת של 4,880/6,400. הוא יושב בתוך רצועת
   ה-610–800 של שאר חדרי שני-החדרים. **האם זה המחיר הנכון — החלטה מסחרית.**
4. **שני מחירים חריגים שנצפו ולא נחקרו:** `1,500` ב-1237 וב-1242, ו-`100,000`
   ב"חניה זמנית" (יחידה לא פעילה ולא ממופה — אינה מתפרסמת).

**מה כן הוכרע ונסגר:** `fee07a5b.default_max_stay = NULL`, ולכן התוכנית שבמיפוי
**אינה** מהדקת את ה-`maxStay` שנוקה ב-D99. הפער היחיד שנותר שם הוא תקרת 365
שבפאנל Beds24.

---

## D100 — חלון התמחור הוא תקרה נקראת-מהגדרות, לא 90 מקובע (2026-07-25)

**הבעיה, מוכחת בהרצה.** `MAX_QUOTE_NIGHTS = 90` היה מקובע ב-
`src/lib/pricing/types.ts`. הרצת שכבת התמחור שה-action קורא לה: 30/89/90 לילות
מתומחרים, **91/200/400 נחסמים** ב-`QUOTE_WINDOW_EXCEEDED`. מכיוון שזהו קוד
ברמת-בקשה, `firstEnforcedError` חוסם עליו **תמיד**. שהייה של חודש עד שנה —
מקרה מוצר רגיל כאן — הייתה בלתי אפשרית, ולמפעיל לא הייתה דרך להעלות את הרף.

**ההחלטה.** החסם נשאר חסם — הוא בולם חישוב, לא מדיניות אירוח:
`DEFAULT_MAX_QUOTE_NIGHTS = 400` (שנה + שוליים), ניתן לדריסה ב-
`settings.pricing.max_quote_nights`, מהודק ל-`[1, 1830]` (אופק 5 שנים), וכל
ערך פגום נופל לברירת המחדל — הגדרה שגויה לא תרחיב את החסם ולא תצמצם אותו
לערך שדוחה שהייה רגילה. **אפס ולידציה הוסרה:** `MAX_STAY_EXCEEDED` על
`max_stay` יומי עדיין נאכף, ואומת בהרצה.

**שני חסמים היו בשרשרת, והראשון נפל היום:** `MAX_STAY_EXCEEDED` חסם 32–90
לילות דרך `max_stay = 31`, והוסר ב-**D99** (4,830 שורות אופסו). החסם השני הוא
זה. הסדר הוכח: בהחזרת `max_stay=31` נחסמו 60 לילות ב-`MAX_STAY_EXCEEDED` בעוד
91+ נחסמו קודם לכן בבדיקת החלון, שרצה לפני כל טעינת נתונים.

**אומת מקצה לקצה** דרך `createReservationAction` האמיתית: 200 ו-400 לילות
נשמרים, `total_price` נכון לכל לילה, `pricing_snapshot.nightly[]` מלא
(200 ו-400 רשומות), והלוח מסמן 600 ימים תפוסים. פירוט: `docs/LONG_STAY_FIX.md`.

### פגם שומר שהתגלה אגב, ותוקן

**`check:pricing-engine` קימפל את עץ הפרודקשן.** `ROOT` היה מקובע ל-
`"/var/www/guesthub"`, ולכן מכל worktree הוא בדק את ה-`src/` של פרודקשן ודיווח
על קוד שהמחבר לא כתב — הוא החזיר "ALL 35 PASSED" על שינוי שכלל לא היה בו.
תוקן לנתיב היחסי של הסקריפט, כמו כל שומר אחר. בדיקה 35 כבר אינה מקבעת 90:
היא קוראת את התקרה מהמודול ובודקת התנהגות משני צדדיה. עוברת A ו-B2.

**זהו מופע נוסף של הדפוס ב-`GUARD_INTEGRITY.md` §10.5** — תוצאת שומר שתלויה
בסביבה ולא בקוד. **פתוח:** לסרוק את שאר 71 השומרים אחרי `ROOT` מקובע.

### פתוח — לא הוכרע כאן

1. **האם 400 היא ברירת המחדל הנכונה,** או שצריך להיות ערך פר-דייר מיום ההתקנה.
2. **שהייה שחוצה את אופק התעריפים (5 שנים)** לא נבדקה.
3. **שהייה ארוכה מרובת-חדרים** לא נבדקה.
4. **`minStayThrough` (2) ו-`minStayArrival` (1)** בעדכון הקבוצתי חולקים את דפוס
   ברירת-המחדל-שלא-התבקשה שילד את ה-31. לא שונו.

---

## D101

**שומר חייב לבדוק את העץ שהוא חי בו — והסריקה שהושארה פתוחה ב-D100 בוצעה.**

D100 השאיר סעיף פתוח: *"לסרוק את שאר 71 השומרים אחרי `ROOT` מקובע."* בוצע.
נסרקו **כל 82 קבצי `scripts/*.mjs`** (73 מהם מחווטים ל-`check:*`).

### נמצאו עוד שניים — ושניהם הוכחו התנהגותית, לא בקריאת קוד

| שומר | ההוכחה |
|---|---|
| `check-messaging.mjs` | `aes-256-gcm` נמחק מ-`src/lib/messaging/secrets.ts` של עץ העבודה. השומר נשאר **ירוק**. |
| `check-channels-fullsync-ui.mjs` | `bg-brand` — בדיוק התקלה שהשומר קיים כדי לתפוס — הוזרקה לרכיב של עץ העבודה. השומר נשאר **ירוק**. |

`check-channels-fullsync-ui` גם **כתב לתוך עץ הריצה של פרודקשן**: סקר חי תפס את
`/var/www/guesthub/node_modules/.cache/fullsync-ui-check/input.css` נוצר תוך כדי
הרצה מ-worktree, ונמחק ע"י הניקוי של השומר עצמו.

שניהם נפתרים כעת מ-`import.meta.url` ומדפיסים `# tree under test: <path>` בזמן
ריצה. אותן מוטציות מפילות אותם עכשיו על האסרשן הנכון.

**`check:guard-roots` חדש** ואוסר את המחלקה כולה על כל 83 השומרים. הוא תפס מיד
ש-`check-pricing-engine` — שתוקן ב-D100 — נפתר נכון אך **לא הכריז על העץ**.

**`check-background-job-recovery`** החזיק `const LEASE=10; // mirror JOB_LEASE_MINUTES`.
עכשיו קורא את `JOB_LEASE_MINUTES` מ-`queue.ts` ובודק **משני צדי הגבול**. אומת
בהזזת הקבוע ל-30: השומר עובר לבדוק 29/31.

### הבסיס החדש — **51 עוברים / 23 נכשלים מתוך 74**

נמדד **באותו רגע** מול `origin/main` ב-worktree נפרד (50/23 מתוך 73).
**אפס שומרים התהפכו.** שני שומרי הפרודקשן לא התהפכו רק כי שני העצים החזיקו אותו
קומיט — הירוק שלהם היה נכון **במקרה**.

**"45/28" היה מאפיין של הסביבה, לא של הקוד** ואינו בסיס תקף. פירוט מלא:
`docs/GUARD_AUDIT.md`, `docs/GUARD_INTEGRITY.md` §10.

### שתי הנחות שהופרכו במדידה

1. **"שלושה שומרים תלויי-סביבה"** — הם **15**, כולם בשמם ב-`GUARD_AUDIT.md`.
   ושתי קבוצות מתוכם **סותרות**: `pricing-engine` ושלושה אחרים דורשים סכימה
   **מחוקה**; `guest-communications-db` ו-`booking-com-reports` דורשים סכימה
   **קיימת**. שום הרצה יחידה לא תרצה את שתיהן — חלק מהאדומים קבועים בכל מצב קוד.

2. **"שומרים שמשחזרים קבועים"** — מקרה **אחד** (`LEASE`). כל השאר הם ערכי פיקסצ'ר.
   `assert.equal(mod.CONST, 14)` אינו שכפול אלא הצמדה, ונשאר בכוונה.

### פתוח

- **`check-background-job-recovery` מעתיק את פרדיקט ה-claim עצמו**, לא רק את
  הקבוע. הוא מוכיח שה**עותק** מתנהג נכון, לא קוד המוצר. תיקון דורש ייצוא
  הפרדיקט ממודול אחד — לא בוצע.
- **9 קבצי `scripts/*.mjs` אינם מחווטים** לאף `check:*`. לא נבדקו.
- **B2 לא הורץ על 80 השומרים** בקבוצת "יחסי/מקומי".
- **אין CI.** אף אחד מ-74 השומרים אינו רץ אוטומטית.
- **`docs/GUARD_INTEGRITY.md` הועבר לכאן מ-`stab/guard-integrity-sweep`** — ענף
  ללא PR פתוח שמעולם לא מוזג, ולכן הקובץ נעדר מ-main. אם הענף ההוא ימוזג יום
  אחד, יהיה קונפליקט. **להחלטת רונן: לסגור את הענף.**

---

## D102

**מודל התמחור: "ללא החזר" הוא הבסיס — והפאזה נעצרה בשער 2.1 כפי שנדרש.**

### ההכרעה של רונן, ומה נמדד מולה

*"«ללא החזר» (`fee07a5b`) הוא מחיר הבסיס. כל תוכנית אחרת יורשת ממנו תוספת או הנחה."*

השער ב-2.1 דרש לעצור אם הבסיס אינו מוחזק ב-`fee07a5b`. **הוא אכן אינו מוחזק שם:**
0 שורות ב-`pricing_plan_rates`, ו-`pricing_plan_unit_rates` ריקה בכל הדייר.
כל 15 המחירים המתפרסמים יושבים בתוכנית ה-`is_base` של **היחידה** (16 תוכניות,
17,984 שורות). **עצרתי לפני 2.2. אפס מיפוי, אפס כתיבה, אפס דחיפה חיה.**

### ⚠️ אבל הנימוק שנלווה לשער נמדד ואינו חל

ההוראה נימקה את העצירה ב*"אין למפות נגזרות שיורשות מטבלה ריקה"*. הן **לא**
יורשות מטבלה ריקה. `plan_kind='base'` **אינו אמור** להחזיק שורות: ב-`resolveNightPrice`
ענף `kind==="base"` מחזיר את `basePrice` שהועבר אליו — מחיר היחידה — ו-
`resolveChainNightPrice` הולך שורש-ראשון, ולכן הנגזרת מקבלת אותו כ-`parentResolved`.

הורץ מול הפותר האמיתי: `[חודשי ‎−30%‎, fee07a5b]` על בסיס 750 → **525**;
על 610 → **427**; שבועי ‎−15%‎ → **518.5**; גמיש ‎+5%‎ → **640.5**;
ובלי מחיר יחידה → **null**. `ref/proof/pricing-inheritance-resolver.txt`.

**מכאן ש-2.3 כבר מתקיים בקוד** — הנגזרת מחושבת מהבסיס בזמן הבנייה, אין מחיר
כפול, ושינוי בבסיס מזיז את שלוש הנגזרות אוטומטית. **החסם היחיד הוא המיפוי.**

### להחלטת רונן

מיפוי Beds24 נושא **תוכנית אחת לכל חדר**. פרסום שלוש התוכניות דורש **יעד תעריף
נוסף ב-Beds24 לכל תוכנית, לכל חדר** — שינוי חיצוני שמשנה את מה שה-OTA מציגים על
15 יחידות ועל מלוא האופק. לא בוצע.

1. **לאשר שהמדידה מבטלת את הנימוק לעצירה**, ואז להריץ 2.2–2.6 בלבד.
2. **האם למכור שבועי ‎−15%‎ / חודשי ‎−30%‎ / גמיש ‎+5%‎ בכלל.** אחרי D100 נשמרות
   שהיות של חודשים עד שנה במחיר לילה מלא — זה הפער המשמעותי.
3. **המחיר 750 ל-1318** — נשאר פתוח מ-D99/F. החלטת תמחור.

`MAX_QUOTE_NIGHTS` אומת ולא נסוג: **400** במקור הפרודקשן וגם בבנייה הרצה;
`settings.pricing` של הדייר = `null`, כלומר ברירת המחדל חלה. לא שונה.

פירוט: `docs/PRICING_MODEL.md`. המסגור השגוי ב-`docs/PRICE_DIAGNOSIS.md`
("מכירת לא-מוחזר במחיר המוחזר") תוקן שם במפורש.

## D104 — הנחות אורך שהייה במנוע: המדרגה נבחרת מהלילות, לא מבחירת תוכנית (2026-07-26)

**הפער (תלונה ראשית של רונן).** "תעריף שבועי" (‎−15%) ו"תעריף חודשי" (‎−30%) קיימים רק
כתוכניות תעריף שהמפעיל חייב לבחור ידנית; שהות של 10 לילות על מחיר בסיס מקבלת 0 הנחה,
והאתר הציבורי לא רואה את ההוזלה כלל (docs/PRICING_AUDIT.md §1).

**מה מומש.** הצלת חלק ה-LOS של ענף `fix/quote-window-long-stay` (קומיט `eb5dbe4` בלבד;
`f03c911` נזרק — D100 פתר את חלון הציטוט טוב יותר): טבלת `guesthub.length_of_stay_discounts`
(מיגרציה **057**, מוספרה מחדש מ-055 שנתפסה ב-main), מודול טהור `lib/pricing/los.ts`
(`tiersForPlan` / `selectTier` / `applyTier` / `resolveLosDiscount`), וחיווט במנוע: בסיס
ההנחה הוא **הלינה בלבד** (`accommodationSubtotal` — בלי חיובי אורח נוסף), המדרגה בעלת
`min_nights` הגבוה ביותר שמתקיים חלה — **אחת בלבד**, הסכום נחתם ב-snapshot וב-fingerprint,
והאתר הציבורי קורא את אותן מדרגות דרך אותה פונקציה.

**Seed ערכי הבעלים (idempotent, ניתן לעריכה ב-LosDiscountsPanel):** ‏7+ לילות → 15% · ‏30+
לילות → 30%. מדרגת 4 לילות לא נזרעה — אין ערך מאושר; רונן יכול להוסיף אותה בפאנל.

**פטור ידני.** override מחיר מורשה (§13) — וגם מצב "סה״כ ידני" החדש — הם המילה האחרונה של
המפעיל; מדרגת LOS לעולם אינה מוחלת עליהם. נאכף במנוע, ב-UI ובשומר.

**קונפליקטים שהוכרעו לטובת main:** `resolveMaxQuoteNights` של D100 נשמר (הענף רצה להחזיר
קבוע 1830 — נסיגה); `GroupUpdatePanel`/`stayLimit` של D99 נשמרו; ההודעה של
`QUOTE_WINDOW_EXCEEDED` נשארה זו של main. CSS יתום (`.gu-pending`) לא נקלט.

**שומרים:** תוספות LOS ל-`check:pricing-engine` (בחירת מדרגה, קדימות scope, בסיס לינה
בלבד, פטור ידני, cap), ל-`check:pricing-equality` (מנוע ≡ מסלול שמירה כולל `losDiscount`
ב-snapshot) ול-`check:rates-ui`.

## D105 — מדרגת LOS אינה נערמת על תוכנית derived_percentage (2026-07-26)

**הכלל.** כשהציטוט מתומחר על תוכנית `derived_percentage` (שבועי ‎−15%, חודשי ‎−30%,
ביטול גמיש ‎+5%), **מדרגות ברירת-המחדל של הדייר אינן חלות**: התוכנית הזו היא בעצמה
תמחור תלוי-אורך-שהות, וערימת המדרגה מעליה הייתה הנחה כפולה (‎30 לילות: ‎−30% ועוד ‎−30%).
מדרגה שהוגדרה **במפורש על התוכנית** (scope פר-תוכנית) כן חלה — הגדרה מפורשת היא
כוונת מפעיל, לא ירושה שקטה.

**מימוש.** ב-`tiersForPlan`: תוכנית עם מדרגות משלה — המדרגות שלה (היה קיים); תוכנית
`derived_percentage` בלי מדרגות משלה — **אין** נפילה לברירות המחדל (חדש); כל תוכנית
אחרת (base / independent / derived_fixed) ומחיר בסיס — ברירות המחדל חלות. ה-UI מסביר
זאת ב-badge כשנבחרת תוכנית derived. השומר מכסה את שלושת המצבים.

**גבול מוצהר:** `derived_fixed` נשארת יורשת ברירות מחדל — התאמה קבועה (₪) אינה
פונקציה של אורך השהות. אם יתווסף שימוש עתידי שסותר זאת — החלטה נפרדת.

## D106 — מקור יחיד לסה״כ ההזמנה: computeReservationTotals, מצבי מחיר והנחה, מע״מ שמכבד פטור (2026-07-26)

**הפער (ביקורת §ז').** חמישה חישובי סה״כ מקבילים בשלוש שפות: `reservationTotal` בשרת,
שני עותקי SQL (הזזת חדר, קליטת ערוץ), שני עותקי לקוח (שני הפאנלים) — והאתר הציבורי
ציטט מחיר שחושב אחרת מזה שנשמר. המע״מ חושב בנפרד בשלושה משטחים, אף אחד מהם לא קרא
`includedVatForReservation`, ולכן `tax_exempt` לא כובד בשום מקום.

**ההחלטה.** קובץ טהור ואיזומורפי `src/lib/pricing/totals.ts` — `computeReservationTotals`
הוא מקור הסה״כ היחיד: שרת שומר איתו, לקוח מציג את פלטו, שומרים אוסרים כל נוסחה אחרת
(pin טקסטואלי + איסור regex על `GREATEST(0…discount_amount`). אריתמטיקה באגורות שלמות —
"סה״כ ידני" מדויק לאגורה. מע״מ מחולץ מהסה״כ אחרי הנחה ותוספות, דרך
`includedVatForReservation` בלבד; טוגל "המחיר כולל מע״מ" (ברירת מחדל דלוק) כותב
`tax_exempt`, שנקרא סוף-סוף בכל התצוגות וב-PDF.

**מודל:** מצב מחיר **פר-חדר** (`reservation_rooms.price_mode`: auto/manual_night/
manual_total + `manual_total`; `is_manual_rate` נשמר מסונכרן) — כפי שהרפרנס מגדיר;
הנחה **פר-הזמנה** (`discount_mode` ∈ none/amount_per_night/percent_per_night/
amount_total/percent_total + `discount_value`; `discount_amount` נשאר ה-cache הפתור
שכל הקוראים הקיימים ממשיכים לקרוא). סכום OTA נשאר ריבוני דרך `rooms_total_override`
(H6) — נשמר בייבוא, שורד עריכת-מטא, ומתבטל בכל תמחור-מחדש מקומי. שני המצבים
הידניים דורשים `reservations.price_override` ופטורים מהנחת LOS.

**`discount_percent` מתה ותוסר** במיגרציה נפרדת אחרי חלון ה-parity (הופעה יחידה
בריפו = ה-DDL שלה; 0 שימוש בנתונים). לא נגענו בה ב-058 כדי שרשימת עמודות ה-parity
תישאר יציבה על פני הדיפלוי.

**שער עצירה שהורץ:** `check:totals-parity` על עותק pg_dump של הפרודקשן — כל 42
ההזמנות בייט-זהות בעמודות הכסף על פני 057+058, replay של המקור היחיד משחזר כל
total_price ו-discount_amount שמורים, וה-ledger לא זז. הראיה:
`docs/booking-window/parity-run-2026-07-26.txt`.

## D107 — מטבע להזמנה: enabled_currencies, בלי המרה, ידני-בלבד מחוץ למטבע הנכס (2026-07-26)

**הפער.** `reservations.currency` נכתב `'ILS'` קשיח בשני מסלולים; אין בורר; המנוע
פוסל CURRENCY_MISMATCH על פרמטר שאיש לא שולח.

**ההחלטה (המימוש המינימלי שאינו שובר את Beds24):** `settings.enabled_currencies`
(seed `["ILS"]`, ניהול בהגדרות; מטבע הבסיס תמיד חבר) → בורר בכרטיס התמחור →
`reservations.currency` נכתב מהבחירה + `exchange_rate` snapshot ידני לתצוגה
(`numeric(14,6)`, אופציונלי). **אין המרה בשום מקום** — הסכומים נשמרים במטבע שנבחר.
**כלל המגן:** מטבע ≠ מטבע הנכס מחייב מצב מחיר ידני בכל חדר — טבלאות התעריפים
והפרסום ל-Beds24 חיים במטבע הנכס, ומחיר מנוע לעולם לא מתויג-מחדש בשקט. Beds24 לא
נגוע: `planCurrency` נשאר `tenants.currency`, ה-wire נשאר חסר-מטבע, ו-CURRENCY_MISMATCH
נשאר שער רדום במנוע (בכוונה — אף קורא אינו שולח requestedCurrency).

## D108 — בחירת "כרטיס אשראי" פותחת את שדות הכרטיס; צימוד חד-כיווני (2026-07-26)

**תלונה 7 של רונן.** בהזמנת ערוץ בלי כרטיס, שדות הכרטיס נפתחו רק דרך toggle נסתר
("הזנת כרטיס ידנית במקום") — המפעיל בחר "כרטיס אשראי" וציפה להקליד.

**ההחלטה.** `resolveCardMode` נשאר טהור (אמצעי תשלום אינו קלט שלו). שכבת ה-UI
מוסיפה צימוד **חד-כיווני**: בחירת `credit_card` כשאין כרטיס שמור/ערבות נכנסת
להזנה ידנית (השדות נפתחים מיד) — ביצירה (היה קיים, §15) ובעריכה (חדש). שום בחירה
אחרת אינה נועלת/מסתירה/מוחקת, וכרטיס שמור לעולם לא נדרס מבחירת method. בלוק
התיעוד ההיסטורי ב-card-rules.ts עודכן במפורש. שומר: `check:card-save-flow`.

## D109 — הערות חיוב הן הערות הזמנה; רדקציית CVV בהעברה (2026-07-26)

**תלונה 9.** ההערה חיה על שורת הכרטיס — נעלמת עם מחיקתו, לא קיימת בלי כרטיס.

**ההחלטה.** השדה הוסר מה-UI; מיגרציה 059 מעבירה את התוכן הקיים אל
`reservations.notes` עם prefix `"[הערת חיוב] "` (idempotent) ומרוקנת את המקור;
העמודה נשארת deprecated ותוסר בגרסה נפרדת אחרי אימות. **ממצא אבטחה בדרך:** אחת
ההערות בפרודקשן הכילה בלוק ערוץ מודבק עם CVV גלוי — 059 מבצעת רדקציה
(`Cvv: [הוסר]`) בזמן ההעברה (PCI-DSS Req. 3.2); אומת על העותק (0 תבניות CVV
בהערות אחרי ההרצה). פירוט: docs/booking-window/SECURITY.md §2.

## D110 — "קוד סודי מהערוץ": הערוץ לא מעביר — ההודעה אומרת למה, במקום גנרית (2026-07-26)

**הוראת רונן** הייתה מותנית: "אם מגיעים פרטי כרטיס — לחווט כולל CVC". **נמדד
(26/07/2026, קריאה-בלבד, הטוקן של החשבון):** ה-scopes מלאים
(`bookings-personal`, `bookings-financial`), אבל תשובות `/v2/bookings` אינן
נושאות אף שדה כרטיס, ו-`stripeToken`/`pcibookingToken` ריקים בכל ההזמנות —
ה-API של Beds24 מוסר כרטיסים רק כטוקנים (Stripe/PCI Booking), ולחשבון הזה אף
טוקן לא מופעל. לכן **אין מה לחווט**, ומומש המסלול השני של ההנחיה: הקבוע
"לא התקבל קוד סודי מהערוץ" הוחלף בהודעה מדויקת לפי מצב — כרטיס ערוץ בלי CVC
(המדיניות של Beds24) מול חשבון שכלל אינו מקבל כרטיסים ב-API (המצב היום), עם
הפניה להזנה ידנית. אם רונן יפעיל בעתיד מסירת טוקנים בצד Beds24 (PCI Booking) —
נקודת הכניסה המחווטת קיימת (`persistBookingRevision`→`attachStagedCard`,
מכוסה ב-`check:channel-card-ingest`), וזו תהיה החלטה חדשה. D52 §2 (הערוץ לא
מוסר CVC) נשאר עומד — לא כמדיניות שלנו אלא כעובדת הספק.

## D111 — ARI_HORIZON_DAYS = 720; האופק חוסם הכנסה-לתור בלבד, וחלון הייבוא נשאר 500 בנפרד (2026-07-28)

**למה 720 (נמדד, לא הונח).** Beds24 ענה HTTP 201 עם `success:false` ואזהרת
"invalid dates"; `modified` קיבל כל טווח עד 2028-05-31 והפיל את
2028-06-01 → 2029-11-01 **כמקשה אחת** — טווח שחוצה את המגבלה נדחה בשלמותו,
לא נחתך בצד הספק. הגבול האמיתי לא ננעץ — ידוע רק שהוא בתוך [673, 1191]
ימים. 720 = 24 החודשים המתועדים של Beds24 פחות שולי ביטחון של 10 ימים.
(מוזג ב-PR #124, f1bd073.)

**האופק היוצא וחלון הייבוא הנכנס הם עכשיו שני קבועים נפרדים — בכוונה.**
`ARI_HORIZON_DAYS = 720` (`ranges.ts`) מגביל את הפרסום היוצא בלבד.
`BEDS24_INBOUND_FORWARD_DAYS` (`beds24-booking-import.ts:125`) נשאר **500**
עד שהליכת השערים של D94 תבוצע עבור 720 — הרחבת חלון הייבוא היא החלטה
נפרדת עם השלכות משלה, ולא נגררת אוטומטית מהאופק היוצא.

**האופק חוסם ENQUEUE בלבד, לא פרסום — וזה הפער הפתוח שנשאר אחרי הניקוי.**
החיתוך שנוסף ב-`writeRateCells` מונע יצירת שורה מלוכלכת מעבר לאופק, אבל
בונה ה-drain גוזר את הטווח שלו מ-`date_to` המאוחסן של השורה
(`beds24-ari-sync.ts:580-582`: clamp לעבר בלבד — `from = rawFrom < today ?
today : rawFrom`, ו-`to` הוא המקסימום של `date_to` — ללא תקרת אופק). לכן
שורה שנוצרה לפני התיקון עדיין תפלוט מטען out-of-range שיידחה בשלמותו.
הניקוי (Phase 1/2) מטפל ב-28 השורות הקיימות; חסימת האופק בצד ה-drain עצמו
היא עבודה פתוחה.

## D112 — כשל חייב לשאת את הראיות של עצמו; טקסט טכני של הספק מוצג למפעיל (2026-07-28)

**התקרית.** שחזור מה ש-Beds24 באמת ענה לקח שעות: מסלול הכשל מיפה את התשובה
לקטגוריה ("validation") וזרק את המקור. למפעיל הודפס "(422)" עבור תשובה שהייתה
בפועל HTTP 201, והמילה שחשובה — "invalid dates" — ישבה בשדה `message` שהקוד
דיכא בכוונה (מדיניות ה-no-leak הישנה של beds24-ari.ts).

**ההחלטה, מבנית ולא תיקון נקודתי:**

1. **שימור ראיות ברגע הכשל (מיגרציה 062).** כל כשל ערוץ יוצא נשמר על רשומת
   השגיאה (`channel_sync_errors`): הסטטוס שהתקבל **מילולית** (`http_status`;
   NULL = לא הגיעה תשובה כלל), גוף התשובה **הגולמי וללא שינוי** קטום ל-2KB עם
   סמן קטיעה מפורש (`response_body` + `response_truncated`), המטען ששלחנו
   (`request_payload`), וחותמת UTC של רגע התצפית (`response_received_at`).
   הגוף נלכד **לפני** כל parsing/מיפוי (beds24-http קורא text ואז מנסה JSON) —
   גם עמוד שגיאה שאינו JSON שורד. הקטגוריה הממופה היא נתון נגזר שחי לצד
   המקור — לעולם לא במקומו.
2. **אסור להדפיס ערך שלא היה על התשובה.** הודעת הכשל של success:false על 2xx
   בונה את המספר מ-`r.status` עצמו ("Beds24 דחה את העדכון (HTTP 201)"), לא
   ממחרוזת קבועה. מסלול הולידציה המקומית (מטען שלא נשלח כלל) כבר לא מדפיס
   "(422)" — לא היה HTTP בכלל.
3. **טקסט טכני של הספק כן מוצג במסכי מפעיל פנימיים.** ההודעה למפעיל כוללת את
   מילות הספק ("invalid dates"), וטבלת השגיאות ב-/channels מציגה עמודת HTTP
   ואת הגוף הגולמי (details מתקפל). משטחי אורח אינם מושפעים. זה הופך את
   מדיניות הדיכוי הישנה (D78) לגבי **הגוף** — הטוקן וה-headers עדיין לא
   דולפים לעולם.
4. **שומר:** `check:beds24-failure-evidence` — מריץ את ה-drain האמיתי מול mock,
   וקורא את **השורה השמורה** חזרה: 201 ולא 422, גוף מילולי, קטימה מסומנת, מטען,
   חותמת; ניטרול ההתמדה תוך שימור המבנה מסביב מאדים אותו. `check:beds24-ari-drain`
   עודכן למדיניות החדשה (האסרט ההפוך — דיכוי הטקסט — הוא הדפקט עכשיו).

**הכלל הקבוע נוסף ל-GUIDELINES.md §13:** מסלול כשל שמדווח קטגוריה בלי לשמר את
תשובת הספק הגולמית הוא דפקט, באותה דרגה כמו בליעה שקטה. אבחון לעולם לא ידרוש
להריץ את הכשל שוב כדי לגלות מה נאמר.

## D113 — jsonb_set עם create_missing לא יוצר הורה; כתיבה מקוננת חייבת לבנות הורה ולאמת בקריאה-חוזרת (2026-07-30)

**התקרית.** GREEN-API היה מחובר, נבדק בהצלחה, ואף שלח הודעת בדיקה שהתקבלה
בפועל — ובכל זאת כל משטח WhatsApp במוצר טען "אין ספק מחובר", ואפשרות
"WhatsApp" בפאנל האוטומציה נשארה מושבתת. המפעיל לחץ על GREEN-API ב"ספק פעיל",
קיבל `toast.success`, ונרשמה שורת audit. שום דבר לא נשמר. שש לחיצות כאלה
תועדו על פני יומיים; כולן דיווחו הצלחה, אף אחת לא נכתבה.

**השורש.** `setActiveWhatsAppProvider` כתב את המצביע כך:

```sql
jsonb_set(COALESCE(settings,'{}'::jsonb), '{messaging,whatsappProvider}', to_jsonb($1::text), true)
```

`COALESCE` שומר מפני **עמודה** NULL — אבל העמודה לא הייתה NULL; **מפתח ההורה**
`messaging` היה חסר. ב-PostgreSQL, `create_missing` יוצר **אך ורק את האיבר
האחרון** בנתיב; כשאיבר ביניים חסר, `jsonb_set` מחזיר את המסמך **כמות שהוא**.
ה-UPDATE תפס את השורה, הדרייבר (porsager) לא זורק על UPDATE חסר-אפקט (השורה
אכן הותאמה — הערך החדש פשוט זהה לישן), ולא הייתה קריאה-חוזרת. אף מיגרציה מעולם
לא זרעה את `settings->'messaging'`, כך שכל דייר נולד לתוך הבאג.

**מפתח JSON יחיד חסר סגר שלושה פרדיקטים** — `data.ts` (‎`whatsappAvailable`),
`automation.ts` (`resolveConnectedWhatsAppChannel`), `providers.ts`
(`resolveWhatsAppProvider`) — וכולם נכשלו **סגור**, ולכן הסימפטום היה שקט.
שליחת הבדיקה עבדה כי היא בונה את המתאם ישירות מהחיבור ועוקפת את המצביע לגמרי.

**ההחלטה, מבנית ולא תיקון נקודתי:**

1. **כתיבה לנתיב מקונן חייבת לבנות את ההורה באותה הבעה.** הצורה שנבחרה היא
   מיזוג `||` (‎`COALESCE(settings,'{}') || jsonb_build_object('messaging', <הורה> || jsonb_build_object(...))`)
   ולא `jsonb_set` מקונן: היא ביטוי אטומי אחד, היא **ממזגת** ולכן מפתחות אחים
   תחת `messaging` שורדים, וההורה נבנה בלי לומר זאת פעמיים. ההורה נלקח דרך
   `CASE WHEN jsonb_typeof(...) = 'object'` ולא `COALESCE`, כי `COALESCE` אינו
   תופס JSON null — והוא היה מפוצץ את `||`.
2. **כתיבה מדווחת הצלחה רק אחרי שהוכיחה שנחתה.** הכותב מחזיר
   `RETURNING settings->'messaging'->>'whatsappProvider'`, משווה לערך המבוקש,
   וזורק `ActiveWhatsAppProviderWriteError` בכל אי-התאמה (כולל דייר שלא קיים).
   **שורת audit של כתיבה שלא נחתה היא דפקט**, לא רעש: `messaging_active_provider_changed`
   נכתב אך ורק אחרי אימות. הסדר הזה נושא משקל — לא לשנותו.
3. **קורא לא ממציא החלטה שאיש לא קיבל.** הקורא הישן קיפל NULL / מפתח חסר /
   מחרוזת לא-מוכרת / `"disabled"` לערך אחד — ולכן מצביע שמעולם לא נכתב נראה
   בדיוק כמו "מושבת" מכוון. הטיפוס פוצל: `WhatsAppProviderId` הוא מה שמותר
   **לכתוב** (שלושת הערכים שה-UI מציע), ו-`ActiveWhatsAppPointer` הוא מה שמותר
   **לקרוא** — קבוצה רחבה יותר הכוללת `not_configured` (מפתח חסר) ו-`invalid`
   (ערך פגום). `usableWhatsAppProvider()` הוא הקריאה היחידה של "האם יש ספק
   שמיש", וכל הקוראים הקיימים מתנהגים זהה לחלוטין.
4. **מיגרציה 066** זורעת `settings->'messaging' = '{}'` לכל דייר שחסר לו הורה
   (אידמפוטנטית; לעולם לא דורסת אובייקט קיים). היא **אינה** קובעת
   `whatsappProvider` — הבחירה היא של המפעיל, וניחוש כאן היה משחזר בדיוק את
   הבלבול שההחלטה הזו נועדה לסיים: מצביע שאיש לא בחר שנראה כמו בחירה.

**פתוח (לא משימה).** 14 קריאות `jsonb_set` נוספות בריפו הן חד-איבריות ולכן
בטוחות; הכתיבה הדו-איברית האחרת היחידה, `api/branding/logo/route.ts`, בונה את
ההורה כראוי בצורת `jsonb_set` מקונן. אין היום אתר קריאה פגום נוסף — אבל אין גם
שומר שימנע את הבא. הרחבת `scripts/check-messaging.mjs` (איסור נתיב רב-איברי
שאינו עטוף בבניית הורה, ואימות שהכותב מאמת בקריאה-חוזרת) לא נכללה בשינוי הזה.

**הכלל הקבוע:** נתיב `jsonb_set` בן שני איברים ומעלה עם `create_missing => true`
הוא no-op שקט כשההורה חסר. כתיבה ל-`settings` מקונן חייבת לבנות את ההורה
ולאמת בקריאה-חוזרת; כתיבה שמדווחת הצלחה בלי לאמת היא בליעה שקטה, באותה דרגה
כמו D112.

## D114 — תנאי ברירת-מחדל של טריגר חייבים לכבד ערוץ ונמענים; תנאי על צד שלא מקבל דבר לעולם לא חוסם שליחה (2026-07-30)

**התקרית.** אוטומציית WhatsApp ‏"שליחה לעצמי אחרי הזמנה" (owner-only,
`recipient_config.guest=false`, נמען `+972525460546`) דולגה על הזמנה 1053 עם
`conditions_not_met` — כי **לאורח** לא היה **אימייל**. התנאי
`{guest.email, exists}` הגיע מ-`defaultConditions` של הרגיסטרי
(`triggers.ts`, טריגר `reservation.confirmed` — הטריגר היחיד שנשא תנאי
קשר-אורח), נכתב מחדש בכל שמירה (`saveAutomationAction`), אינו נראה ואינו ניתן
לעריכה ב-UI — והוערך עיוור גם לערוץ (טלפון, לא אימייל) וגם לנמענים (האורח
כלל לא נמען). בנוסף, שורת הדילוג הציגה את טלפון האורח (`+972500000000`,
placeholder) ככתובת היעד של אוטומציה שנמענה היחיד הוא בעל-העסק, ונשאה רק
תווית גנרית בלי לנקוב בתנאי שנכשל.

**ההחלטה.**
1. **הערכת תנאים היא recipient- ו-channel-scoped, דינמית בזמן ההתאמה**
   (`src/lib/communications/conditions.ts`, מודול טהור). תנאי קשר-אורח
   (`guest.email`/`guest.phone`) מוערך רק כשלאוטומציה יש רגל אורח ברת-מסירה
   (`recipientConfig.guest && guestAddress !== null`), ועוקב אחר הערוץ:
   אימייל → `guest.email exists`; WhatsApp → `guest.phone exists` שעובר
   `normalizePhone`. **תנאי על צד שלא מקבל דבר — אורח שלא נבחר, או רגל אורח
   שכבר דולגה על כתובת פסולה — לעולם לא חוסם את שאר הנמענים.** (רגל אורח
   פסולה כבר נרשמת כ-`missing_guest_phone`/`missing_guest_email` — ראיה
   טובה יותר מ-`conditions_not_met`.)
2. **בחירה בדינמי ולא ב-save-time**: שורות קיימות מתקנות את עצמן בלי מיגרציה
   ובלי שמירה-מחדש (האוטומציה החיה `8238e37d` נרפאת מעצמה), וצורת הנתונים
   השמורה לא משתנה — אין סיכון rollback. הרגיסטרי ממשיך לאחסן `guest.email`
   כסמן קנוני של "קשר-אורח"; הערוץ מכריע מה נבדק בפועל.
3. **שורת `conditions_not_met` נושאת את הראיות של עצמה (עקרון D112)**:
   `error_detail` נוקב בפרדיקטים שנכשלו בעברית + הצורה הטכנית בסוגריים
   (`describeConditionFailures`). הפאנל מציג `error_detail` כלשונו — אין שינוי UI.
4. **כתובת מוצגת כנה בדילוג אוטומציה-שלם**: `to_address` (שאינו חלק משום
   אינדקס ייחודי) מציג את נמעני היעד המוגדרים כשהאורח אינו נמען; זהות ה-dedupe
   — `idempotency_key` בפורמט legacy **ו-`recipient_key='guest'`** (שניהם
   משתתפים באינדקסים ייחודיים, 036/065) — נשמרת byte-identical במכוון.
5. **שומר B2** ב-`check-guest-communications-automation.mjs`: מריץ את המנוע
   המקומפל עם ברירות-המחדל האמיתיות (כולל `guest.email exists`) ונכשל אם
   אוטומציית owner-only נחסמת, אם ה-scope מנוטרל באתר הקריאה, או אם הראיות/
   הכתובת המוצגת נעלמות. ה-workaround הישן בפיקסטורה ("conditions without the
   guest.email-exists gate") הוסר — הוא היה טביעת האצבע של הדפקט.

**הכלל הקבוע.** תנאי ברירת-מחדל של טריגר אינו רשאי להניח ערוץ או נמען.
כל תנאי שמתאר צד מסוים (guest.*) מוערך רק כשאותו צד באמת מקבל את ההודעה,
ובשדה שהערוץ באמת שולח אליו. דילוג חייב לנקוב בפרדיקט שחסם אותו.

## D115 — משתנה תבנית לעולם לא עולה שליחה בשקט: אופציונלי כברירת מחדל, `!` לחובה, `|` לחלופה (2026-07-30)

**הדפקט.** הרגיסטרי (`variables.ts`) גזר "נדרש" לכל משתנה באופן גלובלי —
עיוור לתבנית, לערוץ ולנמענים. תבנית WhatsApp שהזכירה `{{guest.email}}`
(משתנה שסומן required עבור סמנטיקת אימייל) דילגה על השליחה כולה לכל הזמנה
בלי אימייל — כולל אוטומציית owner-only שבה האורח כלל אינו נמען (אותה מחלקת
דפקט כמו 1053/D114). הדילוג נרשם `render_failed` עם תווית גנרית שלא נקבה
במשתנה, והעורך הציג "שליחה תדולג" גם על מה שבפועל רק יופיע ריק.

**ההחלטה.**
1. **הרגיסטרי כבר לא יודע "נדרש".** שדה `required` הוסר מ-`VariableDefinition`.
   חובה היא הצהרת **התבנית** שההודעה חסרת-משמעות בלי הערך — לא תכונה של
   המשתנה במופשט.
2. **דקדוק הטוקן** (מנותח במקום אחד — `replaceVariableTokens`/`splitVariableTokens`):
   `{{key}}` — חסר מרונדר ריק והשליחה יוצאת; `{{key|חלופה}}` — חסר מרנדר את
   החלופה, בלי issue בכלל (חלופה מוצהרת מספקת גם `!` — אין "חסר" שיחסום);
   `{{key!}}` — ורק הוא — מדלג כשאין ערך. משתנה לא-מוכר (typo/סחף רגיסטרי)
   נשאר חוסם: הוא לעולם לא יפתר עבור שום הזמנה — תבנית שבורה, לא ערך חסר.
3. **חסימה מוגדרת במקום אחד**: `isBlockingIssue` (missing_required /
   unknown_variable / invalid_url) — אותו כלל לכל המסלולים: WhatsApp, נושא,
   preheader, בלוקים ו-html.
4. **הדילוג נוקב במשתנה (עקרון D112)**: `describeRenderIssues` כותב
   ל-`error_detail` את `משתנה חובה חסר: guest.email` (וכן לא-מוכר/קישור פסול),
   בשני אתרי `render_failed` — אימייל (כולל נושא/preheader) ו-WhatsApp.
   שליחת בדיקה מסרבת עם אותה ראיה במקום "להצליח" על הודעה שהאוטומציה תדלג עליה.
5. **סקופ D114 לא הוחל על `!`, בכוונה**: תנאי (D114) מתאר *צד*; משתנה חובה
   מתאר את *תוכן ההודעה*, שזהה לכל הנמענים — אם ההודעה חסרת-משמעות בלי הערך,
   היא חסרת-משמעות גם לבעל העסק. האופציונליות-כברירת-מחדל היא שמחסלת את מחלקת
   "אורח חוסם בעלים"; `!` מפורש הוא הצהרה מודעת של המפעיל ומכובד כלשונה.
6. **העורך מבחין בין שתי חומרות**: "ריק בנתוני התצוגה — ההודעה תישלח עם ערך
   ריק" (מידע) לעומת "השליחה תדולג" (אזהרה, רק על `!`/לא-מוכר/קישור פסול).

**הכלל הקבוע.** משתנה חסר לעולם לא מדלג שליחה אלא אם התבנית הצהירה `!` —
וכשמדלגים, הדילוג נוקב במשתנה שחסם. אזהרת "תדולג" בעורך מותרת רק על מה
שבאמת ידלג. שומר: `check:wa-template-render` (מוטציה-מאומת).

## D116 — פלט WhatsApp עברי הוא RTL-safe ברינדור: RLM בראש כל שורה, לפי שפת התבנית, ופלט רינדור בלבד (2026-07-30)

**הדפקט.** WhatsApp גוזר כיוון לכל שורה מהתו החזק הראשון שלה (אין `dir`
בבועת צ'אט). שורה עברית שנפתחת בספרה, תאריך, ₪-סכום, מספר טלפון או לטינית —
מתהפכת ל-LTR אצל האורח. שום טיפול bidi לא היה קיים בשום שכבה, וה-preview
(`dir="auto"` על הבועה כולה) הציג כיוון אחד לכל ההודעה — שקר מאותה מחלקה
של טוסט ירוק על כתיבה שנכשלה.

**ההחלטה.**
1. **`rtlSafeWhatsAppText`**: לתבנית `language='he'` כל שורה לא-ריקה ברינדור
   מקבלת קידומת U+200F (RLM) — תו RTL חזק, בלתי-נראה, שמקבע את כיוון הפסקה.
   אידמפוטנטי; שורות ריקות לא נגועות; תבניות `en` לא מקבלות אף בייט.
2. **RLM בלבד, לא FSI/PDI.** מבודדי U+2068/U+2069 סביב ערכים משוקעים נשקלו
   ולא הוחלו: אי-אפשר לאמת מכאן אמפירית את התצוגה שלהם בבילדים ישנים של
   WhatsApp/Android, ו-RLM הוא הבסיס הבטוח והנתמך. שדרוג עתידי ידרוש אימות
   על מכשירים אמיתיים.
3. **פלט רינדור בלבד.** גוף התבנית השמור, מונה התווים בעורך ומה שהמפעיל
   הקליד — נשארים בייט-זהים. ה-RLM חי רק ב-`rendered_plain_text`/`body` של
   רשומת ה-outbound (זה ה-snapshot שנשלח), והמסירה (`deliverClaimedWhatsApp`)
   שולחת אותו מילולית.
4. **השפה זורמת מהתבנית**: `resolveVersion` בוחר `t.language` (בשתי השאילתות),
   האוטומציה מרנדרת עם `{ language: version.language }`, שליחת בדיקה עם שפת
   הקלט, והעורך עם שפת ה-state — כך שהחלפת שפה בתבנית משנה גם את ה-preview.
5. **ה-preview שווה לשליחה, כולל כיוון**: הבועה עברה ל-`unicode-bidi: plaintext`
   — כיוון לכל שורה מהתו החזק הראשון שלה, אותו חוק בדיוק כמו WhatsApp — ומציגה
   את אותם בייטים שהאורח יקבל (כולל ה-RLM).

**הכלל הקבוע.** הודעת WhatsApp עברית שמרונדרת לשליחה אסור שתכיל שורה
לא-ריקה שהתו החזק הראשון שלה LTR; אנגלית אסור שתקבל בייטים בלתי-נראים;
והתצוגה המקדימה מציגה את בייטי השליחה עם חוק הכיוון של WhatsApp. שומר:
`check:wa-template-render` (מוטציה-מאומת).

## D117 — פתרון גרסת תבנית הוא סקופ-שושלת; החלפת תוכן בין תבניות אינה fallback חוקי לעולם (2026-07-30)

**התקרית (הזמנה 1060).** אוטומציית אישור-ההזמנה שלחה לאורח את גוף
"הודעה לעצמי על הזמנה". `resolveVersion`, תחת `latest_published` עם שפת
אורח ממופה, חיפש "אחות" מפורסמת לפי `(tenant, category, channel, language)`
— צירוף תוויות, לא זהות — עם `LIMIT 1` ובלי `ORDER BY`. שתי תבניות
WhatsApp מפורסמות חלקו `reservation`+`he`; ה-JOIN התאים את שתיהן ותוכנית
הביצוע בחרה את הלא-נכונה. שורת המשלוח יצאה סותרת-עצמה: `template_id` של
תבנית אחת, `template_version_id` של אחרת. אף שומר לא נפל — הרנס המנוע
מזייף את `sql` ב-string-matching, והסטאב גילם את אותה הנחה שגויה.

**ההחלטה.**
1. **גרסה שנפתרת עבור תבנית שייכת תמיד לשושלת שלה.** חציה לתבנית אחרת
   אינה נכונה לעולם — לא כ-fallback, לא לשפה. אין גרסה בשפת האורח בתוך
   השושלת → הגרסה המפורסמת של התבנית המוגדרת עצמה, או דילוג נקוב. לעולם
   לא תוכן של תבנית אחרת.
2. **שושלת היא קשר מפורש, לא היסק מתוויות** (מיגרציה 067):
   `message_templates.lineage_id`; ‏NULL = "השושלת שלי היא אני" — תבנית
   לא-מקושרת נפתרת רק לגרסאות של עצמה. קישור זוג תרגום he/en הוא פעולה
   מכוונת עתידית. פיצ'ר העדפת-השפה נשמר — אבל רק בתוך שושלת.
   **השושלת שטוחה ונאכפת**: טריגר דוחה שרשרת (A→B→C) והפניה-עצמית — קיבוץ
   חד-שכבתי `COALESCE(lineage_id, id)` היה מפצל משפחה כזו בשקט. נמדד בפרוד
   לפני הפריסה: אין ולו קבוצת `(tenant, category, channel)` אחת עם יותר
   משפה אחת — כלומר מסלול ה"אחות" מעולם לא שירת תרגום בפועל, רק שגה.
3. **דטרמיניזם ואי-בחירה-במזל**: החיפוש ממוין (`ORDER BY (t.id=cfg.id)
   DESC, t.id` — התבנית המוגדרת קודמת) ׁ;ו->1 מועמדות באותה שפה בשושלת
   הוא דפקט קונפיגורציה: דילוג `template_resolution_ambiguous` שנוקב
   בשתי המועמדות (D112) + `needs_attention` על האוטומציה. עמימות לעולם
   אינה נפתרת ע"י תוכנית ביצוע.
4. **שורת משלוח אינה יכולה לסתור את עצמה** (067): ‏FK מרוכב
   `(tenant_id, template_id, template_version_id) → message_template_versions
   (tenant_id, template_id, id)`. שורות המשלוח חותמות את
   `version.template_id` — התבנית שתוכנה באמת נשלח. ‏`NOT VALID` בכוונה:
   שורות ה-30/07 שהדפקט ייצר נשארות כראיה — היסטוריה לא משוכתבת להיראות
   עקבית.
5. **המצביע המפורסם שייך לתבנית שלו** (067): ‏FK של 036 על
   `current_published_version_id` היה אגנוסטי-לתבנית — מצביע פגום היה מגיש
   את גופה של תבנית אחרת, אותה מחלקת דפקט במרחק באג-אחסון אחד. עכשיו
   ‏FK מרוכב הופך זאת לבלתי-כתיב, והמאתר גם נכשל-סגור ב-JOIN
   (`v.template_id = t.id`). תבנית מוגדרת בארכיון אינה שולחת דרך אחות חיה.
6. **שומר B2 מול Postgres אמיתי** (`check:resolve-version-lineage`,
   מוטציה-מאומת): פיקסטורת 1060 המדויקת; דפקט שחי ב-SQL חייב שומר שמריץ
   את ה-SQL — סטאב string-matching מגלם את הנחות מחברו ואינו ראיה. השומר
   **מוחק את אובייקטי 067 לפני שהוא מחיל את הקובץ ומאמת שנוצרו** — אחרת
   שרידים מריצה קודמת ב-testdb היו "מוכיחים" מיגרציה ריקה; והוא מסרב
   לכל יעד שאינו localhost:5433 ברשימת-היתר, לא ברשימת-סירוב.

**הכלל הקבוע.** זהות לעולם אינה מוסקת מצירוף תוויות. חיפוש שיכול להחזיר
יותר משורה אחת חייב מיון דטרמיניסטי, ו"יותר מאחת" במקום שבו מובטחת אחת —
נכשל-סגור בשם, לא נבחר במזל.

---

## D118 — קבוצות מקור להזמנות; OTA הוא מתג של המפעיל, לא חסימה — אבל רק היכן שיש לו מה לשלוט בו (2026-07-31)

**ההקשר.** עיצוב חלון-הצד של אוטומציית WhatsApp
(`design-ref/whatsapp-automation.html`) צייר חמישה צ'יפי מקור —
`manual / site / phone / Booking.com / Airbnb` — ואת השמירה גידר על "אישור
Meta". שני אלה נבדקו מול המציאות לפני שנבנה משהו
(`ref/audit/AUDIT-AUTOMATION-REDESIGN.md`).

**נמדד בפרודקשן (31/07), לא הונח:**
- הערוץ הספציפי **כן** נשמר: `reservations.ota_name` נושא את מחרוזת הערוץ
  המילולית של Beds24. ערכים חיים: `booking` (13 הזמנות) ו-`direct` (5).
  Airbnb ו-Expedia **מעולם לא הופיעו** — לא בהזמנות ולא בפיד הגולמי
  (`channel_booking_revisions`). Expedia אינו מחובר.
- `ota_name` הוא טקסט חופשי מהספק: אין enum, אין CHECK, אין רגיסטרי. מנוע
  הסינון עובד על `booking_origin` (‏3 ערכים), לא על `ota_name`.

**ההחלטה.**

1. **שלוש קבוצות מקור, לא חמש** (`SOURCE_GROUPS` ב-`triggers.ts`):
   ישיר-בק-אופיס · אתר ההזמנות · ערוצי OTA. ה-id של כל קבוצה **הוא**
   ערך `booking_origin` — צ'יפ לא יכול להציע מקור שהמנוע אינו יודע לסנן.
   צ'יפים נפרדים ל-Booking/Airbnb/Expedia לא נבנים: שניים מהם היו פקדים
   ריקים לצמיתות, וסינון לפי `ota_name` דורש שינוי מנוע. "טלפון" נשמט —
   הזמנה טלפונית היא `back_office`.

2. **OTA הוא מתג של המפעיל, לא חסימה קשיחה — אבל רק היכן שיש אירוע.**
   `exclusions.ota` **נגזר** מבחירת המקורות בנתיב השמירה במקום להיצרב
   מברירת-המחדל של הרגיסטרי. המנוע כבר קורא ומכבד את השדה — זה המתג
   שהיה חסר, לא התנהגות מנוע חדשה.

3. **`reservation.confirmed` יוצא מן הכלל, והפקד שם מושבת בגלוי.** עבור
   הזמנת OTA **לא נפלט אירוע אישור כלל**: הייבוא מ-Beds24 פולט רק
   `cancelled`, והפולט במעבר-הסטטוס מגודר ב-`booking_origin !== 'ota'`.
   מתג פעיל שם לא היה שולט בדבר. לכן הצ'יפ **מושבת**, והסיבה מוצגת
   כטקסט גלוי — לא כ-`title` על פקד אפור. זה גובר על "אזהרה ולא חסימה":
   אזהרה על כפילות הייתה עצמה שקר, כי דבר לא היה נשלח.
   הזמינות נגזרת מ-`otaHardSkip` — אותו דגל שהמנוע מדלג עליו — כדי
   שהפקד והנתיב לא יוכלו להיפרד.

4. **נכשל-סגור בשרת.** בקשה שמבקשת OTA על טריגר עם `otaHardSkip`
   **נדחית** עם הסיבה, ולא מנוקה בשקט. הצמדה שהמפעיל אינו רואה היא
   בדיוק הפגם שהסעיף הזה מבטל.

5. **מה שהעיצוב הבטיח ואין לו כיסוי — לא נבנה.** אין צ'יפ אישור-Meta ואין
   גייט שמירה עליו (ל-GREEN-API אין אישור תבניות; לצ'יפ אין מקור נתונים);
   אין תג "עסק מאומת", אין וי כחול ואין כפתורי תגובה —
   `GreenApiWhatsAppProvider.sendMessage` נושא מחרוזת אחת. במקום הצ'יפ
   מוצג מצב הפרסום האמיתי. התצוגה המקדימה מרנדרת את **הגרסה המפורסמת**
   דרך `renderTemplateContent` — הרנדרר של נתיב השליחה עצמו, כולל סימוני
   ה-RLM (D116). אין רנדרר שני, ואין תצוגה של טיוטה שלא תגיע לאורח.

**הכלל הקבוע.** פקד מוצג כזמין רק כאשר היכולת שמאחוריו קיימת. כשהיא
חסרה — הפקד מושבת **והסיבה נראית**. `check:guest-communications` נכשל אם
הפאנל מציג ערוץ, תבנית או מקור כזמינים בזמן שהיכולת נעדרת (אומת ב-10
מוטציות).

**הסתייגות שנמדדה ולא נסגרה.** ‏5 הזמנות נושאות `booking_origin='ota'` עם
`ota_name='direct'` — הזמנות ישירות של Beds24 שנכנסות לדלי ה-OTA. הפעלת
הקבוצה תתפוס גם אותן, והן דווקא **אינן** שולחות אישור משלהן. כמו כן איכות
הטלפונים המגיעים מ-OTA לא נמדדה; נמען לא-תקין מייצר דילוג נקוב
(`missing_guest_phone`) שנראה בהיסטוריה — לא שליחה שקטה.

---

## D119 — אישור הזמנה לאורחי OTA: סימן-מים בנקודת המעבר, פליטה בענף היצירה בלבד (2026-07-31)

**המטרה.** רונן שולח וואטסאפ משלו לכל אורח שמזמין, כולל אורחי OTA. זה בלתי
תלוי במה ש-Booking.com שולח. D118 השאיר את הצ'יפ מושבת כי **לא נפלט אירוע
אישור** בייבוא — סעיף 3 שם. הסעיף הזה סוגר את פער היכולת ופותח את המתג.

### נמדד לפני שנבנה משהו (31/07, פרודקשן, קריאה בלבד)

**טלפונים — כל האוכלוסייה, לא מדגם.** 20 הזמנות OTA: 15 `booking` + 5 `direct`.
**כולן** עוברות `normalizePhone` — 19 ניידים ישראליים ואחד עם קידומת 33. מספר
המשרת יותר מאורח מובחן אחד (החתימה של מאגר relay): **0**. אחד חוזר על עצמו
ותמיד לאותו אורח. כל 10 ההזמנות המאושרות פותרות `chatId` שניתן לשלוח אליו.
זה סוגר את ההסתייגות של D118 ("איכות הטלפונים לא נמדדה"). מגבלה שנאמרת
במפורש: n=20 היא כל האוכלוסייה אך היא קטנה, ו-Booking.com הוא ה-OTA היחיד
שאי פעם הופיע.

**הסיכון הרטרואקטיבי — נמדד ועצר את הבנייה בסבב הראשון.**

| origin | status | שורות | יש אירוע אישור | **אין** |
|---|---|---|---|---|
| back_office | confirmed | 26 | 26 | 0 |
| back_office | cancelled | 17 | 17 | 0 |
| direct_website | cancelled | 9 | 7 | 2 |
| **ota** | **confirmed** | **10** | **0** | **10** |
| **ota** | **cancelled** | **10** | **0** | **10** |

סה״כ 72 הזמנות, 50 אירועי אישור, **22 הזמנות ללא אירוע**. ‏18 מתוך 20 הזמנות
ה-OTA יושבות בתוך `LOOKBACK_DAYS = 7`, כלומר המשיכה המצטברת הבאה רואה אותן שוב.

### מה הגן על "אירועים חדשים בלבד" — והתשובה שעצרה

ההגנה היחידה היא **דדופ לכל-חיי-ההזמנה**: המפתח
`reservation:<id>:confirmed:v1` תחת
`UNIQUE (tenant_id, event_type, aggregate_type, occurrence_key)` (מיגרציה 036).
אין חותם `created_at`, אין הבחנה בין ייבוא לשינוי, ואין זיהוי מעבר-סטטוס.

ההגנה הזו יושבת **במורד הזרם מהפליטה**, בטבלת האירועים עצמה. היא מבטיחה
"לעולם לא אירוע **שני**". היא חסרת אונים מול אירוע **ראשון** להזמנה שכבר
קיימת. בלי סימן-מים, המשיכה הבאה הייתה יוצרת אירועי אישור ראשונים ל-10
הזמנות OTA מאושרות קיימות — וואטסאפים אמיתיים לאורחים שהזמינו לפני שבועות.

### ההחלטה

1. **סימן-מים בנקודת המעבר (מיגרציה 068).** תופסים את מפתח-ההיארעות של **כל
   הזמנה שקיימת** ברגע המעבר בשורת אירוע `status='processed'`. המפתח תפוס
   לנצח, ולכן שום פולט לא יוכל להוציא אירוע חי להזמנה קודמת — לא משנה באיזה
   נתיב יגיע. רק הזמנות שנוצרו **אחרי** המיגרציה יכולות לפלוט.
   - `'processed'` ולא `'pending'`: `claimCommunicationEvents` תופס `pending`
     או `processing` עם חכירה שפגה. שורה מעובדת בלתי-נראית לעובד לפי אותו
     כלל שמסתיר אירוע שהסתיים — בלי מצב חדש ובלי מקרה מיוחד.
   - **כל ההזמנות, לא רק OTA**: נקודת המעבר היא זמן, לא מקור. שתי שורות
     `direct_website` שגם להן חסר אירוע מכוסות באותה תנועה.
   - **נכשל-סגור**: המיגרציה מפילה את עצמה אם מספר השורות שנכתבו אינו שווה
     למספר ההזמנות שחסר להן מפתח, או אם נותרה הזמנה לא מכוסה. סימן-מים חלקי
     גרוע מכלום — הוא נראה כמו הגנה. כישלון עוצר את הדפלוי **לפני** כל
     `pm2 restart` (‏`deploy-production.sh` מריץ מיגרציות אחרי הבנייה ולפני
     ההפעלה מחדש), ולכן הקוד הפולט לעולם לא מתחיל מול סימן-מים חלקי.
   - אידמפוטנטי כפליים: `NOT EXISTS` + `ON CONFLICT DO NOTHING`.

2. **נקודת הפליטה: ענף היצירה של `applyLiveRevision`, ושם בלבד.** הזמנה
   מיובאת **נולדת** במצב `'confirmed'` (הליטרל ב-`INSERT`), ולכן זה הרגע —
   והיחיד — שבו הזמנת OTA מגיעה למצב מאושר. הקריאה יושבת בתוך ה-`else`,
   כך שייבוא חוזר **אינו יכול להגיע אליה כלל**: תכונה תחבירית, לא בדיקת ריצה.

3. **למה נדחה זיהוי-מעבר ב-`booking-import.ts:421`.** השורה
   `const status = PRESERVED_STATUSES.has(existing.status) ? existing.status : "confirmed"`
   כותבת `'confirmed'` בכל עדכון, בלי שום השוואה לערך הקודם — `PRESERVED_STATUSES`
   מכיל `checked_in`/`checked_out` בלבד. בענף הזה פשוט **אין** אות שמבחין בין
   "הגיעה עכשיו למאושרת" ל"הייתה מאושרת מלכתחילה". להוסיף שם זיהוי מעבר
   פירושו לגעת בליבת הייבוא ולתלות הודעה לאורח בנכונות של השוואת-סטטוס
   שנעשית בכל משיכה — ואפילו אם תיכתב נכון, היא עדיין פולטת בכל מעבר חוזר
   לגיטימי. הענף שנבחר נותן את אותה תוצאה בלי לגעת בליבה, והוא ניתן להוכחה
   סטטית.

4. **פעם אחת לכל הזמנה, לנצח — שתי הבטחות בלתי תלויות.**
   (א) מבנית: הפליטה בלתי-נגישה מענף העדכון; (ב) מפתח ההיארעות
   `reservation:<id>:confirmed:v1` תחת האינדקס הייחודי, כשמיגרציה 068 כבר
   תפסה אותו לכל הזמנה שקדמה למעבר.

5. **המתג נפתח, כבוי כברירת מחדל.** `otaHardSkip` יורד ל-`false` עבור
   `reservation.confirmed`, ולכן `otaSourceBlockReason` מחזיר `null` לכל
   הטריגרים. `defaultExclusions.ota` נשאר `true` — רונן מדליק ביודעין.
   הצ'יפ הענברי נשאר, ולצידו טקסט גלוי: ה-OTA שולח אישור משלו, האורח יקבל
   אישור **נוסף**. אזהרה על כפילות היא אמת עכשיו — ב-D118 היא עצמה הייתה
   שקר, כי דבר לא נשלח.

6. **`isChannelBooking` — פרדיקט אחד לשני שערי ה-OTA.** דילוג-הקשיח השתמש
   בצורה הרחבה (מקור **או** קישור ערוצי חי), ו-`exclusions.ota` בצרה. כל עוד
   `reservation.confirmed` נשא `otaHardSkip`, הרחבה כיסתה אותו; הורדת הדגל
   הייתה **מצמצמת בשקט** את משמעות "OTA" עבור אישורים. נמדד במעבר: מתוך 52
   הזמנות שאינן `'ota'`, **אפס** נושאות `external_booking_id` /
   `channel_connection_id` / `ota_name`. האיחוד אינו משנה התנהגות היום, שומר
   על רוחב ההגנה, ויכול רק לדלג **יותר** — לעולם לא לשלוח יותר.

### מעבר D94 על כל שער תלוי-סטטוס

| שער | מיקום | על הנתיב שהפליטה מפעילה? |
|---|---|---|
| `BEDS24_STATUS_FILTER` | `beds24-booking-import.ts` | כן — `confirmed`/`new` נמשכים בכל מחזור |
| `PRESERVED_STATUSES` | `booking-import.ts:339` | כן — ולכן הפליטה **לא** הושמה בענף העדכון (סעיף 3) |
| `applyCancellation` · `existing.status !== 'cancelled'` | `booking-import.ts` | לא — ענף הביטול בלבד |
| `blocksAutomaticRelease` (`checked_in`) | `inventory-rules.ts` | לא — שחרור מלאי, לא פליטה |
| השוואה `status IN ('confirmed','checked_in')` | `beds24-booking-import.ts` | סמוך — רואה את אותן שורות; אתר פליטה שני אילו הועברה לשם |
| `trigger.eligibleStatuses = ['confirmed']` | `triggers.ts` | כן — ‏10 השורות עומדות בו, כלומר אינו מגן |
| `trigger.otaHardSkip` | `triggers.ts` | כן — היה החוסם היחיד; הסעיף הזה מסיר אותו, וסימן-המים תופס את מקומו |
| `exclusions.ota` (D118) | `automation.ts` | כן — כבוי כברירת מחדל; המפעיל מדליק |

### אימות

`check:ota-confirm-once` (B2, שני חצאים). **מבני**: הפליטה בתוך ענף היצירה
(התאמת סוגריים, לא grep), מפתח לכל-חיי-ההזמנה, האינדקס הייחודי, ו-068 רשומה
במניפסט · תופסת את מפתח הפולט עצמו · `'processed'` · מאמתת את עצמה · עיוורת
למקור. **התנהגותי**, מול DB מבודד (‏:5433) בטרנזקציה שתמיד מתגלגלת אחורה:
מריץ את **גוף המיגרציה האמיתי** ובונה את המפתח מהתבנית האמיתית ב-`outbox.ts`,
ואז מוכיח שמשיכה-חוזרת מדומה פולטת **אפס** להזמנות שקדמו למעבר, ששורת
סימן-מים בלתי-נראית לפרדיקט התפיסה של העובד, ושהזמנה שנוצרה אחרי המעבר פולטת
בדיוק פעם אחת. אומת ב-5 מוטציות (ביטול הבקפיל · ביטול שקט שרק חצי-ה-DB תופס ·
הזזת הפליטה אל מחוץ לענף · מפתח שמשתנה בכל קריאה · הסרת 068 מהמניפסט), כל אחת
הוחזרה זהה-בייטים.

**סימולציה על נתונים חיים, קריאה בלבד:** משיכה מלאה מדומה אחרי הבקפיל פולטת
**0** אירועים ל-72 ההזמנות הקיימות. לא נשלח דבר.

**תוצאת לוואי שנמדדה ותוקנה.** ל-`communication_events.reservation_id` יש
`ON DELETE RESTRICT` בכוונה (‏036: אירוע הוא ראיה למה שנשלח לאורח). מרגע שנתיב
היצירה פולט, הזמנה שנוצרה בייבוא נושאת אירוע ולכן אינה ניתנת למחיקה קשה. בפרודקשן
זה חסר משמעות — ‏D77 §8 הוא בטל-לעולם-לא-תמחק, והמחיקה הקשה היחידה בריפו נמצאת
בסקריפט בדיקה — אבל **שני שומרים נפלו על כך בפועל** (`check:beds24-credit-backoff`,
`check:beds24-quarantine-selfheal`): הפירוק שלהם מחק הזמנות בלי לנקות אירועים.
תוקן בדיוק כפי ששומרי הביטול כבר עשו — `outbound_messages` ואז
`communication_events` לפני `reservations`. סימן-המים עצמו אינו מוסיף כבילה
כזאת מעבר לקיים, אך הוא מרחיב אותה מ-50 מתוך 72 ההזמנות לכולן.

**חלון שנשאר פתוח ונאמר במפורש.** הזמנה שהייבוא ייצור בין המיגרציה לבין
`pm2 restart` נוצרת בידי הקוד הישן ולכן לא תקבל אירוע אישור לעולם. זה הכיוון
הבטוח — הודעה שלא נשלחה, לא הודעה כפולה — ומדובר בשניות.

## D120 — קטלוג החדרים לאתר הוא endpoint ציבורי נפרד; זמינות ומחיר לעולם לא מגיעים ממנו (2026-08-01)

**המטרה.** עמוד הבית של sea-tower הציג עד היום שלושה כרטיסי דירה שכתובים
בקוד — כותרות, תמונות וקופי שאינם מסונכרנים עם שום דבר. הבקשה: הכרטיסים
יגיעו מ-GuestHub, כדי שעדכון במסך "חדרים" יופיע באתר בלי דפלוי.

**מה כבר היה ומה חסר.** `/api/public/availability` מחזיר סוגי חדרים עם תפוסה
ומחיר **לפי תאריכים**, ואין בו תוכן: התמונות (`room_images`), התרגומים
(`room_translations`) והמתקנים (`room_amenities`) יושבים ברמת **החדר הבודד**.
כלומר אי אפשר לבנות כרטיס תוכן מהזמינות, ואי אפשר לבנות כרטיס זמינות מהתוכן.

**ההחלטה.** ‏`GET /api/public/rooms` — קטלוג קריאה-בלבד של החדרים המסומנים
`show_on_website`, מאותר באותו `x-booking-secret` ומוגבל לאותו
`PUBLIC_TENANT_ID` כמו שאר ה-API הציבורי.

1. **תוכן בלבד, בכוונה.** התשובה לא מכילה זמינות ולא מחיר — גם לא
   `base_price`. שני המספרים האלה תלויי-תאריך, והדבר היחיד שגרוע ממחיר לא
   מוצג הוא מחיר מיושן שמוצג. מי שרוצה מחיר קורא ל-availability עם תאריכים.
2. **שדה חסר חוזר `null`, לא מחרוזת ריקה.** מתוך 14 החדרים המסומנים לאתר
   ל-8 יש גלריה, לחלק אין `summary` ולחלק אין `size_sqm`. הצרכן מחליט מה
   להסתיר; ה-API לא ממציא ערכי ברירת מחדל.
3. **חדר בלי תמונה לא חוזר בכלל.** גלריה ציבורית עם חור היא באג, ובלי הסינון
   הזה כל צרכן היה מסנן לעצמו. ‏`show_on_website` פותח את השער, תמונה תקפה
   אחת לפחות היא תנאי הכניסה.
4. **שורה ב-`room_translations` אינה הוכחה לתרגום.** האפליקציה מזריעה אותה
   מהשם הפנימי של החדר, ולכן ב-13 מתוך 14 החדרים שורת ה-`he` מחזיקה את
   התווית האנגלית של ה-PMS ("1102 - One Bedroom Apartment Sea"). טקסט שאין
   בו אף אות של הכתב המבוקש נחשב **לא מתורגם**, ואז שרשרת הנפילה ממשיכה.
   זה חל גם על `summary` ו-`description`: פסקה באנגלית בעמוד עברי גרועה
   מפסקה חסרה.
5. **כותרת לעולם לא ריקה, ותמיד בשפה הנכונה.** ‏`room_translations.name` →
   `rooms.name` → `room_types.name` (שהבעלים מתחזק בעברית, ולכן הוא תווית
   הציבור המאושרת לחדר לא מתורגם) → `room_number`. השדה `titleSource` מספר
   מאיזו חוליה הגיעה הכותרת, כדי שצרכן שמציג את סוג החדר כתג נפרד לא ידפיס
   את אותן מילים פעמיים.
6. **הגלריה ממוינת `is_main DESC, sort_order`**, כך שהצרכן לוקח `images[0]`
   בלי להכיר את הדגל.

**הגשת התמונות.** ה-URLs נשארים `/uploads/rooms/<roomId>/<file>` — הנתיב
הקיים, שעוקף את ה-middleware בזכות סיומת התמונה ולכן זמין בלי סשן. אתר
sea-tower מגיש אותם מאותו origin דרך rewrite ל-loopback, כדי שדומיין
הבק-אופיס לא ייחשף לדפדפן.

## D121 — זמינות ותוכן מתחברים לפי מזהה החדר הפיזי בלבד (2026-08-01)

**הבעיה.** עמוד ההזמנות של sea-tower הציג תוכן שיווקי מקובץ קונפיג מקומי,
ממופה לפי **שם סוג החדר**. התוצאה: שלוש דירות פיזיות שונות קיבלו את אותה
כותרת, אותו תיאור ואותן תמונות סטוק מהאתר, ואף אחת מהן לא הראתה את הדירה
שהאורח באמת מזמין.

**ההחלטה.** ‏`/api/public/availability` מחזיר מעכשיו גם `roomId` לכל יחידה —
מזהה החדר ב-`guesthub.rooms`. זה המפתח **היחיד** שבו מותר לחבר את תשובת
הזמינות לתוכן מ-`/api/public/rooms`.

1. **למה לא מספר חדר, שם, סוג או מיקום במערך.** מספר חדר משתנה בשיפוץ, שם
   ותווית סוג הם טקסט חופשי שהבעלים עורך, ומיקום במערך משתנה עם המחיר —
   כל אחד מהם היה מחבר ביום מן הימים דירה אחת לתמונות של אחרת.
2. **הרשאה לא משתנה.** `roomId` כבר עבר בתוך מודל הקריאה (`BookableUnit`),
   רק לא נכתב ל-JSON; יחידה בלי חדר פיזי (pooled) ממילא מסוננת מלכתחילה.
3. **חלוקת הסמכות נשארת חדה.** מחיר, זמינות ומזהי ההזמנה — מ-availability
   בלבד. שם, קופי, תמונות, מתקנים וגודל — מ-rooms בלבד. אין שדה שמגיע משני
   המקורות, ולכן אין מצב שהם סותרים.

## D122 — TTLock כחיבור מוצפן פר-דייר; מפתח נפרד, אזור כציר, ופיצול בטוח-לוורקר (2026-08-01)

**מה נבנה כאן, ורק זה.** שכבת החיבור: טבלה אחת פר-דייר, פותר טוקן, ומקטע
הגדרות עם כפתור "בדיקת חיבור" שמדווח תוצאה אמיתית בעברית. **לא** נבנו: רשימת
מנעולים, טבלת קודים, מחזור קודים, מסלול `/locks`, פריט בסיידבר, טיק בוורקר,
או קריאה כלשהי ל-`/v3/keyboardPwd/*`. הם משימה נפרדת, והיעדרם כאן מכוון —
פיצ'ר מנעולים חצי-בנוי שנראה קיים גרוע מאחד שלא התחיל.

### מספר המיגרציה — התיקון שקדם לכתיבה

התדריך הניח **058** בהנחה ש-057 "שמור לענף השהייה הארוכה". שתי ההנחות התיישנו:
`057_length_of_stay_discounts.sql` הוחל **ובוטל** ע"י
`063_drop_length_of_stay_discounts.sql`, ו-058 הוא `058_reservation_totals_v2.sql`.
המספר הפנוי בפועל היה **069**, ורונן אישר. הלקח נרשם כי הוא יחזור: מספר מיגרציה
"שמור" בתדריך הוא עובדה בת-תפוגה — הקובץ ‎`manifest.txt` הוא מקור האמת היחיד,
ו-`migrate.mjs` מצליב אותו מול הדיסק לשני הכיוונים (יוצא 2 על כל פער).

### חיבור פר-דייר, לא משתנה סביבה

חשבון TTLock שייך לבעל הנכס, לא לשרת. לכן `ttlock_connections` עם
`UNIQUE (tenant_id)` ו-FK ל-`tenants` — בדיוק כמו חיבורי Beds24 והתקשורת לפניו.
משתנה סביבה היה משתף לכל הדיירים את המנעולים של בעלים אחד, וזה כל מודל הכשל.

### `TTLOCK_SECRETS_KEY` — מפתח נפרד, רדיוס פגיעה נפרד

לא `CHANNEL_SECRETS_KEY` ולא `MESSAGING_SECRETS_ENCRYPTION_KEY`. אישור TTLock
פותח **דלתות פיזיות**; אישור ערוץ מוכר חדרים. אותה דוקטרינה שמפרידה את כספת
הכרטיסים משניהם. הבנייה זהה (AES-256-GCM, IV טרי 96 סיביות, כישלון-סגור על
מפתח חסר) — ההפרדה היא במפתח, לא באלגוריתם.

### האזור הוא ציר אמיתי, לא קישוט

TTLock מפעילה שני ענני-על נפרדים. אפליקציה שנרשמה ב-`euopen.ttlock.com` **אינה
קיימת** עבור `api.ttlock.com`, ולהפך. אי-ההתאמה חוזרת כ-`errcode 10001` — **אותו
קוד בדיוק** כמו סוד שגוי, ונורה **לפני** ש-TTLock בכלל מסתכלת על החשבון. אילו
האזור היה קבוע בקוד, מפעיל שהאפליקציה שלו רשומה בענן השני היה רואה "סוד שגוי"
לנצח כשבידו סוד תקין לחלוטין — ומחליף סיסמה טובה שוב ושוב. לכן עמודה נבחרת,
ולכן `hebrewMessageFor(10001)` אומרת במפורש "או שהאפליקציה רשומה באזור אחר"
ולעולם לא מאשימה את הסיסמה.

### הפיצול בטוח-לוורקר: `http.ts`/`token.ts` מול `store.ts`

`http.ts` ו-`token.ts` לא מייבאים `next/…`, `react`, או מודול `"use server"`,
כדי שגרף ה-PM2 worker יוכל לקמפל אותם כ-CommonJS במשימה הבאה **בלי ריפקטור**.
זה בדיוק הפיצול שכפה על `beds24-token.ts` להתקיים בנפרד מ-`beds24-admin.ts`,
והפעם הוא נעשה מראש. `store.ts` הוא ה"use server"-side: הוא היחיד שקורא סוד
מהמסד, והוא היחיד שמחזיק `server-only`.

### למה `server-only` **הוסר** משלושת המודולים — והמחליף שלו

`src/lib/channel/crypto.ts` **כן** נושא `import "server-only"`, ובכל זאת
`beds24-token.ts` שבגרף הוורקר מייבא אותו ועובד. זה עובד רק משום שחבילת
`server-only` נפתרת ל**מודול ריק** מחוץ לתנאי `react-server` של React — תאונת
אריזה, לא תכנון. היא לא הורחבה לאינטגרציה שנייה. במקומה, שלוש הגנות אמיתיות:

1. **`check:ttlock-secrets` כלל 5** — נכשל אם קובץ עם `"use client"` מגיע
   ל-`src/lib/ttlock/` **במישרין או בהשתלשלות**. זה הסיכון בפועל (הגרף נוחת
   בבאנדל הדפדפן), וזה יותר ממה ש-`server-only` אי פעם בדק. בבדיקה האדוורסרית
   הוא תפס את ההפרה דרך `SettingsShell` — שתי קפיצות מהקובץ ששונה.
2. **`crypto.ts` לא מחזיק סוד משלו** — הוא קורא את `TTLOCK_SECRETS_KEY` בזמן
   קריאה, ו-Next מטמיע בבאנדל לקוח רק `NEXT_PUBLIC_*`. ייבוא לקוח היפותטי נכשל
   ב"לא מוגדר" במקום לדלוף חומר מפתח.
3. **`store.ts` שומר `server-only`** — הגבול נאכף היכן שהסוד באמת נקרא.

### `/v3/lock/list` כבדיקה, לא הטוקן לבדו

טוקן מוכיח שהאישורים נפתחים ושהחשבון קיים. הוא **לא** מוכיח שהחשבון מגיע ולו
למנעול אחד — חשבון TTLock טרי בלי מנעולים משותפים מנפיק טוקן תקין לחלוטין
ושולט בכלום. רשימת המנעולים היא הקריאה הראשונה שנוגעת במה שלמפעיל אכפת ממנו,
והמספר שהיא מחזירה הוא מה שהוא משווה מול מספר הדירות שהוא מכיר. בדיקה מבוססת-
טוקן בלבד הייתה מדווחת "תקין" על חשבון שלעולם לא יפתח דלת.

### חוזה ה-API — ארבע חריגות שנאכפות בקוד

‎(1) כל נקודת קצה היא `POST` עם `x-www-form-urlencoded`, **כולל קריאות** —
‏`/v3/lock/list` הוא POST. ‏(2) הסיסמה עוברת כ-MD5 הקסדצימלי קטן, לעולם לא
כטקסט. ‏(3) קריאות מאומתות נושאות `clientId` + `accessToken` + `date` בן 13
ספרות (אלפיות שנייה; חותם בשניות נדחה). ‏(4) **TTLock עונה `200 OK` על
כישלון** — `res.ok` לא מוכיח דבר, והסטטוס האמיתי הוא `errcode` בגוף. קוד שסמך
על סטטוס ה-HTTP היה מדווח חיבור שבור כתקין.

### מה שנרשם ומה שלא

‏`entityType: "ttlock_connection"`. שום סוד, טוקן, סיסמה או גוף-תשובה של הספק
לא נכנס ל-payload של ביקורת, ללא לוג, ללא הודעת שגיאה וללא ערך מוחזר —
נאכף בכלל 4. מה שכן נרשם הוא **האם** סוד סופק (בוליאני), לא ערכו.
‏`errmsg` של TTLock הוא סינית ולעולם לא מוצג; התרגום הוא לפי **קוד** בלבד.

### single-flight — מה הוא באמת מכסה

ה-`Map` ברמת המודול מבטל כפילויות **בתוך תהליך Node אחד בלבד**. ה-worker הוא
תהליך אחד, אבל אפליקציית Next היא **תהליך שני** עם עותק משלו. שני תהליכים
*יכולים* להנפיק במקביל. זה מקובל ולא נמנע — הנפקה כפולה אידמפוטנטית אצל הספק
ולא עולה קרדיט, בניגוד ל-Beds24. ההערה בקוד אומרת זאת במפורש כדי שאיש לא יקרא
"single-flight" כערובה גלובלית ויבנה משהו שזקוק לה.

### הרשאות: שני גבולות שונים בכוונה

`locks.view` / `locks.rotate` נזרעו בקטלוג וניתנו ל-`super_admin` **ו-`admin`**.
הגישה לאישורים עצמם היא `canManageTTLock` — **`super_admin` בלבד**, כמו
`canManageChannels` ו-`canManageMessaging`. אדמין **מחליף קוד לדלת** (פעולה
תפעולית) ולעולם לא **רואה אישור**. שני דברים שונים, שתי הגנות שונות. אף מסך
עדיין לא צורך את ההרשאות — הן נזרעו כדי שהמשימה הבאה תשלח מסך מול מפתח קיים.

### שני מריצי מיגרציות — ‏`db/migrate.mjs` לא נוגע בפרודקשן, לעולם

בריפו יש **שני** מריצים, עם **שתי סכמות ledger שונות**. מי שמגיע ל-069 (או לכל
מיגרציה עתידית) צריך לדעת מראש באיזה מהם מדובר, כי השם המתבקש הוא הלא-נכון.

| | `scripts/db/migrate.mjs` (`db:replay`) | `scripts/apply-pending-migrations.mjs` |
|---|---|---|
| יעד | `MIGRATE_DATABASE_URL` בלבד | `docker exec -i supabase-db psql -U supabase_admin` |
| פרודקשן | **מסרב** ל-`:5432` מקומי (שורות 46-50) | זהו נתיב הפרודקשן |
| עמודות ledger | `version, checksum, applied_at, applied_by` | `filename, applied_at` |
| סדר | `manifest.txt` | `readdirSync().sort()` |

‏`db/migrate.mjs` הוא **שחזור-מאפס לבסיס נתונים חד-פעמי בלבד**, ומבנית אינו
יכול לפגוע בפרודקשן — שתי חומות בלתי תלויות: ‏(1) הוא דורש
`MIGRATE_DATABASE_URL` ומסרב מפורשות ל-`:5432` מקומי, שהוא ה-pooler המשותף של
הפרודקשן; ‏(2) גם אם החומה הראשונה הייתה נעקפת, טבלת ה-ledger בפרודקשן היא
`filename, applied_at` — **`version` ו-`applied_by` לא קיימות שם**, ולכן
`SELECT version || …` בשורה 76 היה נופל לפני שמשהו הוחל. כל האזכורים שלו
ב-`docs/` מכוונים לבסיס נתונים חד-פעמי לאימות replay, אף אחד לא לפרודקשן.

הנתיב היחיד לפרודקשן הוא `apply-pending-migrations.mjs`, שהדפלוי מריץ
(`scripts/deploy-production.sh:66`) **לפני** ה-restart של pm2, עם `|| fail`
שמפיל את כל הדפלוי. הוא גם היחיד שכותב את שורת ה-ledger.

היסטורית: 66 השורות הראשונות ב-`guesthub.schema_migrations` נושאות חותמת זמן
זהה — הן backfill חד-פעמי של 064 (‏62 שמות ב-`INSERT`) ועוד ארבע (‏055, 060,
061, 063) שהריצה הראשונה של המריץ החדש גילתה כתלויות והחילה בזו אחר זו. רק
065-068 הן הפעלות סדרתיות אמיתיות, אחת לדפלוי. לפני 064 מיגרציות הוחלו ביד
ללא רישום כלל — וזה בדיוק מה שתקרית ca11f15 חשפה.

**מסקנה מעשית:** מי שמושיט יד ל-`db/migrate.mjs` מול פרודקשן מושיט יד למריץ
הלא-נכון. אין DSN לנחש; אין `MIGRATE_DATABASE_URL` ב-`.env.local` בכוונה.

### פתוח / לא נסגר כאן

- **‏`apply-pending-migrations.mjs` אינו אטומי — נרשם, לא תוקן.** ההחלה
  (`psql -f -`) ושורת ה-`INSERT` ל-ledger הן **שתי הפעלות psql נפרדות**
  (שורות 73 ו-82), לא טרנזקציה אחת. קריסה ביניהן משאירה את הקובץ מוחל אך לא
  רשום, והדפלוי הבא מחיל אותו שוב. זה בטוח **רק** משום שכל מיגרציה בריפו
  אידמפוטנטית בפני עצמה — אינווריאנט נושא-משקל שעד כה לא היה מתועד בשום מקום
  מלבד הכותרת של המריץ עצמו. שים לב לניגוד: `db/migrate.mjs` **כן** עוטף את
  שניהם ב-`--single-transaction`. לא שיניתי את מריץ הפרודקשן כאן — שינוי מריץ
  הדפלוי אינו בטווח משימת שכבת-החיבור.
- **מספור הסעיף הזה נדד פעמיים — D120 → D121 → D122.** הענף ארוך-חיים ביחס
  לקצב המיזוגים ל-main: ‏PR #142 (קטלוג חדרים ציבורי) תפס את D120 עוד בנקודת
  ההסתעפות (`2ae9bf0`) ואני לא ראיתי זאת, ו-PR #143 (‏`roomId` בזמינות) תפס
  את D121 בזמן שהענף הזה חיכה לביקורת. main הוא תמיד הבעלים; הסעיף הזה הוא
  **D122**, על פני כל הקבצים (מיגרציה 069, guards, store, actions, ה-UI,
  סקריפט השומר). הלקח האמיתי אינו "לקרוא את `DECISIONS.md` בזהירות" — קראתי,
  והמספר התיישן שוב אחר כך. מספר החלטה שנבחר בתחילת ענף הוא **הימור על כך
  ש-main לא יתקדם**, והוא צריך אימות מחדש בכל rebase, לא רק בכתיבה הראשונה.
- **`tsconfig.worker.json` לא מכסה את `src/lib/ttlock/`** ולא יכול: ה-`include`
  שלו הוא בדיוק `["src/lib/channel/worker.ts"]`, כך ש-tsc לא רואה את התיקייה עד
  שקובץ וורקר מייבא אותה — כלומר במשימה הבאה. עד אז `check:ttlock-secrets` הוא
  **האכיפה היחידה** לבטיחות-הגרף, ולכן כלל 2 עוקב אחרי הייבוא בהשתלשלות ולא
  מסתפק בייבוא ישיר.
- **מגבלת `pageSize=100`** בבדיקה: מפעיל עם יותר ממאה מנעולים יראה ספירה
  חסרה. מקובל לשכבת חיבור; העימוד שייך לרשימת המנעולים במשימה הבאה.
- **`check:design` אדום ב-main** על `housekeeping/my-tasks` (מסך קפוא, STATE.md).
  לא נגעתי בו והוא נכשל זהה על main נקי — לא רגרסיה של הסעיף הזה.

### לקח כלי שנתפס תוך כדי

מפשיט-ההערות של סקריפט שומר חייב להסיר הערות-שורה **לפני** הערות-בלוק. הטקסט
‎`next/` ואחריו כוכבית, שנכתב בתוך הערת `//` שמסבירה מה אסור לייבא, **פותח**
הערת בלוק עבור הביטוי הרגולרי ובלע את כל הקוד עד סגירת ה-JSDoc הבא — כולל
קבועי האזור שהסקריפט בודק. כאן זה עלה בכישלון-שווא; באותה קלות הוא היה מסתיר
כישלון אמיתי ע"י מחיקת הקוד שנבדק. אותו פגם קיים ב-`check-messaging.mjs`
ובאחרים שהעתיקו את המפשיט — לא תוקן שם בסעיף הזה.

## D123 — מנעולי TTLock: המיפוי הוא של המפעיל, והיעדרות מסנכרון היא תקלה ולא הוראת מחיקה (2026-08-01)

**מה נבנה כאן, ורק זה.** ‏`ttlock_locks` — טבלת המנעולים והמיפוי שלהם לחדרים,
סנכרון שמושך את הרשימה מ-TTLock, מסך `/locks`, וקטגוריה חדשה בסיידבר. **לא**
נבנו: טבלת קודים, הנפקת קוד, מחזור קוד, כפתור "החלף קוד", קריאה כלשהי
ל-`/v3/keyboardPwd/*`, טיק בוורקר, או קישור להזמנה. הם PART 2. ההרשאה
`locks.rotate` קיימת מ-069 ועדיין **אין מאחוריה מסך** — בכוונה.

### הכלל המרכזי: סנכרון לא מוחק, סנכרון מסמן

המימוש המתבקש של "סנכרן את רשימת המנעולים" הוא: משוך, עדכן את מה שחזר, מחק את
השאר. המימוש הזה **הורס עבודה של המפעיל**. שער תקשורת שנפל, קצה עימוד, מגבלת
קצב, או מנעול שהוסרה שיתופו זמנית מהחשבון — כל אחד מהם מחזיר רשימה **קצרה
יותר**, וכל אחד מהם היה מוחק בשקט מיפוי שנבנה ביד. המפעיל היה מגלה זאת כשדלת
מפסיקה לקבל קודים, בלי שאף מסך מסביר למה.

לכן מנעול שלא חזר בתשובה **מסומן ולא מוסר**: ‏`missing_since := now()`, וכל
השאר — קודם כול `room_id` — נשאר במקומו. השורה חיה, המיפוי חי, והמסך אומר
בקול שהמנעול לא הופיע בסנכרון האחרון ומאיזה תאריך. מנעול שחוזר מנקה את הסימון.
**מחיקה היא החלטה של מפעיל, לעולם לא של סנכרון**, ואין ב-`src/lib/ttlock/`
נתיב שמוחק שורת מנעול. ‏`missing_since IS NULL` בתנאי העדכון שומר על ההיעדרות
**הראשונה** כתאריך הרשום — מנעול שנעדר שבוע לא ייקרא "נעדר מהבוקר".

### `room_id` לעולם לא נכתב ע"י סנכרון

הקישור מנעול↔חדר הוא ידע של המפעיל שלא קיים בשום מקום למעלה: ‏TTLock מכיר דלת
בשם "דירה 4 כניסה" ומעולם לא שמע על חדר 402. לכן לשורה שמגיעה מלמעלה אין ולא
יכולה להיות דעה עליו. האכיפה בקוד היא **השמטה** — `room_id` פשוט לא נמצא לא
ברשימת העמודות של ה-INSERT ולא ב-`DO UPDATE SET` — והשמטה היא בדיוק סוג ההגנה
שעריכה מאוחרת מבטלת בטעות. משום כך היא נבדקת: כלל 6 ב-`check:ttlock-secrets`.

### מנעול אחד לחדר אחד — פעמיים אותו כלל

‏`UNIQUE (tenant_id, ttlock_lock_id)` מונע שאותו מנעול עליון ינחת פעמיים.
‏`UNIQUE (tenant_id, room_id) WHERE room_id IS NOT NULL` מונע ששני מנעולים
יתפסו חדר אחד. האינדקס השני **חייב** להיות חלקי: כל המנעולים הלא-ממופים נושאים
`room_id NULL`, ואינדקס ייחודי רגיל היה מסתפק בזה רק משום ש-NULL לא מתנגש
ב-Postgres — הישענות על כך היא צירוף מקרים, לא תכנון.

‏`room_id` הוא `ON DELETE SET NULL` ולא CASCADE: מחיקת חדר לא מוחקת מנעול. הדלת
עדיין קיימת ועדיין שייכת לחשבון של הדייר; היא פשוט הופכת ללא-ממופה. נבדק על
בסיס נתונים חד-פעמי — מחיקת החדר השאירה את השורה והתירה את הקישור.

### שלושה מצבים על המסך, ואחד מהם לא קיים בשום מקום אחר

המסך עונה על שאלה אחת: אילו דלתות מכוסות. לכן הוא מציג מנעולים ממופים,
מנעולים בלי חדר, **וחדרים פעילים בלי מנעול**. הנכס הזה מחזיק 15 חדרים פעילים
מול 12 מנעולים — כלומר שלוש דלתות יישארו לא-מכוסות גם במיפוי מושלם. בלי
הרשימה השלישית, "12 מנעולים, כולם ממופים" נקרא כאישור-כללי שקרי.

הציר הפוך מזה של מיפוי Beds24 במתכוון: שם השורה היא חדר מקומי שבוחר יחידה
מרוחקת, כאן השורה היא **מנעול** שבוחר חדר. הכינוי (`lockAlias`) הוא איך שאדם
מזהה דלת, ולכן הוא מוביל. האינטראקציה עצמה — ‏`select` בשורה, מצב עריכה מול
מצב סטטי, שבב ספירה `ממופים {n}/{total}` — זהה לזו שהמפעיל כבר מכיר.

### עימוד: לתקינות, לא לקיבולת

בדיקת החיבור של 069 מבקשת עמוד אחד של 100 ומדווחת `total` — די כדי להוכיח
שהאישורים מגיעים לחומרה אמיתית. סנכרון **לא יכול** לעצור שם: אילו עמוד 2 היה
קיים ומדולג, כל מנעול שבו היה נחשב נעדר מהתשובה ומסומן `missing_since`. שנים-
עשר המנעולים של הדייר הזה נכנסים היום בעמוד אחד; הלולאה קיימת לתקינות. תקרת
`MAX_PAGES` **זורקת** במקום להחזיר רשימה חלקית, מאותו נימוק בדיוק.

### פיצול בטוח-לוורקר, ולמה `db` ולא `sql`

‏`locks.ts` מצטרף ל-`http.ts`/`token.ts`/`crypto.ts` כקוד בטוח-לגרף-הוורקר: בלי
`server-only`, בלי `next/…`, בלי `react`. לכן הוא קורא את שורת החיבור עם ה-`db`
שמוזרק לו ולא דרך `store.ts`, שנושא `server-only` בכוונה — הוא המקום שבו סוד
יוצא ממסד הנתונים.

### לקח כלי: שומר יכול להפסיק לשמור בלי להשתנות

מפשיט-התבניות המשותף ב-`check-ttlock-secrets.mjs` זיהה רק `` sql` ``. משום
ש-`locks.ts` מקבל את החיבור בשם `db`, **כלל 3 הפסיק לכסות קובץ שלם בתיקייה
שהוא שומר** — בשקט, בעודו מדפיס וי. הסורק הורחב ל-`(?:sql|db)`, ולכן כללים 1-5
נבדקו אדוורסרית מחדש: תיקון בקוד ניתוח משותף מבטל את ההוכחה הקודמת.

הכלל השני נתפס באותה בדיקה. כלל 8 סינן תבניות לפי המחרוזת `guesthub.` — כך
שהסרת הסכימה מהשאילתה הוציאה אותה **מתחום הכלל עצמו**, והשומר נשאר ירוק על
בדיוק העריכה שהוא נועד לתפוס. הסינון הוחלף לזיהוי הפניה לטבלה. כלל שהטריגר שלו
הוא הדבר שהוא אוסר אינו כלל — וזה נמצא רק משום שהבדיקה האדוורסרית נעשתה בפועל.

### פתוח / לא נסגר כאן

- **סנכרון שמחזיר רשימה ריקה מסמן את כל המנעולים כנעדרים.** זו התנהגות נכונה
  לפי הכלל (לא-הרסנית, הפיכה בסנכרון הבא), אך היא רועשת: חשבון שכל המנעולים
  הוסרו ממנו זמנית ייראה כאילו הכול נעדר. לא הוחלט אם ראוי סף.
- **אין מסך למחיקת מנעול.** מנעול שהוסר לצמיתות מהחשבון יישאר מסומן לנצח. זו
  ההחלטה — מחיקה שייכת למפעיל — אבל הפעולה עצמה טרם נבנתה.
- **`locks.rotate` עדיין בלי מסך**, מ-069. נשאר כך עד PART 2.
- **`check:design` אדום ב-main** על `housekeeping/my-tasks` (מסך קפוא, STATE.md):
  6 הפרות, זהה בדיוק עם השינויים האלה ובלעדיהם. לא רגרסיה של הסעיף הזה.

---

## D124 — קודי TTLock: קודם מוסיפים, רק אחר כך מוחקים; והסנכרון לא מסווג מחדש (2026-08-01)

**הקשר.** 069 שמר את החיבור, 070 נתן לכל דלת שורה ומיפוי לחדר. כאן נכנסים
הקודים עצמם — הספרות שהאורח מקיש על המקלדת — יחד עם מסך שמציג אותם, כפתור
שמחליף את קוד הדירה, וטיק בוורקר שמרענן הכול כל חמש דקות. `locks.rotate`, שנזרעה
ב-069 ונשארה בלי מסך שתי מיגרציות, סוף-סוף מקבלת אחד.

### הדלת לעולם לא נשארת בלי קוד

זה האינווריאנט שכל השאר משרת. ההחלפה היא **הוספה קודם, מחיקה אחרונה**:

| מה קרה | מצב הדלת | מה המפעיל רואה |
|---|---|---|
| ההוספה נכשלה | הקוד הישן עדיין עובד | שגיאה; שום דבר לא השתנה |
| הוספה ✓ מחיקה ✓ | הקוד החדש בלבד | "הקוד הוחלף" |
| הוספה ✓ מחיקה ✗ | **שני** קודים עובדים | שורה כתומה קבועה, עד שהניסיון החוזר יצליח |

הסדר ההפוך — למחוק ואז להוסיף — הופך כל כשל רשתי למשפחה שעומדת מול דלת נעולה
בחצות. אין מסלול שבו הדלת נשארת בלי קוד, וזה נבדק מול Postgres אמיתי (ראה למטה).

מכאן גם ה-outbox `ttlock_ops`: המחיקה היא הצעד היחיד שקורה **אחרי** שהמפעיל כבר
קיבל את הקוד החדש. כל השאר הצליח או נכשל מול העיניים שלו; המחיקה, אם תיכשל בשקט,
משאירה קוד חי על דלת אמיתית לזמן בלתי מוגבל. לכן היא נכתבת, נמשכת עם backoff,
ומוצגת על המסך כל עוד היא פתוחה.

### הסנכרון קורא בלבד, ולא מסווג מחדש

`syncPasscodes` קורא ל-`/v3/lock/listKeyboardPwd` ולשום endpoint כותב. אלה קודים
חיים על דלתות חיות: הדבר היחיד שרשאי לשנות מה שיושב על דלת הוא `rotateApartmentCode`,
שאדם לחץ עליו. שומר 9 בודק את **גרף הקריאות**, לא גוף פונקציה אחד — הקוד שנשבר
בבדיקה ישב ב-`fetchPasscodes`, לא ב-`syncPasscodes`.

`role` נקבע פעם אחת, בהכנסה, ולעולם לא מחושב מחדש (שומר 10). השמות ניתנים לעריכה
אצל הספק, ושתי דרכים שונות היו הורסות דלת חיה: שינוי שם מ-"דירה 4" ל-"דירה 4
(ישן)" היה הופך את קוד האורח ל-`other`, וכפתור ההחלפה היה יוצר קוד דירה **שני**
לצד קוד חי במקום להחליף אותו; ושם שמכיל "מנהל" היה גורם לקוד האורח להיראות כקוד
המנהל — הקוד היחיד שהפיצ'ר הזה לא רשאי להחליף לעולם.

קוד שנעלם מהתשובה מסומן `missing` ואף פעם לא נמחק — אותה דוקטרינה של `missing_since`
ב-070, מאותה סיבה.

### חמש ספרות, ולכן חובה שער

קוד שאנחנו בוחרים מחייב `addType=2` — משלוח דרך Gateway. **שניים מ-12 המנעולים
בפרודקשן הם `hasGateway=0`**, ולהם לא ניתן להחליף קוד מרחוק כלל. המסך אומר את זה
במשפט ומכבה את הכפתור, במקום לתת לקריאה להיכשל מול החומרה ולהחזיר errcode סיני.

`keyboardPwdType` לא נמצא בשום payload ששמור אצלנו — `/v3/lock/list` לא מחזיר
אותו. לכן הערך לא מתורגם אלא **מועתק** מקוד הדירה הקיים על אותה דלת; הקבוע 2 הוא
נפילה אחורה בלבד, לדלת שמעולם לא היה לה קוד.

### `noKeyPwd` — קוד מנהל שישב אצלנו בלי שאיש שם לב

הכותרת של 070 קבעה ש-`/v3/lock/list` "מחזיר metadata ולא credential". זה **לא
נכון**: ה-payload נושא את `noKeyPwd`, קוד המנהל של המנעול, בטקסט גלוי — ולכל 12
השורות בפרודקשן יש אחד. הוא מעולם לא הוצג, לא הוחזר מאקשן ולא נכתב ללוג, כך ששום
דבר לא דלף; אבל קוד דלת חי לא אמור לשבת במנוחה בעמודת jsonb שהתועדה כנקייה
מ-credentials. 071 מנקה את המפתח מהשורות הקיימות ו-`locks.ts` מסיר אותו לפני כל
כתיבה. אנחנו לא צריכים את קוד המנהל, ולכן לא שומרים אותו.

### מה שהבדיקה מול DB אמיתי מצאה

37 בדיקות על מסד חד-פעמי (בקונטיינר ה-staging; פרודקשן לא נגעו בו), עם שכבת HTTP
מזויפת ובלי שום קריאה לחשבון החי. היא תפסה **באג אמיתי במסך**: אזהרת "הקוד הישן
עדיין פעיל" נגזרה מ-`state` של השורה **המוצגת**, אבל השורה המוצגת היא החדשה —
כלומר האזהרה הייתה בלתי-נגישה בדיוק במקרה שבשבילו היא קיימת. `DISTINCT ON` גם
הסתיר לגמרי קוד ישן שהוורקר ויתר עליו. שניהם תוקנו: הבחירה עברה ל-TS, והמסך מקבל
את שתי הספרות האחרונות של **כל** קוד דירה חי נוסף.

### המגירה היא SidePanel, לא מעטפת שנייה

הרפרנס מגיע עם ה-overlay, הפאנל וכותרת הבאנר הכחולה שלו. פורט מילולי שלהם נתן
למסך הזה מגירה **שנפתחת מהצד ההפוך לכל מגירה אחרת במוצר** — וללא Esc לסגירה,
ללא מלכודת פוקוס, ללא portal וללא נעילת גלילה, שכולם קיימים ב-§7 מזמן. מגירה
ייעודית למסך אינה בחירה חזותית; היא מימוש שני לבעיה פתורה, וכלל ברזל #8 אומר
בדיוק את זה.

המעטפת הוחלפה ב-`SidePanel` הקנוני, החלקים הפנימיים הם `.card` + `.card-bd`,
והכפתור הראשי יושב ראשון ב-DOM כי `.dw-ft` הוא row-reverse. נמחקו ~2.5KB CSS
שהיו כפילות של design-system.css — כולל ההצהרה בראש locks.css שלפיה שום דבר בו
לא מצהיר מחדש פרימיטיב, שהייתה פשוט לא נכונה כל עוד המעטפת ישבה שם.

### מה פתוח

- **אין ניקוי היסטוריה.** שורות `revoked` נשמרות לנצח. מכוון בשלב הזה, אבל בלי
  מדיניות שמירה זו טבלה שרק גדלה.
- **`rotated_reason='checkout'` קיים ולא נכתב** — התפר ל-phase B, בכוונה.
- **הטיק מסנכרן כל דיירים ברצף.** ב-12 מנעולים זה 12 קריאות כל 5 דקות; בקנה מידה
  אחר צריך יהיה חלוקה למנות.
- **`check:design` אדום ב-main** על `housekeeping/my-tasks` (מסך קפוא, STATE.md):
  6 הפרות, זהה בדיוק עם השינויים האלה ובלעדיהם. לא רגרסיה של הסעיף הזה.

### עדכון D124 — שתי החלטות UX בזרימת ההחלפה (2026-08-01)

**האישור הפנימי בהחלפה הוסר.** בקשה מפורשת של הבעלים: לחיצה אחת על כפתור
הרענון מחליפה מיד. מצב ה-busy ("מחליף…") והכפתור המושבת בזמן הפעולה נשארו.
האישור עצמו לא בוטל מהמסך — הוא ממשיך לשמור על **שינוי שיוך**, שהיא הפעולה
ההרסנית: הפניית דלת לדירה אחרת היא שקטה וקל לטעות בה. החלפת קוד, לעומת זאת,
מכריזה על עצמה (הקוד החדש מוצג חשוף) והדלת ממשיכה לעבוד כך או כך, ולכן הקלקה
שנייה לא קנתה שום ביטחון — רק חיכוך בפעולה הנפוצה ביותר.

**סיומת התצוגה `#`.** המקלדת מצפה לסיום עם `#`, ולכן כל מקום שבו קוד **מוצג או
מועתק** במסך המנעולים מרנדר `62245#`. זו תצוגה בלבד: הקוד השמור, הערך שנשלח
ל-`/v3/keyboardPwd/add`, מסכת ה-audit ובדיקת הכפילות — כולם ספרות ונשארים
ספרות. הסיומת מיושמת בתוך ה-`<bdi className="ltr-num">` הקיים, כדי שכיוון
הפסקה RTL לא יזיז אותה מהספרות שאליהן היא שייכת.

`#` שהיה מגיע ל-payload היה מייצר קוד על הדלת שאיש לא יכול להיכנס איתו, והשורה
המקומית הייתה חולקת על החומרה בלי דרך להכריע. לכן כלל 11 גדל בשתי בדיקות: הערך
`keyboardPwd` שנמסר לשכבת ה-HTTP, וכל `#` שהוא ב-`src/lib/ttlock/` — השנייה
תופסת את הגרסה הערמומית יותר, שבה הסיומת נאפית לתוך הקוד עוד לפני שהקריאה
נבנית. שתיהן נבדקו אדוורסרית: שתי שבירות, שתיהן אדומות.

---

## D125 — /locks V2: הפורט של העיצוב, החלפה קבוצתית עם קודים של המפעיל, וה-CSS שנשאר במסך (2026-08-01)

**הקשר.** הבעלים סיפק עיצוב מלא למסך המנעולים. D123 בנה את המיפוי, D124 את
הקודים; כאן המסך נבנה מחדש לפי הרפרנס — חיפוש, צ'יפים לסינון, מיון, בחירה
מרובה, ומגירת החלפה קבוצתית — בלי שינוי סכימה.

### חמישה אלמנטים נחתכו מהרפרנס, וזה תיעוד ההחלטה

| מה | למה |
|---|---|
| סנכרון לגוגל שיטס + מגירת הייצוא | היכולת לא קיימת |
| "שליחת הקוד לאורחים" | תשתית ההודעות מושבתת; יחזור כשתעלה |
| "החלף גם את קוד המנהל" | **נדחה** — החלפה קבוצתית של קוד מנהל היא סכנת נעילה בחוץ |
| "החלה מיידית" | חסר משמעות — החלפה תמיד מיידית |
| כפתור PDF | מחוץ לסקופ הסבב הזה |

חתוך = **נעדר**, לא מושבת ולא "בקרוב". מסך שמראה מתג שאינו עושה דבר מלמד את
המפעיל שהמסך משקר.

### ההחלפה הקבוצתית רוכבת על המכונה של המנעול היחיד

`bulkRotateApartmentCodesAction` לא בונה payload משלה. כל פריט עובר דרך אותו
`rotateApartmentCode` של D124 — אותו סדר הוספה-לפני-מחיקה, אותו outbox, אותו
אינווריאנט "הדלת לעולם לא בלי קוד". ההבדל היחיד הוא `requestedCode`. שכפול
המכונה הזו הוא בדיוק איך שתי הגרסאות היו נפרדות, והחצי שהיה סוטה הוא זה שנוגע
בעשר דלתות בלחיצה.

ריצה **סדרתית** עם בידוד לכל מנעול: שער אחד מנותק לא יבטל את התשעה האחרים. לא
במקביל — כל החלפה היא שתי קריאות מול חשבון אחד מוגבל-קצב, ודוח כשלים קריא רק
אם הסדר הוא של המפעיל. **audit אחד לכל מנעול**, במסכה של D124; אין שורת סיכום
מצטברת, כי רשומה אחת ובה עשרה קודים היא בדיוק התיעוד העמיד שכלל 11 קיים כדי
למנוע.

### `codeRejection` — שופט אחד לשתי הדרכים

הגרלה אקראית וקוד שהמפעיל הקליד חייבים לעבור את אותו רף. לפני המגירה היו
הבדיקות משובצות בתוך `generateCode`; נקודת כניסה שנייה שהייתה מממשת מחדש
"4–6 ספרות, בלי רצפים" הייתה סוטה מהראשונה ברגע שאחת מהן משתנה. הכללים עברו
לפונקציה אחת, שתי הדרכים קוראות לה, ו-Zod בשכבת האקשן בודק **צורה בלבד** —
בכוונה, כדי שלא יהיה עותק שני של הרשימה השחורה. כלל 17 מפיל את הבנייה אם מסלול
המפעיל מפסיק לעבור שם.

### ה-CSS יושב במסך, והצבעים הם טוקנים

הרפרנס מגיע עם ~17KB CSS משלו. הוא פורט ל-`src/app/styles/locks.css` — התבנית
שהריפו כבר משתמש בה למסך חד-פעמי (`rooms.css`, `guests.css`) — עם שורת `@import`
אחת ב-globals.css, שהוא בדיוק תוכן העניינים שכלל ברזל #9 מתאר.

הרפרנס צויר מול Azure Ethos ו-`design-system.css` גם הוא, ולכן המיפוי כמעט
1:1: `#2540C8` הוא `--brand`, ה-focus ring וה-card shadow שלו זהים ספרה-ספרה
ל-`--focus-ring` ו-`--shadow-card`. שבעה ערכים באמת חדשים (משפחת הענבר לטיפול
"אין שער" ו"חדרים ללא מנעול", ומשטח אדום רך לתג השגיאה) — הם מוצהרים **פעם
אחת** בראש הקובץ עם `ds-allow` ונימוק, במקום להתפזר כ-hex בעשרים כללים.

JetBrains Mono לא נטען באפליקציה והוספת משפחת גופן למסך אחד נאסרה — כל `.code`
משתמש במחסנית ה-mono הקיימת עם `tabular-nums`, שהיא המדד שבאמת חשוב לקריאת קוד.
כל שאר התכונות החזותיות נשמרו. גבהי הפקדים עלו מ-38/40/46/48 ל-44 — גם תקן
האפליקציה וגם כלל הברזל של יעד המגע.

### מה שהעיצוב לא ידע על הנתונים

הרפרנס והפרומפט מניחים **2** מנעולים ללא שער. בפועל היום יש **3** מתוך 12 —
הרשימה השתנתה מאז D124. המסך גוזר את זה מהנתונים ולא מקבוע, ולכן הוא צודק גם
מחר; אבל הפער עצמו שווה דיווח.

הרפרנס גם צובע סוללה ב-60/30 בעוד שהפרומפט כתב 70/40 בסוגריים. ה-HTML הוא
החוזה למראה — 60/30 נשמר, וכך גם סף "סוללה חלשה" (<40) שהוא מספר שלישי ונפרד
ברפרנס עצמו.

### מה פתוח

- **#147 מוזג ולא נפרס.** הסיומת `#` לא הופיעה למפעיל כי עץ הפרודקשן היה
  קומיט אחד מאחור — לא רגרסיה בקוד. דורש דפלוי, שהוא של רונן.
- **צילומי המסך נעשו מול fixture**, לא מול DB מלא: אין ב-repo מסלול עוקף
  אימות, ולא היו לי אישורי כניסה. הקומפוננטה וה-CSS האמיתיים נבדקו; הלולאה
  המלאה מול השרת נבדקה ב-D124 ובכללים 16-17.
- **אין מיון על "קוד דירה"/"קוד מנהל"** — מיון לפי קוד הוא הזמנה להסתכל על
  קודים, לא לתפעל דלתות.

---

## D126 — הזמנה תופסת חדר בכל סטטוס, עד שהיא מבוטלת (2026-08-03)

**ההחלטה (בעלים).** הזמנה היא הזמנה. לא שולמה, לא אושרה, האורח לא הגיע, האורח
כבר עזב — כל עוד היא לא **בוטלה** היא מחזיקה את הלילות שלה: ביומן, במסך החדרים,
בשומר ה-DB, ובזמינות שמתפרסמת ל-Beds24 ולערוצים שמעליו. `cancelled` הוא הסטטוס
היחיד שמשחרר מלאי.

### מה היה שבור

`guesthub.inventory_blocking_statuses()` החזירה `confirmed/checked_in/blocked`
בלבד. טיוטה **צוירה** על היומן (היא ב-`CALENDAR_VISIBLE_STATUSES`) אבל לא תפסה
כלום. התוצאה לא הייתה באג תצוגה אחד אלא ארבעה, כי כל שכבת זמינות קוראת לאותה
פונקציה:

- שבב החדר ביומן הראה **"פנוי"** מתחת לפס ההזמנה עצמו.
- `check_room_availability()` דיווחה על החדר כפנוי לנתיב הכתיבה.
- `is_blocking` נשאר `false`, ולכן שומר ה-DB `rr_no_double_booking` **לא כיסה**
  את השורה — הזמנה שנייה חופפת הייתה עוברת.
- `room_type_inventory()` / `sellable_unit_inventory()` המשיכו לפרסם את החדר
  כזמין ל-Beds24.

נמדד חי ב-03/08/2026: חדר 1424 הציג "פנוי" בזמן שהזמנה 1077 (draft, לילה
03→04/08) ישבה עליו. כלומר טיוטה הייתה נתיב ישיר ל-double booking דרך OTA.

### מה שונה

מקור אמת אחד, בשני עותקים שנבדקים זה מול זה (`check:inventory`):
מיגרציה 073 מחליפה את `inventory_blocking_statuses()`, ו-`INVENTORY_BLOCKING_STATUSES`
ב-`src/lib/inventory-rules.ts` מראה את אותה רשימה. כל שאר השכבות כבר קראו לה
ולכן זזו יחד — 004 (בדיקת הזמינות), 005 ו-009 (הזמינות שנשלחת לערוצים), 006,
037 (הטריגרים שגוזרים `is_blocking`), 040 (חסימות מוקלדות).

מקום אחד **לא** קרא לפונקציה והיה חייב תיקון ידני: לוח `/rooms`
(`src/lib/rooms/service.ts`) סינן `res.status = 'confirmed'` בקשיח, ולכן כרטיס
החדר היה נשאר "פנוי" גם אחרי המיגרציה. עכשיו גם הוא שואל את הסט הקנוני.

### למה גם `checked_out` ו-`no_show`

הם לא ביטולים. הטווח הוא חצי-פתוח `[check_in, check_out)`, ולכן שהות שהסתיימה
מחזיקה רק את הלילות שבאמת נצרכו — תאריך העזיבה עצמו נשאר למכירה. אצל no-show
הלילה נשאר תפוס עד שאדם מבטל או מקצר, וזו בדיוק הפעולה שמתעדת **למה** החדר
השתחרר.

**ההשלכה התפעולית, במכוון:** לילה של no-show או של טיוטה נטושה לא משתחרר
מעצמו. למכור אותו מחדש = לבטל או לקצר קודם. אין תפוגה אוטומטית לטיוטות במערכת,
כך שטיוטה שנשכחה מחזיקה חדר עד שנוגעים בה.

### הסיכון שנבדק לפני, ולא אחרי

הרחבת סט החוסמים מרחיבה את ה-EXCLUDE constraint. אם שתי שהויות שחוסמות-מעכשיו
כבר חופפות על אותו חדר, ה-backfill של `is_blocking` נופל. נמדד על נתוני
הפרודקשן לפני כתיבת המיגרציה: **אפס חפיפות**, ובסך הכול טיוטה אחת בכל ה-DB (אין
בכלל שורות `checked_out`/`no_show`). המיגרציה לא סומכת על המדידה הזאת — שלב 2
שלה מוכיח את זה מחדש ונופל עם רשימה קריאה של הזוגות המתנגשים במקום
`exclusion_violation` עירום.

### מה שקל לפספס: הערוצים לא לומדים על שינוי כלל

שינוי הפונקציה משנה מה `room_type_inventory()` מחזירה, אבל Beds24 מקבל עדכון רק
כשקיים `channel_dirty_ranges`. בלי זה, שהות שחוסמת מקומית הייתה ממשיכה להימכר
כזמינה ב-OTA — כלומר בדיוק ה-double booking שההחלטה באה למנוע, רק עם מסך ירוק.
שלב 4 של המיגרציה מסמן טווח `availability` לכל (חיבור פעיל × חדר) של כל שהות
שחוסמת רק בזכות D126, חתוך לאופק ה-ARI (720). לא נדרשת הצבת job:
`ensureDrainJobs()` בוורקר מייצר אותו ברגע שיש טווח ממתין.

### שומרים

`check:calendar` מקבע ש-`draft`/`checked_out`/`no_show` בסט החוסמים ושהוא זהה
ל-`CALENDAR_VISIBLE_STATUSES` — "מה שמצויר, מוחזק". `check:inventory` מאמת שוב
מול ה-DB החי שהעותק ב-TS שווה לפונקציה ב-SQL.

---

## D127 — האינווריאנט של D68 הוא ברמת המסלול, לא ברמת הקובץ (2026-08-03)

**מה היה אדום.** `check:calendar` נכשל על main מ-`3e9a451` (24/07/2026) עד
הקומיט הזה — עשרה ימים. הקומיט הירוק האחרון היה `0d5cb2b`, ההורה של אותו
`3e9a451`. האסרשן:

> `src/app/(dashboard)/reservations/actions.ts must not import the channel HTTP layer (@/lib/channel/beds24-http)`

**זה לא היה false positive.** `beds24Request` יובא כערך ונקרא בפועל בזמן ריצה
(`actions.ts:993`), בקריאת רשת חיה ל-`GET /bookings`. גם `asObj` מ-`channel-http`
יובא ונקרא. השומר תיאר נכון את מה שהיה שם.

**הפגם האמיתי הוא בהתאמת היחידות.** האינווריאנט של D68 הוא ברמת **המסלול**: שום
**canonical save** לא יגיע לרשת — ARI יוצא נובע מה-outbox ונמסר ע"י וורקר ה-PM2,
לעולם לא מבקשה שכותבת הזמנה. היחידה של השומר היא ברמת **הקובץ**: `SAVE_PATHS`
מונה את `actions.ts` כמכלול.

`releaseChannelReservationAction` (שכבה 3 של D93 — פתח המילוט המפוקח) אינה
canonical save: היא לא כותבת הזמנה, לא משנה סטטוס ולא דוחפת ARI. היא מבצעת GET
**קריאה-בלבד** שמכריח את Beds24 לאשר את הביטול במקור, ואז מוסרת את השחרור
למשיכה הממוקדת הקנונית. היא שער, לא שמירה. היא פשוט ישבה בקובץ הלא נכון.

**התיקון: העתקה, לא שכתוב.** הפונקציה — ורק היא — עברה ל-
`src/app/(dashboard)/reservations/channel-release-actions.ts`, לצד
`card-actions.ts` ו-`message-actions.ts` שכבר מפצלים את פעולות ההזמנות באותה
תיקייה. אותה הרשאה, אותו audit, אותו `pull_booking_revisions`. חמישה ייבואים
עברו איתה (`beds24Request`, `asObj`, `getBeds24AccessToken`, `beds24BaseUrl`,
`beds24BookingIdentity`) ועוד אחד שנמצא בשימושה הבלעדי (`blocksAutomaticRelease`);
כל השאר נשארו כי הם משותפים.

**מה שבמכוון לא נעשה:** לא הוחלש השומר. `beds24-http` ו-`channel-http` נשארים
ב-`HTTP_MODULES`, אין רשימת חריגים, ואף קובץ לא מדולג. המודול החדש **לא** נוסף
ל-`SAVE_PATHS` — הוא אינו מסלול שמירה, והוספתו הייתה משחזרת את הכשל.

### השומר היה עיוור לממצא השני

`assert` נעצר על הכשל הראשון. כל עוד `actions.ts` ייבא את `beds24-http`, ההפרה
השנייה **באותו קובץ** (`channel-http`) הייתה בלתי נראית לחלוטין. שומר שנעצר על
ממצא אחד יכול לומר "משהו שבור" אבל לעולם לא "שום דבר אחר לא שבור" — וזו השאלה
היחידה שאפשר לעבוד מולה כשיש בסיס אדום.

הבלוק אוסף עכשיו את **כל** ההפרות בכל הקבצים ונכשל פעם אחת בסוף עם כולן ברשימה.
אותם כללים, אותה חומרה, אותם regexes — רק הדיווח השתנה.

### הוכחה שהשומר עדיין נושך (B2)

שומר הוא שומר רק אם הוא נכשל כשמנטרלים את מה שהוא מגן עליו. שתי הזרקות, שתיהן
בוטלו ולא נכנסו לקומיט:

- החזרת הייבוא `beds24-http` ל-`actions.ts` **עם קריאה אמיתית** →
  `1 violation(s)`.
- הוספת הפרה שנייה בקובץ `SAVE_PATHS` אחר (`calendar/actions.ts`) →
  `2 violation(s)`, **שתיהן** ברשימה. השומר הישן היה מדווח על אחת בלבד.
## D128 — מכנה התפוסה הוא `status='available' AND is_active`, זמנית — והסכימה לא יודעת מה יחידה להשכרה (2026-08-02)

**הקשר.** כרטיס ה-KPI "תפוסה הלילה" צריך מכנה. הבחירה הנוחה היא
`rooms.is_active`, והיא נותנת 15 מתוך 16 בפרודקשן — המספר הנכון. הסעיף הזה
קובע שהיא בכל זאת לא ההגדרה, ומתעד למה.

### `is_active` הוא מתג תצוגה, לא הגדרה של יחידה מושכרת

היחידה היחידה שמסומנת `is_active = false` היום היא **חדר 2000, "חניה זמנית"**.
היא מחוץ למכנה כי מישהו כיבה לה את המתג — לא כי הסכימה יודעת שחניה אינה דירה.
חדר שיכובה לשיפוץ או לעונה ייצא מהמכנה באותה הדרך בדיוק, **וינפח את אחוז
התפוסה** (מכנה קטן יותר, אותו מונה). זה כשל שקט: המספר יעלה דווקא כשפחות
יחידות עומדות למכירה.

### ההחלטה

המכנה הוא **`status = 'available' AND is_active`**. בנתוני היום שתי ההגדרות
נותנות 15, ולכן זה לא טיעון על מספר אלא על איזו הגדרה נכתבת:

1. **זו כבר ההגדרה הקנונית, והיא מהודרת ב-DB.** `guesthub.room_type_inventory`
   מגדירה `sellable_rooms = count(*) FILTER (WHERE status='available' AND
   is_active)`, ואותו פרדיקט בדיוק יושב ב-`available-rooms.ts` וב-`rates/rules.ts`.
   המכנה של ה-KPI הוא לכן **אותה קבוצת חדרים שמנוע ההזמנות באמת מוכר**.
   `is_active` לבדו היה הגדרה רביעית, סוטה.
2. **היא מבטאת יותר.** היא מפילה גם `out_of_order` וגם `inactive` — מצבים
   שה-CHECK של `rooms.status` יודע לבטא ושהמפעיל עשוי להתחיל להשתמש בהם בכל
   רגע, בלי שורת קוד נוספת ב-KPI. (היום כל 16 השורות הן `'available'`.)
3. **סגירה זמנית נשארת במכנה, וזה הכיוון הישר.** שיפוץ שנרשם דרך
   `room_closures(kind='ooo')` נופל ל-`closed_rooms` ו**אינו** יוצא
   מ-`sellable_rooms` — כלומר מוריד את אחוז התפוסה במקום לנפח אותו. זה
   המנגנון הנכון לכיבוי זמני, והוא ריק מרשומות היום.

**מסומן זמני** בהערת קוד באתר החישוב. שאר המועמדים נבדקו ונפסלו: `sellable_units`
מסמנת את כל 16 היחידות `is_active = true` — כולל החניה, כלומר גרועה מ-`rooms`;
`show_on_website`/`show_on_calendar` הם מתגי תצוגה ומוציאים גם את 1006 ו-1042,
שתי דירות אמיתיות; ו-`room_type_id` של החניה הוא **"חדר שינה וסלון"** — טיפוס
של דירה.

### שני פערים נרשמים כאן ואינם מתוקנים

- **הסכימה אינה מבדילה יחידה שאינה להשכרה מדירה.** אין עמודת category/kind/class
  על `rooms`, `room_types`, `sellable_units` או `areas`, ו-`lookup_items` מחזיקה
  רק מצבים תפעוליים (`room_statuses`: פנוי/לא פעיל/מושבת/בתחזוקה) ולא סוגי יחידה.
  התשובה היא **`rooms.unit_kind` בשלב מאוחר יותר** — לא מכנה שגוי עכשיו. חדר 2000
  מוחרג היום אך ורק כי אדם הפך את `is_active`.
- **`room_type_inventory` סופרת רק חדרים עם `room_type_id IS NOT NULL`.** חדר
  שיישמר בלי טיפוס ייעלם מהמכנה בשקט. **אפס שורות כאלה היום** — כל 16 היחידות
  מקושרות לטיפוס.

### תת-השורה אומרת מה נספר

`מתוך N יחידות`, כש-N הוא המכנה שנבחר — **מחושב, לעולם לא קבוע בקוד**. הכיתוב
הגנרי שהיה בשלד פאזה 1 ("מתוך יחידות פעילות") לא אומר למפעיל מה נספר, וזו בדיוק
המידה שמבדילה בין 15 ל-16.

---

## D129 — ‏Beds24 reviews: `propertyId` **וגם** `from` נדרשים, ושגיאה 3000 לעולם לא אומרת מה חסר (2026-08-03)

`GET /channels/booking/reviews` דורש **שני** פרמטרים: `propertyId` (integer)
ו-`from` (date). שניהם חובה. חוסר של כל אחד מהם מוחזר כ-`code 3000 "Invalid
data"` — תשובה גנרית שאינה נוקבת בשם הפרמטר החסר, ולכן קריאה שנכשלת נראית
בדיוק כמו קריאה עם ערך שגוי.

המשמעות המעשית: אי אפשר לגלות את החוזה הזה מניסוי-וטעייה מול ה-API, כי כל
הניסיונות מחזירים את אותה שגיאה. הספסיפיקציה ציבורית ב-
https://beds24.com/api/v2/apiV2.yaml והיא המקור היחיד שנוקב בדרישות.

## D130 — מפתח הצירוף של reviews שונה מזה של messages, ומי שיעתיק מאחד לשני יקבל אפס שורות בשקט (2026-08-03)

זו אזהרה, לא תכונה. שני משטחי ה-Beds24 שנראים אחים מצטרפים ל-`reservations`
דרך **עמודות שונות**:

| משטח | עמודת הצירוף |
|------|--------------|
| messages | `reservations.external_booking_id` |
| reviews | `reservations.ota_reservation_code` |

פיצ'ר reviews שייכתב באנלוגיה ל-messages — וזו האנלוגיה הטבעית, הם יושבים באותו
ספק ובאותו מסך — יתאים **אפס שורות**. הכשל שקט: אין שגיאה, אין חריגה, פשוט טבלה
ריקה שנראית כמו "אין ביקורות עדיין".

נגזרת מחייבת לכל טבלת reviews עתידית: **הקישור להזמנה חייב להיות NULL-able.**
מתוך 24 הביקורות החיות, ל-21 אין הזמנה מקומית כלל. סכימה שתדרוש קישור תזרוק את
רוב הנתונים או תיכשל בייבוא.

## D131 — אי אפשר לכתוב תגובה לביקורת Booking.com דרך Beds24; תיבת התגובה יורדת מהעיצוב לצמיתות (2026-08-03)

השדה `reply` הוא **קריאה בלבד** ב-API של Beds24, ו-`null` בכל 24 הביקורות החיות.
אין נתיב כתיבה — לא ב-endpoint של הביקורות ולא באף endpoint אחר.

לכן תיבת "השב לביקורת" מוסרת מהעיצוב לצמיתות, ולא נדחית לשלב מאוחר יותר: פקד
שאין מאחוריו נתיב כתיבה הוא הבטחה למפעיל שהמערכת לא יכולה לקיים. מי שירצה
להשיב — יעשה זאת בממשק של Booking.com.

סוגר את שאלה פתוחה 20 באודיט.

---

## D132 — צבע מקור הזמנה מגיע מ-`lookup_items.color`, ו-CHANNEL_CONFIG נשאר במקומו (2026-08-03)

**המקור הקנוני.** לכל משטח שממופתח לפי **מקור הזמנה** (`reservations.source_id`)
הצבע הוא `guesthub.lookup_items.color` של אותה שורה. זה השדה שהמפעיל עורך
ב-/settings, ולכן הוא היחיד שיכול להיות נכון.

**הנפילה, כי העמודה nullable.** מתוך שבע שורות `booking_sources` בפרודקשן,
ל-`website` אין צבע. פרוסת דונאט בלי צבע אינה בחירה עיצובית אלא חור. לכן
`sourceColor()` נופל לפלטת שמונה צבעי הערוצים ש-DeshbordMain.md §5.6 מקבע,
והיא יושבת ב-`src/lib/colors.ts` — אחד משני הקבצים היחידים שמותר להם להחזיק
ליטרל צבע. **אין ליטרל צבע בשום מקום אחר** במשטחים האלה.

**ההקצאה לפי `sort_order`, לא לפי מיקום בתוצאה.** מקור שומר את הצבע שלו בין
חודש לחודש ובין שני החלונות. אילו ההקצאה הייתה לפי אינדקס בתוצאה מסוננת, מקור
היה מחליף צבע ברגע שלמקור אחר אין הזמנות החודש — וסדרה שמחליפה צבעים אינה
ניתנת לקריאה.

**CHANNEL_CONFIG לא נגע, במכוון.** הוא ממופתח לפי `ota_name`/`booking_origin`
ומשרת את תג הערוץ ביומן — **מפתח אחר, משטח אחר**. איחוד שתי המפות דורש להחליט
מה קורה כשהמיפויים סותרים (הזמנה שמקורה `website` אבל הגיעה עם `ota_name`), וזו
החלטה מוצר שאין לה עדיין תשובה. שתי המפות מתקיימות במקביל ביודעין; האיחוד נדחה
ואינו חוב שקט.

---

## D133 — תוקף טוקן אינו אות בריאות; החיבור נמדד בשישה תנאים, ואפס הוא המצב הרגיל (2026-08-03)

**הפרדיקט שהוסר.** אות הבריאות של Phase 2 היה:

```sql
access_token_expires_at IS NOT NULL AND access_token_expires_at <= now() + interval '24 hours'
```

**הוא היה אמיתי 100% מהזמן.** טוקן הגישה של Beds24 חי 24 שעות ומחודש מתחת
ל-5 דקות מפקיעתו (`TOKEN_REUSE_MARGIN_MS`, beds24-token.ts) — כלומר תוקפו נמצא
תמיד, בהגדרה, בתוך 24 השעות הבאות. זו לא התראה אלא קבוע. הוא ניפח את מונה
ההתראות של לוח המחוונים בפריט אחד בכל טעינה, מאז שנכתב.

`check-beds24-connection.mjs` כבר ידע את זה ומדפיס את תוקף הטוקן כ-*"informational
only — the resolver mints on demand, an expired cache is not a failure"*. לוח
המחוונים היה המשטח היחיד שלא ידע, כי **אף שומר לא כיסה את חלון ההתראות.**
הפגם התגלה ביד. `check:connection-health` הוא השומר שהיה תופס אותו.

**תוקף טוקן אינו אות בריאות בשום סף.** אין תנאי אחד מהשישה שקורא
`access_token_expires_at`. `api_key_expires_at` **לא נקראת אף היא** — היא של
Hospitable בלבד (ה-PAT שלהם הוא JWT שפג, מיגרציה 044), ועל שורת Beds24 היא NULL
לנצח. מי שיחווט אותה כאן יבנה מחדש את אותו שקר בעמודה אחרת.

**ששת התנאים** (‏`src/lib/channel/connection-health.ts`, מודול טהור חסר ייבוא):

| # | תנאי | חומרה |
|---|------|-------|
| 1 | `state` במצב כשל (`error`) | אדום |
| 2 | `circuit_open_until` בעתיד | אדום |
| 3 | `consecutive_failures > 0` | כתום |
| 4 | ‏refresh token חסר (`api_key_ciphertext IS NULL`) | אדום |
| 5 | אין משיכה שהצליחה מזה 15 דקות | כתום |
| 6 | `channel_worker_state.beat_at` בן יותר מ-90 שניות | אדום |

**אפס בר-השגה, ואפס הוא הנורמלי.** חיבור שאף תנאי לא חל עליו מדווח מערך ריק —
וזה מה שהחיבור החי בפרודקשן מדווח היום. זו האסרציה הראשונה בשומר, והיא בדיוק זו
שהפרדיקט הישן לעולם לא היה יכול לספק.

### גזירת הסף של תנאי 5, והעמודה שנפסלה

הסף הוא **15 דקות = 3 × `INBOUND_POLL_MINUTES`** (worker.ts:253-258 — *"Runs
inside the EXISTING worker loop — no second process, no cron"*, `INBOUND_POLL_MINUTES = 5`).
מחזור אחד שהוחמץ הוא רעש רגיל; שלושה רצופים הם דפוס. הסף של תנאי 6 הוא
**90 שניות** — לא מספר חדש אלא הקיים: `WORKER_STALE_SECONDS` ב-rates-sync.ts:23,
כלומר ‎4.5× הטיק בן 20 השניות. הגדרה שנייה ל"הוורקר נפל" הייתה מובטחת לסתור את
פאנל ה-/rates.

**`last_inbound_import_at` נפסלה — היא מאותה משפחת שגיאות כמו פרדיקט הטוקן.**
היא מתקדמת רק כאשר `summary.imported > 0` (beds24-booking-import.ts:599-603),
כלומר היא מודדת **מתי הזמנה השתנתה לאחרונה**, לא מתי משכנו לאחרונה. נכס שקט
שנמשך כל 5 דקות ולא מוצא שינוי לא נוגע בה במשך שעות. **נמדד על החיבור הבריא
בפרודקשן ב-2026-08-03:** משיכה מוצלחת אחרונה 19:57:48Z, `last_inbound_import_at`
= 18:21:27Z — **פער 96 דקות.** כל סף שנגזר מ-5 דקות היה מדליק התראה על חיבור
תקין לחלוטין. שוב: עמודה שנשמעת כמו בריאות ומודדת משהו אחר.

התנאי מכוון לכן ל-`max(finished_at)` על `channel_sync_jobs` עם
`job_type='pull_booking_revisions' AND status='succeeded'` — הזמן שבו המשיכה
עצמה הצליחה, ללא תלות במה שמצאה.

### שני דיכויים — סיבה אחת לעולם לא מדווחת פעמיים

- **6 מדכא את 5.** ורקר מת הוא *הסיבה* שלא נמשך דבר; שתי שורות היו שולחות את
  המפעיל לתקן סימפטום.
- **2 מדכא את 3.** המפסק נפתח אך ורק על ידי ספירת אותם כשלונות
  (`onCircuitFailure` תמיד מגדיל את `consecutiveFailures`), כך שהצמד מובטח
  מבנית. השורה החמורה מנצחת, וספירת הכשלונות נשארת בתוך שורת הפירוט שלה.

הדיכוי הוא **פר-סיבה, לא תקרה**: כשגם 1, 2, 4 ו-6 נכונים במקביל מדווחות ארבע
שורות נפרדות. השומר אוכף זאת.

### ההיקף עבר ל-`is_active_provider` בלבד

ההיקף הישן דרש גם `state = 'active'` — מה שהפך את תנאי 1 ל**בלתי-ניתן-להדלקה**:
שורה ב-`state='error'` לעולם לא הייתה נבחרת כדי שידווח עליה שהיא בשגיאה. בריפו
קיימות שתי משפחות היקף נבדלות, וההתראה השתמשה בלא-נכונה:

- **"מי החיבור"** — `provider='beds24' AND is_active_provider = true`.
  כך עושים channel-release-actions.ts:86, beds24-booking-import.ts:139,
  booking-com-reports-core.ts:242. זה ההיקף הנכון כאן.
- **"מותר לי לדחוף עכשיו"** — `state='active' AND outbound_sync_enabled AND NOT full_sync_required`
  (outbox.ts:48, rates-sync.ts:47-48, beds24-ari-sync.ts:870-871). שאלה אחרת,
  ולא זו שנשאלת בהתראה.

**חיבור `paused` אינו מתריע, במכוון.** השהיה היא החלטת מפעיל; התראה על מצב
שהמפעיל בחר בו היא נדנוד, לא איתות. `paused` מחוץ לרשימת מצבי הכשל, והשומר
אוכף זאת. שתי השורות הרדומות בפרודקשן (channex, hospitable) הן `paused` עם
`is_active_provider=false` — ההיקף מוציא אותן בלאו הכי.

**תנאי 3 אומר "הסנכרון היוצא", לא "החיבור".** `persistCircuit`
(beds24-ari-sync.ts:178-183) הוא הכותב **היחיד** של המונה בכל הריפו, והוא רץ
בניקוז ה-ARI היוצא. כשל של המשיכה הנכנסת לעולם לא נוגע בו. תווית שהייתה אומרת
"החיבור" הייתה מייחסת לזרימה הנכנסת תקלה שאינה שלה.

### מיגרציה 075 — אינדקס, לא שינוי נתונים

בדיקת החיוּת של תנאי 5 היא שאילתה במסלול הקריטי של לוח המחוונים.
ל-`channel_sync_jobs` לא היה אינדקס שמשרת אותה: **נמדד בפרודקשן — Seq Scan על
49,370 שורות, 11.0ms**, והטבלה גדלה ללא הגבלה (המשיכה לבדה מוסיפה ~288 שורות
ביום, ושום דבר לא גוזם). `idx_jobs_pull_liveness` הוא אינדקס חלקי על
`status='succeeded'`. אדיטיבי, אידמפוטנטי, בלי שינוי נתונים.

---

## D134 — הבייסליין הכן של הסוויטה הוא 67/24, ושלושה ערוצי זיהום ייצרו את ההפרש (2026-08-03)

**הדוח המלא:** [`docs/audit/AUDIT-SUITE-ISOLATION.md`](docs/audit/AUDIT-SUITE-ISOLATION.md).
שמונה התיקונים המדורגים יושבים שם, לא כאן. הרשומה הזו קובעת מה נמדד ומה עדיין לא ידוע.

### הבייסליין

**67 עוברים / 24 נכשלים מתוך 91** — סכמה טרייה לכל שומר, כל שומר נשאל את שאלתו
ממצב פתיחה זהה וידוע. זה המספר היחיד שאינו תלוי בסביבה.

הספירות הגולמיות **58/33** (מבודד) ו-**60/31** (מסודר) היו **ארטיפקטים של מדידה,
לא רגרסיות**. אותו commit, אותה מכונה, אותה דקה, נותן 67 עד 71 ירוקים תלוי אך ורק
בסדר ובסביבה. מי שמדווח "69/22 ירוק" מדווח על עץ חם ומסודר, לא על הקוד.

### שלושת ערוצי הזיהום

1. **הסביבה.** תשעה שומרים יוצאים `exit 2` עם `need CHECK_*_DB_URL` ו**אינם רצים
   כלל** אם ה-shell המפעיל לא ייצא את המשתנה. ספירה נאיבית קוראת זאת כתשעה
   כשלונות. עם ה-env שהם מבקשים — **9/9 עוברים**. שם המשתנה הוא הממצא; הערך לא
   נכנס לתיעוד.
2. **פסולת סכמה בין שומרים.** `check:beds24-maxstay-no-limit` — שנכשל בכל סדר —
   משאיר 12 טבלאות מאוכלסות, והוא **ספק שורת ה-`tenants` היחיד בסוויטה**. אותה
   פסולת מייצרת **גם false PASS וגם false FAIL**: `check:rate-grid`,
   `check:inventory` ו-`check:sellability` קורסים ב-`TypeError` בלי tenant ולכן
   "עוברים" רק בזכותו, בעוד `check:beds24-ari` **נכשל** כי הוא קורא את
   `channel_dirty_ranges` שאותו שומר השאיר.
3. **סדר.** הכלל שנמדד: *עובר אם ורק אם הספק רץ קודם ואף מנגב-סכמה לא רץ ביניהם.*
   הוא מנבא נכונה את **כל 12 התאים** שזזו בין שלושת הסדרים.

### `scripts/db/migrate.mjs` — הכלי שבור, השרשרת בריאה

ה-replay-from-zero מת מאז **2026-07-29** (מיגרציה 064), בשתי תקלות **בלתי תלויות**:
`075_sync_jobs_finished_index.sql` קיים על הדיסק וחסר מ-`manifest.txt` (ABORT לפני
חיבור ל-DB); ומתחתיה — הכלי מאתחל `schema_migrations(version, checksum, …)` בעוד
064 מגדירה `(filename, …)`, ו-`IF NOT EXISTS` נותן לכלי לנצח בשקט.

**נתיב הדפלוי אינו מושפע.** `apply-pending-migrations.mjs` מדבר `filename` ולכן
הלדג'ר בפרודקשן שלם — **77/77**. יתרה מזו, replay ידני מאפס משחזר את סכמת
הפרודקשן **במדויק**: `diff` ריק על רשימת הטבלאות ו-`diff` ריק על רשימת העמודות
המלאה. שרשרת המיגרציות בריאה; רק הכלי שהולך עליה שבור.

**המשמעות לרשומות קודמות:** אף ריצת סוויטה מאז 064 לא רצה על סכמה משוחזרת-מאפס,
כולל זו שדווחה ל-D133. מה שאותן ריצות הוכיחו — את זה הן לא הוכיחו.

### מה מכוון **לא** נבדק

**22 הכישלונות היציבים אינם ארטיפקט סדר.** אותו ורדיקט לבד ובכל שלושת הסדרים.
האם כל אחד מהם באג מוצר, פיקסצ'ר מיושן או פער סביבה (דפדפן headless, רשת, סוד
חסר) — **UNKNOWN**, ומחוץ להיקף במכוון. זו עבודה נפרדת, ואסור להציג את המספר
הזה כרשימת באגים.

### הראיות הגולמיות אינן בריפו

ה-JSON, ההרנס וקבצי ה-diff יושבים **מקומית בלבד** ב-
`ref/audit/suite-isolation-2026-08-03/`. `ref/` ב-`.gitignore` לפי כלל D87 (הריפו
ציבורי), ולכן החומר **אינו ניתן לשחזור מ-git** ולא ישרוד בניית מארח מחדש. לכן כל
מספר שהדוח טוען נכתב בתוכו inline — הדוח עומד בפני עצמו בלי הראיות.

## D135 — שורת הערוץ בכרטיס ההזמנה אינה מותנית, ומפריד החודש הוא קישוט בלבד (2026-08-04)

**מה היה אדום.** `check:calendar-ui` נכשל על main מ-`2ab6ae1` (21/07/2026) —
ארבעה־עשר יום. **שתי** אסרשנים, לא אחת: `assert` נעצר על הראשונה, ולכן השנייה
מעולם לא דווחה. אותה עיוורון בדיוק שתוקן ב-`check-calendar.mjs` תחת D127, בקובץ
שכן.

**הקוד נכון; השומר תיאר מפרט שהוחלף.** בשני המקרים המימוש שונה בכוונה מול
הרפרנס של הבעלים, נבדק והתקבל — והשומר לא עודכן איתו. הסעיף הזה קובע את
האינווריאנטים הנוכחיים, כדי שהאדום הבא יתאר משהו שבאמת נשבר.

### 1. שורת הערוץ אינה מותנית

`resolveChannelBadge()` מחזירה `BadgeChannel` ו**לעולם לא `null`**
(`normalizeVisibleChannel(sourceKey) ?? "manual"`). מקור פנימי — טלפון,
walk-in, לא ידוע, `NULL` — נופל ל-`manual` ומקבל את תג העיפרון. לכן **כל הזמנה
מקבלת שורת ערוץ**, ו-`CHANNEL_CONFIG[channel].name` תמיד נפתר.

התנאי הישן `{channel && (…)}` **מוחלף**. הוא היה נחוץ כשהנרמול החזיר `null`;
היום הוא תחביר מת — הביטוי אמיתי תמיד. הסיכון שהוא נועד למנוע (שורה ריקה או
רווח בגוף הכרטיס) **אינו ניתן להשגה מבנית**, ולא בזכות התנאי.

גוף הכרטיס נשאר ארבע שורות: תאריכים · לילות+חדר+סטטוס · ערוץ · כסף. זה לא
השתנה.

### 2. `.cb-msep` הוא קו שיער של 0.5px ‏#8e9ab8

הערך נקבע ב-`1268d29` (21/07/2026) מול רפרנס הבעלים, במקום קו 3px שטוף. זהו
**הערך המאושר והקבוע**. הוא נושא `ds-allow:` כי הוא ערך רפרנס מפורש, לא סטייה.

### 3. המפריד הוא ויזואלי בלבד — אין לו שום משמעות טכנית

`.cb-msep` הוא **אפורדנס UX ותו לא**: הוא מאפשר למשתמש לראות איפה חודש אחד
נגמר והבא מתחיל. אין לו משמעות טכנית, לוגית או עסקית.

הוא **אינו** משתתף בזמינות, במלאי, בחישובי תאריכים, בגבולות הזמנה או בשום
לוגיקה של הלוח. **אסור לשום קוד לגזור ממנו התנהגות** — לא מיקומו, לא רוחבו,
לא קיומו. הוא דקורציה. חישוב חודשים אמיתי מגיע מ-`dates.ts` ומ-
`sellable_unit_inventory()`, לעולם לא מקו שמצויר על המסך.

### 4. מה כן נאכף — המבנה

האינווריאנט המבני נשאר בתוקף מלא, והוא זה שהשומר קיים בשבילו:

- `.cb-msep` הוא `position: absolute` — **צומת ממוקם יחיד**, לעולם לא בורדר של
  תא או של סגמנט.
- הוא תלוי מגבול העמודה הקנוני: `var(--cb-room-col)` +
  `var(--cb-sep)`.
- אותה מחלקה משרתת את הכותרת ואת הגוף (`.cb-chead .cb-msep`,
  `.cb-cbody .cb-msep`), ו-`CalendarGrid.tsx` מרנדר את **אותם** צמתים פעמיים
  (`{monthSeparators}`).

שלושת הקווים הישנים סיזרו את הקופסאות שלהם אחרת (רצועת חודש באחוזים מול תאים
של `flex: 1 1 0` שהבורדר שלהם יושב מחוץ לבסיס האפס), ולכן הקו בכותרת נחת ~3px
מהקו בגוף. זה מה שנשבר אז, וזה מה שנאכף.

### 5. השומר אוסף עכשיו את כל ההפרות

`scripts/check-calendar-ui.mjs` עבר לתבנית של D127: כל האסרשנים נאספים
ונכשלים פעם אחת בסוף עם הרשימה המלאה. אותם כללים, אותה חומרה, אותם regexes —
רק הדיווח השתנה. שומר שנעצר על ממצא אחד יכול לומר "משהו שבור" אבל לעולם לא
"שום דבר אחר לא שבור".

אסרשן הרוחב **לא נמחק** — הוא הופרד. מבנה ורוחב הם שתי טענות שונות, ואסור
שערך קוסמטי מאושר ייפול באותה שורה עם האינווריאנט המבני.

### פגם ידוע בפנקס: מספרי D מתנגשים

מספרי ה-D המצוטטים בהודעות הקומיט של הלוח **אינם** מפנים לרשומות האלה בפנקס:

| מצוטט בקומיט | מה כתוב בפועל תחת אותו מספר |
|---|---|
| `D87` (‏`3a9da97`) | Reservation-card UX: holder auto-fill, CVV restored |
| `D88` (‏`3d6ace9`) | לוח שיבוץ drag-and-drop ל-/housekeeping + /tasks |
| `D88.1` (‏`e4f4948`) | לוחות מתוחמים לפי תפקיד; /tasks הוסר |
| `D107` (‏`2ab6ae1`) | מטבע להזמנה: `enabled_currencies` (26/07 — **חמישה ימים אחרי** הקומיט) |
| `D107.1` (‏`1268d29`) | **לא קיים בריפו כלל** |

זה נרשם כאן כ**פגם ידוע**, לא כהפניה. אין להסתמך על מספרי D בהודעות קומיט של
הלוח, ואין לפתור אותם מול הפנקס — הם תוויות יתומות. האינווריאנטים של הלוח
מתועדים בסעיף הזה ובהערות של `check-calendar-ui.mjs`; מקור האמת העיצובי הוא
`GUIDELINES.md` ותמונות הרפרנס של הבעלים.

## D136 — ‏`manifest.txt` הוא מכונן, וצורת הלדג'ר היא של 064 (2026-08-04)

**זו הרשומה המכוננת הראשונה של `manifest.txt`.** עד היום הקובץ הוזכר בפנקס
פעמיים בלבד, שתיהן אגביות: ב-D122 — רשומה על TTLock — כשורה בטבלת השוואה בין
שני המריצים ובמשפט חולף שהוא "מקור האמת היחיד", וב-D134 כתסמין שבור. הוא נולד
ב-2026-07-18 תחת תווית הפגם `H5` של שלב 2, ותועד ב-`docs/program/` בלבד. קובץ
שמחזיק את סדר ההחלה של הסכימה ואין לו רשומה בפנקס הוא קובץ שאיש לא מחויב לו.
זה נסגר כאן.

### 1. ‏`manifest.txt` הוא מקור האמת היחיד לסדר ההחלה ב-replay

`db/migrations/manifest.txt` — שם קובץ אחד בשורה, **בסדר החלה**, שורות ריקות
ו-`#` מתעלמים. ‏`scripts/db/migrate.mjs` קורא ממנו את הסדר ואוכף התאמה
דו-כיוונית מול התיקייה: מה שרשום חייב להיות על הדיסק, ומה שעל הדיסק חייב להיות
רשום. **ספריית קבצים אינה תחליף** — היא לא יכולה לבטא את הסדר האמיתי כשקיים
קידומת כפולה.

### 2. צורת הלדג'ר היא של 064: `filename, applied_at`

`guesthub.schema_migrations` שייכת למיגרציה `064_schema_migrations.sql`, והיא
מגדירה בדיוק:

```sql
CREATE TABLE IF NOT EXISTS guesthub.schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

`migrate.mjs` היה מאתחל לעצמו טבלה בצורה אחרת —
`(version, checksum, applied_at, applied_by)`. מכיוון ש**שני** הצדדים משתמשים
ב-`CREATE TABLE IF NOT EXISTS`, המריץ ניצח בשקט בשחזור-מאפס: הוא יצר את הטבלה
שלו ראשון, ה-`CREATE` של 064 הפך ל-no-op, ואז `INSERT ... (filename)` של 064
פגע בעמודה שלא קיימת. אף אחד לא ראה כשל DDL — רק כשל INSERT עמוק בשרשרת.

**ההכרעה: הסכימה היא הרשומה; המריץ מתאים את עצמו אליה, לעולם לא ההפך.** ה-DDL
של המריץ זהה עכשיו לזה של 064, ולכן ה-`CREATE TABLE IF NOT EXISTS` של 064 הוא
no-op אמיתי מול צורה זהה. לוגיקת ה-checksum הוסרה **במלואה** — לא עמודה מתה,
לא stub שמקבל NULL. שום קוד אחר בריפו לא קרא את `schema_migrations.checksum`
(‏`validate-copy.mjs` מתעלם מהטבלה במפורש), ולכן להסרה אין צרכן.

`ON CONFLICT (filename) DO NOTHING` בנתיב ההחלה **נושא משקל**: 064 ממלאה את
הלדג'ר וכוללת את **שם הקובץ של עצמה**, ולכן בשחזור-מאפס השורה כבר קיימת כשהמריץ
מוסיף אותה. `INSERT` חשוף היה מפיל את כל הטרנזקציה של 064.

### 3. מיגרציה ושורת המניפסט שלה חיות באותו קומיט — ועכשיו זה נאכף

הכלל: **מי שמוסיף `db/migrations/*.sql` מוסיף את שורתו ל-`manifest.txt` באותו
קומיט.** המוסכמה נכשלה שלוש פעמים מאז שהקובץ נולד:

| מיגרציה | נוספה ב- | השורה נוספה ב- |
|---|---|---|
| `041_operational_tasks.sql` | `2eb1c1b` (18/07) | `f4397f0` — קומיט השלמה נפרד, אותו יום |
| `061_communication_triggers.sql` | `0cb3030` (27/07) | `3ee513b` — קומיט השלמה נפרד, אותו יום |
| `075_sync_jobs_finished_index.sql` | `4d59eaa` (03/08) | **מעולם לא** — עד הרשומה הזו |

שום דבר לא תפס את זה, כי אין מה שיתפוס: **אין CI** (‏`.github/workflows/` לא
קיים), ‏`deploy:prod` לא פותח את המניפסט כלל (‏`apply-pending-migrations.mjs`
סורק את התיקייה), וארבעת השומרים שכן קוראים אותו (055, 056, 058, 068) בודקים
כל אחד **רק את המיגרציה של עצמו**. מיגרציה חסרה עוברת typecheck, lint, build,
כל השומרים, שומר הדפלוי והדפלוי עצמו — כפי ש-075 עשתה, עד לפרודקשן.

`check:migration-manifest` סוגר את זה: התאמה דו-כיוונית + כפילויות, אוסף את
**כל** ההפרות ונכשל פעם אחת בסוף (D127).

### 4. פיצול ה-009 מכוון — אסור "לתקן" אותו לקסיקוגרפית

`009_phase4a_sellable_units.sql` בא **לפני** `009_phase4_card_channel.sql`.
זה סדר הבנייה האמיתי (04/07 ואז 05/07) והוא הפוך מסדר לקסיקוגרפי, כי `_`
(0x5F) קטן מ-`a` (0x61). **זו הסיבה שהמניפסט קיים.** מי שימיין את הקובץ
בכלי — יהפוך את הזוג ויאבד את הידע שהקובץ נוצר כדי לשמר.

**סיכון פתוח, מדווח ולא מתוקן:** שני המריצים חלוקים על 009. `migrate.mjs` הולך
לפי המניפסט; `apply-pending-migrations.mjs` הולך לפי `readdirSync().sort()`.
היום זה אינרטי — שתי המיגרציות הוחלו מזמן ומולאו ע"י 064 — אבל הפער חי בקוד.
זוג קידומות כפול **עתידי** יוחל בסדר אחד בשחזור ובסדר ההפוך בפרודקשן, בשקט,
בלי ששום שומר יאמר מילה. לא נבחרה כאן הכרעה; זה נרשם כדי שההכרעה תתקבל בעיניים
פקוחות.

### 5. ממצא לרשומה: אף ריצת שומרים מאז 064 לא רצה על סכימה משוחזרת-מאפס

מ-2026-07-29 (מיגרציה 064) ועד הרשומה הזו, שחזור-מאפס לא היה ניתן להרצה כלל:
המריץ עצר ב-`ABORT` על 075 לפני חיבור ל-DB, ומתחת לזה חיכתה התנגשות הצורה של
הלדג'ר. **המשמעות: כל הנחת כיסוי של שומר מאז 2026-07-29 אינה מאומתת** — כולל
הריצות שדווחו ל-D133 ול-D134. הן רצו על סכימה שנצברה, לא על סכימה שנבנתה מחדש.
שרשרת המיגרציות עצמה בריאה (D134 מדד: `diff` ריק על טבלאות ועל עמודות), ונתיב
הפרודקשן מעולם לא נפגע — הפגם היה בכלי, לא בשרשרת. מה שהריצות האלה הוכיחו,
הוכיחו; מה שהן **לא** הוכיחו הוא שהן רצו על בסיס נקי.

## D137 — שומר עוקב אחרי הכרעה, לא מקפיא אותה: חמשת האדומים שמדדו מפרט שהוחלף (2026-08-04)

הרתמה הנקייה (D134, בייסליין 74/17/1) סיווגה חמישה אדומים כפגמי-שומר: הקוד
צודק, והאסרשן דורש עולם שכבר הוכרע אחרת. כולם תוקנו כתיקוני שומר בלבד — אפס
שינויי `src/`, אפס `.sql` — וכל תיקון נבחן בנשיכה לפני שנחשב גמור: העתק
scratch הוריק כבסיס, האינווריאנט נוטרל בכוונה, והשומר נכשל בקול עם כל ההפרות
(collect-all), לא רק הראשונה.

### מה הכריע כל תיקון

- **check:channels-badge** — שבעת הכשלים אכפו את המפרט שקדם ל-D107/D135:
  "בדיוק ארבעה ערוצים, אין manual, אין badge להזמנה פנימית". ההכרעה התקפה:
  **כל** הזמנה עונדת badge — ערוץ חיצוני או עיפרון manual (`#E6E9F0`,
  "הזמנה ידנית"); `ChannelBadge` מקבל `BadgeChannel`; שורת הערוץ בפופאובר
  אינה מותנית (D135). מה שנשמר במפורש: **המקרא הוא בדיוק ארבעת החיצוניים —
  manual לעולם אינו ערוץ מקרא** (`CHANNEL_ORDER`), והצגת manual חיה אך ורק
  בקובץ הטוקנים `colors.ts`.
- **check:channel-security** — גרף את `channel-http.ts` על הדר `user-api-key`
  של Channex, ספק שהוסר ב-D91; הקובץ כבר אינו שולח שום בקשה, ולכן גם בדיקת
  "לעולם לא ב-URL" הוריקה על ריק (vacuous green). כעת השומר סורק את
  `beds24-http.ts` — הקובץ שמנפיק בקשות בפועל: הטוקן בהדר `token`, מסלולי
  ה-authentication בהדר ייעודי (`code`/`refreshToken`), וה-URL היחיד שנבנה
  הוא `baseUrl+path` חשוף — קרדנציאל ב-query נתפס, והפעם על קובץ חי.
- **check:housekeeping** — המתאמים הסטטיים חיפשו את לוגיקת checkout→משימה
  ב-`reservations/actions.ts`, שממנה הוצאה אל `lifecycle.ts` — הגוף האחד
  ששני ה-actions (פאנל ודשבורד) מריצים. המתאמים הוסבו לקובץ הנכון; אסרשן
  האידמפוטנטיות (`WHERE NOT EXISTS`) נשמר כלשונו, וההוכחה הרצה ב-DB באותו
  שומר לא השתנתה — החצי הסטטי יושר עם מה שהחצי הרץ כבר הוכיח.
- **check:cards** — דרש את המחרוזת המילולית `if (!provider) return null;`
  בעוד `gateway.ts` נכשל-סגור **ללא תנאי** — צורה חזקה יותר של אותה הכרעה
  (D46). האסרשן הוחלף בבדיקת **התנהגות מורצת**: השומר מקמפל את המודול ומריץ
  `getPaymentGateway()` — null כשאין ספק מוגדר, `paymentGatewayConfigured()`
  שקרי. גרפ של צורת מקור הוחלף בהוכחה בהרצה.
- **check:maintenance-closures** — פגם סנטינל, לא מפרט שהוחלף: השאילתה פלטה
  `COALESCE(skip::text,'f')` וההשוואה בדקה `=== "t"`, אבל ההטלה
  `boolean::text` ב-Postgres מרנדרת `'true'`/`'false'` — ענף ה-SKIP היה
  בלתי-נגיש, ודילוג מכוון דווח כ"אין תוצאה". ההשוואה תוקנה ל-`'true'`; מה
  שהמדד מודד, ומתי דילוג לגיטימי — ללא שינוי.

### העיקרון

שומר אוכף הכרעה; הוא אינו מקפיא את הרגע שבו נכתב. כשהכרעה מתחלפת (D91,
D107/D135, מעבר ה-lifecycle, שער נכשל-סגור), שומר שממשיך לאכוף את קודמתה
אינו "קפדן" — הוא מודד מפרט שהוחלף, והאדום שלו מלמד אפס על הקוד. תיקון כזה
הוא תיקון שומר, לעולם לא תיקון `src/`; ואם תיקון שומר נראה כדורש שינוי
`src/` — הטריאז' היה שגוי, עוצרים ומדווחים.

### אזהרת מחלקה: השוואות בוליאן-כטקסט

שני רינדורים שונים חיים זה לצד זה: בוליאן **חשוף** שנקרא דרך `psql -tA`
מודפס `'t'`/`'f'` (וההשוואות ל-`"t"` ב-check-reports, check-totals-parity
ודומיהם נכונות); ההטלה **`::text`** בתוך SQL מרנדרת `'true'`/`'false'`.
הפח הוא בערבוב: `::text` בשאילתה עם `'t'` ב-JS הוא ענף מת שאינו נכשל לעולם —
הוא פשוט לא קורה. הסריקה מצאה מופע שבור יחיד (השומר שתוקן כאן). סנטינל חדש —
להשוות מול `'true'`, או עדיף: לפלוט סנטינל מפורש (`'SKIP'`) שאינו תלוי
ברינדור בוליאני כלל.

## D138 — פיצול suite/liveness: הסוויטה מודדת קוד, liveness מודד את המערכת החיה (2026-08-04)

חמשת גשושי ה-Beds24 החיים חיו בתוך סוויטת ה-check:* ונמדדו שם מול clone
משוכפל-מאפס (D127): אין חיבור פעיל, אין משיכות, אין revisions — אדום נצחי
שאינו מלמד דבר על הקוד. אותו אדום בדיוק, נמדד מול פרודקשן, הוא אזעקה
אמיתית. ההפרדה מוסדה: **הסוויטה מודדת קוד; liveness מודד את המערכת החיה.**
אדום נצחי בתוך הסוויטה הוא רעש; אותו אדום מול פרודקשן הוא אזעקה.

### מה זז

- `check:beds24-connection`, `check:beds24-jobs`, `check:beds24-revisions`,
  `check:beds24-ari` ו-`check:beds24` (השרשרת) נקראים כעת `liveness:*`;
  קבצי הסקריפטים לא שונו. `beds24-ari` זז גם הוא למרות שהיה ירוק בסוויטה —
  ירוק-בריק (vacuously green): "שום טווח לא הוזהם ב-24h" מתקיים ריקם על
  clone ריק, כלומר הירוק שלו בסוויטה לא מדד דבר; מדידה אמיתית קיימת רק מול
  פרודקשן.
- run-checks.mjs לא נגע ברשימת המפתחות: הגילוי דינמי לפי קידומת `check:`,
  ולכן חמשת המפתחות נשרו מהסוויטה מאליהם עם השינוי היחיד בו — אספקת דגל
  השכבות ל-credit-headers (למטה).

### check:beds24-credit-headers — פיצול לשלוש שכבות

`CREDIT_HEADERS_TIERS` (ברירת מחדל `pure`; טוקן לא מוכר → סירוב קולני, exit 2):

- **pure** — ארבע רגלי הפרסינג מול סטאב מקומי. רץ בכל מקום.
- **db** — סבב כתיבה-קריאה דרך כותב/קורא הראיות האמיתיים בתוך טרנזקציה
  שמתגלגלת לאחור (רגל 6 לשעבר). סוויטה בלבד, מול ה-clone של השומר עצמו
  (זהות fixture — לטבלת הראיות אין הורי FK, מיגרציה 038). לעולם לא ב-liveness.
- **live** — קריאת GET ממוננת אחת מול Beds24 האמיתי (רגל 5 לשעבר), liveness
  בלבד. **פתרון הטוקן הוא cache-only**: הגשוש קורא את הטוקן שה-worker
  מתחזק ולעולם אינו טובע (mint) ואינו כותב. cache חסר/פג → אדום שקורא לפגם
  האמיתי בשמו — תחזוקת הטוקן של ה-worker אינה שומרת עליו טרי; בתוך חלון
  הרענון (5 דקות, זהה ל-resolver) → עובר עם אזהרה (ה-worker אולי באמצע
  רענון — לא אזעקה).

run-checks.mjs מספק `CREDIT_HEADERS_TIERS=pure,db` לשומר; המפתח החדש
`liveness:beds24-credit-headers` מספק `pure,live` לאותו סקריפט.

### העיקרון: גשוש liveness צופה — גשוש שמתקן מסווה את הכשל שהוא בא לגלות

resolver הטוקן (beds24-token.ts) מיישם "persist-then-return": כשה-cache פג
הוא טובע טוקן חדש (עולה קרדיט) וכותב UPDATE ל-channel_connections. נכון
ל-worker; אסור לגשוש. גשוש טובע-וכותב היה (א) כותב לפרודקשן מתוך בדיקה,
(ב) שורף קרדיט בכל ריצה, ו-(ג) **מרפא בשקט בדיוק את הפגם שהוא נועד לגלות**
— worker שהפסיק לתחזק את הטוקן לא היה מאדים לעולם, כי הגשוש היה משלים את
עבודתו במקומו. לכן cache פג הוא הממצא עצמו, לא תקלה לעקוף.

### B2 מוחלט: סשן ה-liveness הוא read-only, בלי חריגים

- `scripts/run-liveness.mjs` הוא ההיפוך המדויק של run-checks.mjs: הסוויטה
  **מסרבת** לסמני פרודקשן ב-DSN; liveness **דורש** אחד מהם. אין DSN
  ברירת-מחדל — `LIVENESS_DB_URL` מפורש בלבד.
- כל חיבור גשוש נפתח עם `default_transaction_read_only=on` ברמת ה-session
  (פרמטר startup על ה-DSN; `begin()` של postgres.js מנפיק BEGIN חשוף ולכן
  ברירת המחדל חלה גם בתוך טרנזקציות). כתיבה מתה בקול — "cannot execute … in
  a read-only transaction" (נמדד בנשיכה).
- **preflight נכשל-סגור**: הרץ פותח חיבור אמיתי ומוודא שה-GUC נחת לפני
  שגשוש אחד רץ. בריצה הראשונה מול פרודקשן זה תפס בפועל: פורט 5432 הוא
  Supavisor pooler שמשמיט פרמטרי startup (כמתועד ב-lib/db.ts לגבי
  search_path) — הרץ סירב. ה-DSN של liveness חייב להיות ה-backend הישיר
  (supabase-db), לא ה-pooler.
- רגל 6 (INSERT-ואז-rollback) שוכנה מחדש בסוויטה: תחת B2 היא הייתה אדום
  נצחי ב-liveness — בדיוק הרעש שהמהלך הזה בא לחסל. הרץ לעולם אינו מפעיל
  מחדש דבר: לא pm2, לא build, לא deploy.

### מדידות

- נשיכות (העתק scratch מחוץ לריפו, בסיס ירוק תחילה): רץ liveness מסרב ל-DSN
  חסר-סמן לפני כל גשוש (exit 2); הסוויטה עדיין מסרבת לסמן פרודקשן (רגרסיית
  ‎#162); כתיבה מוזרקת עוברת בסשן כתיב ומתה בקול תחת השער; מצב suite על
  clone-מאפס — exit 0 עם live מדולג; cache שפג → אדום מילולי ואפס יציאה
  החוצה (base URL הופנה לפורט מת — ניסיון יציאה היה נכשל אחרת, ולא נרשם
  כזה; עם cache תקף אותו פורט מת נתפס מיד); tier ה-db אינו רץ תחת מפתח
  ה-liveness.
- ריצה חיה יחידה (מאושרת): 6/6 ירוק, x-request-cost=1, remaining=97.8;
  הריצה נפלה בפועל בתוך חלון הרענון (205s לפקיעה) והתנהגה כמוכרע — אזהרה,
  לא אזעקה, בלי טביעה.
- סוויטה אחרי המהלך: 79 עובר / 7 נכשל / 1 cannot-run מתוך 87 — דיפ מלא
  שומר-אחר-שומר מול הבייסליין 79/12/1 (D137) מראה בדיוק שני הפרשים: חמשת
  המפתחות שזזו נעדרים (בבייסליין: 4 אדומים + ari ירוק-בריק), ו-credit-headers
  הפך fail→pass. שום שומר אחר לא זז. typecheck / lint / build ירוקים.
- ההכרעה המקורית של הפיצול הייתה סתירה פנימית — B2 (read-only מוחלט) יחד עם
  "רגליים חיות מלאות" שכוללות UPDATE committed של טביעת טוקן — וחוט-הנעילה
  של A1 ("כל כתיבה שנמצאה → עצור") תפס אותה לפני שנכתבה שורת קוד. ההכרעה
  תוקנה לגרסה המיושמת כאן.

## D139 — חלון החיובים מציג כל הזמנה שהגיע מועדה ואינה 'approved'; אין רשימת סטטוסים (2026-08-07)

ווידג'ט התזכורות (`pay`, "כרטיסי אשראי לחיוב") מציג **כל** הזמנה שהצ'ק-אין
שלה הגיע ואינה מסומנת `workflow_status.key = 'approved'`. אין רשימת סטטוסים
נכללים. כל סטטוס עתידי — קיים או שיתווסף — נכלל אוטומטית. `'approved'` הוא
הערך היחיד שמוציא מהרשימה. החריג היחיד הוא `reservations.status = 'draft'`,
ומטעם אחר לגמרי — ראה D140.

- `cancelled` נכלל **במפורש**: ביטול במדיניות ללא-ביטול מזכה בתשלום מלא,
  וזהו המקרה שהכי קל לפספס. שורה מבוטלת נושאת תגית "בוטלה" ברורה ומובחנת
  לצד שם האורח, כדי שלא תיקרא כאורח ששוהה בנכס. שאר התצוגה, המיון והחומרה —
  ללא שינוי.
- `balance = 0` אינו מוציא מהרשימה: זהו cache נגזר (D52 §6), לא עדות לתשלום.
- אכיפה סטטית: `check:pay-widget-no-status-whitelist` נכשל אם שאילתת הווידג'ט
  מסננת על ציר הוורקפלואו בכל דרך שאינה ההשוואה היחידה ל-`'approved'`, או
  מחזיקה whitelist של סטטוסים (בשום מקום בשאילתה — כולל ON של JOIN). המנגנון:
  **הקפאה מלאה** — תבנית השאילתה כולה (כולל האינטרפולציות) מושווית מילה-במילה
  לעותק קנוני בתוך ה-guard, וצורת המיפוי מוקפאת ל-`payRowsRaw.map(...)` חשוף
  (בלי `filter`) — כך שגם עקיפה דרך CTE, תת-שאילתה ב-FROM,‏ JOIN פנימי, שער
  LATERAL, פרגמנט `sql``` מוברח דרך `${}` או סינון JS אחרי השאילתה נופלת.
  שינוי לגיטימי מעדכן את העותק הקנוני באותו קומיט. ה-guard מריץ בכל ריצה
  סוללת מוטציות B2 — נטרולים סמנטיים של ההשוואה ל-'approved' (בשמירת כל
  הסימנים המבניים) וכל מחלקות העקיפה שנמצאו ב-red-team — וכל מוטנט חייב
  להפיל אותו; אם מוטנט עובר, ה-guard מפיל את עצמו.

## D140 — טיוטה אינה הזמנה שלא שולמה אלא הזמנה שטרם נוצרה (2026-08-07)

`reservations.status = 'draft'` מוחרג מחלון החיובים (D139) — ומטעם שאינו
שייך לציר התשלום כלל: טיוטה אינה הזמנה שלא שולמה אלא הזמנה שטרם נוצרה. אין
לה עסקה לאשר, והבית שלה הוא חלון "דורש טיפול" (כפתור האישור draft→confirmed),
לא רשימת החיובים. זה החריג היחיד שהכלל של D139 מתיר, והוא היחיד שה-guard
מקבל על ציר ה-status.

## D141 — פער ה-draft בין "דורש טיפול" לווידג'ט התשלומים — הוכרע: מחריגים בשניהם (2026-08-08)

**הוכרע (רונן, 2026-08-08): שאילתת החובות של "דורש טיפול" מחריגה גם
`draft` — שני החלונות מדברים כלל אחד.** יושם באותו יום (ענף
`fix/d141-d142-resolution`).

הרקע שהוליד את השאלה: אחרי #187 שאילתת החובות של dashboardAlerts החריגה
**רק** `wf.key = 'approved'`, בעוד ווידג'ט התשלומים (D139/D140) מחריג
**שניים** — `approved` וגם `reservations.status = 'draft'`. טיוטה עם חוב
רשום הופיעה כ"טרם שולם" בחלון אחד ונעדרה מהשני, ואופרטור שהצליב ראה
סתירה.

**הנימוק:** טיוטה אינה התחייבות — אין עסקה ואין חוב לגבות (D140: "הזמנה
שטרם נוצרה"); ושורת "טרם שולם" על טיוטה היא רעש שמאמן את האופרטור להתעלם
מהתראות הכסף. הטיוטה **אינה נעלמת** מ"דורש טיפול": היא נשארת שם כשורת
אישור (הכפתור draft→confirmed) — הבית האמיתי שלה. חוב שנרשם על טיוטה
ייראה בחלונות הכסף מרגע האישור.

**הערת הצירים (חשובה למי שיקרא את השאילתות):** שתי ההחרגות חיות על צירים
שונים בכוונה — `approved` על ציר הוורקפלואו (`wf.key`), `draft` על ציר
ה-lifecycle‏ (`res.status`). ההחרגה נוספה ל"דורש טיפול" **באותו ציר ובאותו
ניסוח** כמו בווידג'ט (`AND res.status <> 'draft'`), כדי ששני החלונות ייקראו
כאותו כלל ולא כשני כללים שבמקרה מסכימים.

אכיפה: `check:alerts-window-includes-cancelled` עודכן באותו קומיט —
התבנית הקנונית כוללת את ההחרגה, אסרט ייעודי מוודא את נוכחותה, ומוטנט B2
שמסיר אותה (וגם עטיפת OR-true שמנטרלת אותה סמנטית) מפיל את הגארד.

## D142 — ה-DSN של liveness: ה-pooler משמיט פרמטרי startup; חיבור ישיר בלבד (2026-08-08)

תיעוד קבע למי שמריץ `pnpm liveness` — הדברים האלה נמדדו ואינם משוחזרים
מהקוד:

- `DATABASE_URL` ב-`.env.local` מצביע על **supabase-pooler** (Supavisor,‏
  `localhost:5432`). ה-pooler **משמיט פרמטרי startup** — נמדד עם
  `default_transaction_read_only` (אותה מחלקה כמו `search_path`, כמתועד
  ב-lib/db.ts). לכן ה-preflight של run-liveness (נכשל-סגור) מסרב לו, ובצדק:
  חיבור דרך ה-pooler אינו כשר ל-liveness.
- `LIVENESS_DB_URL` חייב להצביע על ה-backend הישיר — קונטיינר `supabase-db`.
  הקונטיינר **אינו ממופה לפורט על ה-host**; הכתובת היא IP בגשר ה-docker
  (נכון להיום `172.18.0.4`, עלול להשתנות ב-restart של הקונטיינר —
  `docker inspect supabase-db` מגלה את העדכני).
- פורמט המשתמש תלוי-מסלול: `guesthub_app.bios-vps` הוא **פורמט tenant של
  Supavisor** ותקף רק דרך ה-pooler; חיבור ישיר ל-supabase-db דורש
  `guesthub_app` **נקי**, בלי סיומת.
- ה-probes יורשים את ה-DSN המאומת מהראנר: run-liveness דורס את
  `DATABASE_URL` בסביבת כל probe ב-RO_DSN (‏`LIVENESS_DB_URL` + פרמטר
  ה-read-only). ב-Node ≥20.6 משתנה סביבה אמיתי גובר על `--env-file`, ולכן
  `.env.local` אינו מזין את ה-probes תחת הראנר (נמדד, Node v20.20.1).
- **הוכרע (רונן, 2026-08-08) — אפשרות ב': טביעת אצבע של הקלאסטר.** הפער:
  `PRODUCTION_MARKERS` מקבל את ה-DSN הישיר על סמך `:5432/` בלבד — ל-IP פנימי
  של docker אין סימן זהות אמיתי, וכל חיזוק של המחרוזות מפיל בהכרח את ה-DSN
  הישיר (נמדד). **הנימוק:** זהות קלאסטר אמיתית מול מחרוזת שניתן להרכיב —
  סימן טקסטואלי ב-DSN הוא משהו שכל DSN יכול ללבוש; `pg_control_system().system_identifier`
  הוא זהות של הקלאסטר עצמו, נקראת מהיעד החי ואי-אפשר לזייף אותה בעריכת
  connection string. **המיקום:** הערך מוצמד כ-`PROD_CLUSTER_FINGERPRINT`
  בתוך `scripts/run-liveness.mjs` — תחת בקרת גרסאות במכוון (זהות ציבורית,
  לא סוד; env היה נודד בין מכונות). **שלב הבדיקה:** על חיבור ה-preflight,
  בסדר מרקרים → חיבור → read-only → **טביעה** → probes; אי-התאמה, כשל
  שאילתה — סירוב exit 2 לפני probe ראשון. מסננת המרקרים נשארת כמסננת
  ראשונית — הטביעה מחייבת, לא מחליפה. אכיפה: `check:liveness-cluster-fingerprint`
  (הקפאה + סדר + B2). נמדד 2026-08-08: פרוד `7623660179909357606`, ‏testdb
  ‏`7658773266609565741`, ‏staging ‏`7663867436352364584` — שלושתם שונים.

הנוסח התפעולי המלא ("איך מריצים liveness") שוכפל ל-GUIDELINES.md §14.

## D143 — אין אכיפת DB על ברירת-המחדל לייבוא; ההגנה היא action + גארד, במכוון (2026-08-08)

החסימה של `approved` ו-`draft` כברירת-מחדל לייבוא (D89/D139/D140, ‏#186
והקשחת 2026-08-08) חיה בשתי שכבות: דחייה בתוך
`setDefaultWorkflowStatusAction` (בתוך הטרנזקציה, לפני הכתיבה, לפי `key`)
+ הגארד `check:no-approved-or-draft-as-default` ב-CI. **אין** constraint או
trigger ברמת ה-DB — SQL ישיר כ-admin עדיין יכול לסמן `is_default` על
`approved`/`draft`.

זה מצב **מכוון**, לא פער שנשכח:

- `lookup_items` היא טבלה גנרית רב-קטגורית; CHECK שקושר ערכי `metadata`
  ל-`key`-ים ספציפיים של קטגוריה אחת מקבע דוקטרינת מוצר בתוך הסכימה, במקום
  שבו היא הכי יקרה לשינוי (מיגרציה לכל התאמה עתידית).
- מודל האיום הוא טעות אופרטור דרך ה-UI — ומולו הדחייה בשרת אטומה (אין
  מסלול UI שעוקף אותה). admin עם psql על פרוד יכול ממילא להפיל כל
  constraint; שכבת DB לא מוסיפה הגנה מולו, רק טקס.
- הנתיב היחיד שכותב `is_default` בקוד המוצר הוא ה-action הזה (הייבוא רק
  קורא את הכוכב) — נקודת אכיפה אחת, מכוסה גארד עם B2.

אם ייווסף אי-פעם מסלול כתיבה שני ל-`is_default`, ההחלטה הזאת נפתחת מחדש.

## D144 — הרשאות כתיבה לטבלאות עתידיות בסכימה guesthub (2026-08-08)

**סטטוס: הוכרע (רונן, 2026-08-08) — אפשרות (א), עם שני חריגים מפורשים. מיושם במיגרציה `082_default_privileges_write.sql` + הרחבת `check:grants`.**

**הרקע:** מיגרציה 080 סגרה את פער ה-SELECT‏ (`GRANT USAGE ON SCHEMA` +
`GRANT SELECT ON ALL TABLES` + `ALTER DEFAULT PRIVILEGES FOR ROLE
supabase_admin`). אחרי הפריסה אומת בפרוד: שתי הטבלאות קריאות, אפס טבלאות
חסרות SELECT, ‏82 שורות בלדג'ר.

**הממצא:** ברירת המחדל תחת `supabase_admin` מעניקה ל-`guesthub_app` **קריאה
בלבד**, בעוד שתחת `postgres` היא מעניקה `arwdDxt` מלא. על sequences
ו-functions תחת `supabase_admin`,‏ `guesthub_app` אינו מופיע כלל. הפלט המלא
של `pg_default_acl` לסכימה, כפי שנמדד בפרוד ב-2026-08-08:

```text
    grantor     | objtype |                        defaclacl
----------------+---------+---------------------------------------------------------------------
 postgres       | S       | {service_role=rwU/postgres,guesthub_app=rwU/postgres}
 postgres       | f       | {service_role=X/postgres}
 postgres       | r       | {service_role=arwdDxt/postgres,guesthub_app=arwdDxt/postgres}
 supabase_admin | S       | {service_role=rwU/supabase_admin}
 supabase_admin | f       | {service_role=X/supabase_admin}
 supabase_admin | r       | {service_role=arwdDxt/supabase_admin,guesthub_app=r/supabase_admin}
```

מכיוון שראנר המיגרציות רץ כ-`supabase_admin`, טבלה שתיווצר במיגרציה 081+
תיוולד קריאה-אך-לא-כתיבה עבור האפליקציה. טבלה עם `identity`/`serial` תיצור
בנוסף sequence בלי `USAGE` — כלומר `INSERT` ייכשל גם אם הרשאת הטבלה תתוקן.

**חומרה:** `check:grants` בודק SELECT בלבד ויעבור ירוק. הכשל יתגלה בזמן
ריצה בפרוד כ-`permission denied` על כתיבה — מאוחר יותר מהכשל המקביל של
076→077, שהתגלה בקריאה.

**מצב נמדד (פרוד, 2026-08-08):**

- טבלאות ללא `INSERT` ל-`guesthub_app`: **2** — כלומר הפער **כבר פעיל, לא
  עתידי**:
  - `schema_migrations` — **מכוון** (הכרעת 080: הלדג'ר SELECT-בלבד, כתיבה
    רק לראנר). אינו חלק מהפער.
  - `booking_channel_reports` — **פער פעיל**: קוד האפליקציה מריץ
    `INSERT INTO guesthub.booking_channel_reports`
    (‏booking-com-reports-core.ts:164, מסלול `submitBookingComReport`) תחת
    `guesthub_app`, וההרשאה חסרה. הטבלה מונה 0 שורות בפרוד — עקבי עם מסלול
    כתיבה שמעולם לא הצליח (או לא הופעל). ‏080 העניקה לה SELECT בלבד, לפי
    ההכרעה שהוגבלה במפורש ל-SELECT.
- ‏sequences ללא `USAGE`: **0** מתוך 2 (‏`channel_dirty_revision_seq`,‏
  `ttlock_ops_id_seq` — שתיהן עם GRANT מפורש מהמיגרציה היוצרת). החלק הזה
  של הפער עתידי בלבד.

**שתי האפשרויות:**

*(א) הרחבת ברירת המחדל* — `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`
+ `GRANT USAGE, SELECT ON SEQUENCES` תחת `FOR ROLE supabase_admin`.
יתרון: טבלה חדשה שמישה מיידית, אין מה לזכור.
חיסרון: מרחיב הרשאות בשקט לכל טבלה עתידית, כולל טבלאות שלא נועדו לאפליקציה
(לוגים, audit, טבלאות פנימיות של הראנר — הלדג'ר עצמו יידרש REVOKE מפורש
כדי לשמר את הכרעת 080). המודל הופך רחב-כברירת-מחדל ומצומצם-בחריגה, כלומר
לא ניתן לצמצם בלי לזכור לצמצם.

*(ב) קריאה בלבד כברירת מחדל + `GRANT` מפורש בכל מיגרציה שיוצרת טבלה
שהאפליקציה כותבת אליה* (המוסכמה הקיימת של 045/047/077).
יתרון: כל הרשאת כתיבה נראית בדיף ובהיסטוריה; מודל מצומצם כברירת מחדל.
חיסרון: נשכח בקלות — ‏076→077 הוכיחו זאת, ו-`booking_channel_reports` הוא
מופע חי שני — והכשל מתגלה רק בפרוד. **דורש הרחבת `check:grants`** לבדוק גם
כתיבה מול רשימת טבלאות מוצהרת בריפו — אחרת (ב) גרועה מ-(א), כי היא מוסיפה
חובת זכירה בלי מנגנון שתופס שכחה.

**הערה על עקביות:** הפער בין `postgres` ל-`supabase_admin`
ב-`pg_default_acl` הוא עצמו שריד היסטורי. ההכרעה צריכה להתייחס גם לשאלה אם
להשוות ביניהם או להשאיר את הפיצול, כדי ש-replay-from-zero וקלאסטר פרוד
יתנהגו זהה — הדרישה שנקבעה ב-D136.

**ההכרעה:** ממתין להכרעת רונן. (בלי קשר להכרעה — הפער הפעיל של
`booking_channel_reports` יצטרך תיקון נקודתי משלו: מיגרציה עם GRANT מפורש,
או הכרעה שהמסלול מוסר.)

**עדכון 2026-08-08 (מאוחר יותר):** הפער **הפעיל** נסגר נקודתית במיגרציה
081 — `GRANT INSERT` על `guesthub.booking_channel_reports` בלבד (אין
UPDATE/DELETE במסלול; אין sequence — ‏id הוא uuid). אומת ב-replay ‏83/83
על testdb: ‏INSERT כ-`guesthub_app` מצליח, הלדג'ר עדיין נדחה. **השאלה
הכללית של ברירת-המחדל לטבלאות עתידיות נשארת פתוחה כפי שנוסחה לעיל** —
‏081 אינה מכריעה בה, ו-`ALTER DEFAULT PRIVILEGES` לא הורחב.

**הכרעה (רונן, 2026-08-08 — סוגרת את D144):** אפשרות **(א)** — הרחבת
ברירת המחדל, עם שני חריגים מפורשים.

**הנימוק:** כל טבלה בסכימה `guesthub` נוצרת עבור האפליקציה הזאת ואין
בסכימה תפקיד כותב שני. מודל שמחייב `GRANT` ידני בכל מיגרציה מוסיף חובת
זכירה שתישכח — ‏076→077 הוכיחו, ו-`booking_channel_reports` היה המופע החי
השני — והכשל מתגלה רק בפרוד. שני מקומות חייבים להישאר מחוץ להרחבה, כי
היכולת למחוק אותם היא היכולת למחוק ראיות:

- **חריג 1 — `guesthub.schema_migrations`:** ‏`REVOKE INSERT, UPDATE,
  DELETE`. הלדג'ר נשאר SELECT-בלבד (הכרעת 080 מקובעת מחדש). האפליקציה לא
  כותבת לרשומת המיגרציות בשום מצב — לדג'ר שהאפליקציה יכולה לשכתב הוא
  רשומה מושחתת של מה שרץ, בדיוק מה ש-D136 קיים למנוע.
- **חריג 2 — מחלקת הביקורת:** ‏`REVOKE DELETE` בלבד (INSERT נשאר —
  האפליקציה כותבת את הראיות). לוג ביקורת שהאפליקציה יכולה למחוק אינו לוג
  ביקורת. שם הטבלה במשימה היה `audit_logs`, והוא אכן השם האמיתי; זוהו
  ואוכפו **שלוש** טבלאות במחלקה: `audit_logs` (מי/מה/לפני/אחרי, ‏000
  §6.16) וגם `bulk_rate_update_logs` + `bulk_rate_update_items` (תיעוד
  עדכוני מחירים גורפים, ‏000 §6.17 — אותו תפקיד ראייתי; נמדד: אף מסלול
  אפליקטיבי לא מעדכן/מוחק אותן, רק INSERT).

**היישום — מיגרציה `082_default_privileges_write.sql` (idempotent):**
‏`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA guesthub` —
‏`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES` + ‏`GRANT USAGE, SELECT
ON SEQUENCES` ל-`guesthub_app`; ‏blanket grants על relations/sequences
קיימים (התכנסות replay, בנוסח 080 — בפרוד no-op פרט ל-
`booking_channel_reports` שמקבלת UPDATE/DELETE); ושני החריגים כ-REVOKE
מפורש. ברירות המחדל של `postgres` לא נגעו — הפער ההיסטורי נשאר מתועד
כאן וב-D136. **התכנסות בפועל:** אחרי 082 שני הענפים מתכנסים על ארבע
הרשאות ה-DML לטבלאות (`arwd`; הענף של `postgres` מעניק גם ‎D/x/t —
‏TRUNCATE/REFERENCES/TRIGGER שלא בשימוש האפליקציה); ‏sequences כמעט
מתכנסים (`rU` מול `rwU` — בלי setval).

**אומת על testdb (:5433, ‏DB זמני שנמחק בסוף):** ‏replay מאפס 84/84;
ריצה שנייה "nothing to apply"; טבלה חדשה שנוצרה ע"י `supabase_admin`
אחרי 082 — ‏SELECT/INSERT/UPDATE/DELETE כ-`guesthub_app` עובדים ו-sequence
ה-identity שמיש (nextval); ‏INSERT ללדג'ר נדחה; ‏DELETE משלוש טבלאות
הביקורת נדחה; ‏INSERT ל-`audit_logs` מצליח.

**האכיפה — `check:grants` הורחב:** שני החריגים קפואים — הלדג'ר ללא
כתיבה, מחלקת הביקורת עם INSERT ובלי DELETE (שני הכיוונים: ‏DELETE שמופיע
= ראיות מחיקות; ‏INSERT שנעלם = לוג שמת בשקט). סוללת B2 הורחבה ל-6
מוטנטים, כולל מוטנט שמעניק כתיבה ללדג'ר (חייב להיכשל — נכשל), מוטנט
DELETE על הביקורת, מוטנט אובדן-INSERT, ונטרול סמנטי (רשימה קפואה שמצביעה
על טבלה לא-קיימת חייבת להיכשל ולא להוריק ריק).

**גבול ידוע (מתועד, מקובל):** ‏`ON TABLES` בברירות מחדל מכסה גם views
עתידיים; ‏view פשוט עתידי מעל טבלת ביקורת יעקוף את חריג ה-DELETE דרך
הרשאות בעל ה-view. אין אף view בסכימה כיום (`check:grants` סופר
‏pg_views ואוסר matviews) — המיגרציה שתיצור view ראשון חייבת REVOKE
כתיבה מפורש עליו.

## D145 — ‏dir="auto" על שדות טקסט חופשי בלבד, לא על 197 השדות (2026-08-14)

**ההקשר.** ביקורת ה-RTL (‏`AUDIT-FINDINGS.md`, ‏F-3) מצאה שאף שדה אינו נושא
`dir="auto"`: שם אורח לטיני ("John Smith"), שאילתת חיפוש באנגלית או הערה
לטינית מיושרים לימין עם הפיסוק בצד הלא-נכון. הסקיל (‏hebrew-rtl) ממליץ
`dir="auto"` על **כל** ‏input/textarea.

**ה-fork.** על שדה **מספרי**, ‏`dir="auto"` עם ספרות בלבד (תו חלש) נופל
לבסיס LTR ומזיז את היישור מהימין לשמאל — שינוי נראה בכל שדות המחיר,
הלילות והכמויות, שהם הרוב מבין 197 השדות.

**ההכרעה (השמרנית).** ‏`dir="auto"` רק על שדות שהתוכן שלהם הוא באמת
דו-לשוני: ‏4 חיפושים (‏TopBar · הזמנות · אורחים · חיפוש האורח בפאנל),
שם פרטי/משפחה/חברה/הערות בשני הפאנלים, ושם בעל הכרטיס. שדות מספריים
נשארים כפי שהם; שדות טכניים (טלפון/אימייל/מספר כרטיס/ת"ז/שעה) כבר
נושאים `dir="ltr"` מפורש — המוסכמה הקיימת, לא נגענו.

**האלטרנטיבות שנרשמו ולא נבחרו:** (א) ‏`dir="auto"` גלובלי — משנה יישור
של עשרות שדות מספריים; (ב) ‏CSS ‏`unicode-bidi: plaintext` על `.field-input`
— אותה בעיה בדיוק, רק נסתרת יותר.

## D146 — ‏scrollbar-gutter: stable על שני הגוללים הראשיים בלבד (2026-08-14)

ב-RTL פס גלילה קלאסי נדחף לצד **שמאל** — צד ה-inline-end — והופעתו מזיזה
את כל התוכן שמעוגן ימינה. ‏`stable` שוריין על `main.thin-scroll` (הגולל של
כל מסך) ועל `.dw-bd` (גוף כל מגירה) — שני המקומות שבהם תוכן גדל דינמית.
**לא** גלובלית: על גוללים קטנים (תפריטים, popovers) השורה הריקה הקבועה
עולה יותר מהרווח, ובמגע ‏§5 כבר מעלים את הפס לגמרי (‏overlay = ‏0px שמור).

## D147 — איסור worktrees ללא בקשה מפורשת (2026-08-14)

**ההקשר.** הדוקטרינה מ-2026-07-24 (‏"Production Runtime") חייבה כל עבודה
ב-git worktree נפרד עם בנייה ואימות מבודדים. בפועל הצטברו עשרות worktrees
(‏115 נוקו ב-2026-08-08), וההפרדה ייצרה עלות תפעולית קבועה שאינה מוצדקת
במקרי hotfix קצרים.

**ההכרעה.** אסור ליצור, להשתמש או להציע git worktree אלא אם רונן ביקש זאת
במפורש בבקשה הנוכחית. עבודה נעשית על branch ייעודי ישירות
ב-`/var/www/guesthub`, והתיקייה חוזרת ל-`main` בסוף הריצה. בעץ הפרודקשן
אסור `next dev` ואסור `pnpm build` — שניהם כותבים ל-`.next` שממנו פרודקשן
מוגש; build אך ורק דרך `PROD_DEPLOY_OK=1 npm run deploy:prod` ובאישור רונן.

**ההשלכה התפעולית — אימות לפני deploy.** בהיעדר worktree אין בנייה מבודדת
לפני מיזוג: האימות לפני deploy הוא `pnpm tsc --noEmit` + ‏`pnpm lint` +
הוכחת קוד (מעקב שורה-שורה, עם מספרים, על המקרים הקריטיים כולל קצוות).
בדיקה ויזואלית נעשית **אחרי** deploy, עם rollback מוכן. סעיף ה-Concurrency
(‏`git status --porcelain -- <file>` לפני כל staging; בלי `git add -A`)
מקבל משנה חשיבות — כמה סוכנים חולקים עץ עבודה אחד.

הבית הקנוני של הכלל: CLAUDE.md (מתחת לכללי הברזל); הפניה: GUIDELINES.md §15.

## D148 — הצהרה לא-משוכבת גוברת על כל @layer; רמז ה-position של המגע עבר ל-@layer base (2026-08-14)

**התקרית.** רצועות יומן המובייל הוצגו במראה (הזמנות של היום על העמודה
השמאלית) על כל טלפון אמיתי — אנדרואיד ואייפון — בעוד דסקטופ ואמולציית
עכבר תקינים. שלושה תיקונים קודמים (‏dir pin, ‏fallback פיזי, חותמת גרסה)
לא עזרו, כי האבחנות התמקדו בכיוון. השורש, שאומת אמפירית ב-Playwright על
ה-CSS המקומפל: כלל הרחבת מטרות-המגע ב-responsive.css —

```css
@media (pointer: coarse) { :where(button, …) { position: relative } }
```

— ישב **מחוץ ל-@layer**. לפי ‏Cascade 5, הצהרה לא-משוכבת גוברת על כל
שכבה ללא קשר לספציפיות; ה-`:where()` לא מגן, כי ספציפיות נשקלת רק בתוך
אותה שכבה. ‏`.cb-m-bar` (‏button, ‏`position:absolute` ב-layer components)
נדרס ל-`relative` בכל מכשיר מגע, חזר לזרימת ה-flex כאיבר אחרון —
שב-RTL הוא הקצה השמאלי — וה-`right:X%` הפך להזזה יחסית.

**ההכרעה.** רמז ה-position עטוף `@layer base` (מוכרז לפני components):
כך הוא מפסיד לכל `position` מפורש — ‏components, ‏utilities או partial
לא-משוכב — שזו בדיוק כוונתו המתועדת ("relative רק היכן שהפקד עדיין
static"). כללי ה-`::after` של שטח המגע נשארים לא-משוכבים בכוונה (צריכים
לגבור על ה-partials הלא-משוכבים). שומר: ‏check:responsive ‏#20, הופל
במוטציה (הסרת העטיפה = ‏exit 1).

**הלקח הרוחבי.** ‏`:where()` הוא כלי ספציפיות, לא כלי כניעות-cascade.
כלל גלובלי שנועד "לא לנצח אף אחד" חייב שכבה מוקדמת — לא ספציפיות אפס.

## D149 — ה-web app מוצהר ב-ecosystem כבינארי next ישיר, לעולם לא npm start (2026-08-17)

**התקרית.** שלושה שירותי Next תחת pm2 — ‏`guesthub` (3007), ‏`mail-system`
(3008) ו-`pms` (3004) — היו בלולאת קריסה חיה: ‏264,991 / 258,993 / 10,705
restarts, כ-1.5 בשנייה, ‏`125%+103% CPU` (כל ה-load average 4.52) ו-179MB
לוגים. איש לא הבחין, כי האתרים ענו 200 לאורך כל הזמן.

**השורש — שכבת ה-npm.** שלושתם נרשמו כ-`script=/usr/bin/npm args=["start"]`.
pm2 עוקב אחרי תהליך ה-wrapper, לא אחרי הנכד שהוא מריץ. כשה-wrapper מת,
ה-`next-server` שורד כיתום (‏`ppid=1`) וממשיך להחזיק את הפורט; pm2 מסיק
שהשירות נפל, מרים `npm start` חדש, מקבל `EADDRINUSE`, קורס, וחוזר — לנצח.
היתום הגיש את ה-build הנכון, ולכן `curl` ענה 200 והדפלוי הדפיס הצלחה. מבחן
ההצלחה היחיד שסופר: ה-pid ב-`pm2 jlist` **חייב** להיות זהה ל-pid שמאזין
ב-`ss -ltnp`; שונים = יתום.

**ההכרעה.** ה-web app מוצהר ב-`ecosystem.config.cjs` (‏app שני לצד
ה-worker) עם `script: "node_modules/next/dist/bin/next"` ו-`args: "start -p
3007"` — הבינארי עצמו, בלי מנהל חבילות. נוסף `min_uptime: "30s"` שנעדר
מהרישום החי, לצד `max_restarts: 10` ו-`restart_delay: 5000` שכבר קיימים בו.

**שורה 69 ב-`scripts/deploy-production.sh` לא שונתה, במכוון.** הדפלוי מריץ
‏`pm2 restart "$PM2_APP"` לפי שם; ‏`restart` לפי שם משתמש ברישום החי כמות
שהוא ואינו קורא שום קובץ תצורה, ולכן דפלוי אינו יכול לדרוס את הרישום ואינו
יכול להחיל את ההצהרה הזו. ההצהרה היא מקור-האמת לרישום מחדש מאפס
(`pm2 start ecosystem.config.cjs --only guesthub`), לא לדפלוי השוטף.

**הרמה מטרמינל אינטראקטיבי מטביעה את סביבת ה-shell ברישום.** ‏`pm2 start`
מעתיק את `process.env` של המריץ אל תוך `pm2_env`, ומשם אל `~/.pm2/dump.pm2`
(‏mode 664 — קריא לכל משתמש על המכונה). נמדד: הרישום נושא 55 מפתחות שאינם
בסביבת המערכת ואינם ב-`.env.local`, כולל טוקנים חיים של סשן פיתוח; גם
ה-worker נושא 23 כאלה. **בצילום שלפני התיקון הרישום נשא `PROD_DEPLOY_OK=1`**
— כלומר שער האופט-אין של הדפלוי (`deploy-production.sh:23`, ואיתו
prebuild-guard) היה פתוח בסביבה של תהליך פרודקשן, לא מהקלדה מפורשת של אדם.
מכאן `filter_env` על ההצהרה. אזהרה למי שיערוך: ב-pm2 6.0.14 הערך הבוליאני
`filter_env: true` הוא no-op — ‏`lib/Common.js` בודק `app.filter_env.length > 0`
לפני שהוא קורא ל-`filterEnv`, ול-`true` אין `length`. רק מערך (או מחרוזת)
פועל, וההתאמה היא **תת-מחרוזת** בשם המשתנה, לא prefix.

**מה נשאר פתוח.** ‏`filter_env` וה-`min_uptime` נכנסים לתוקף רק ב-`pm2 start`
הבא מהקובץ. עד אז הרישום החי נשאר בדיוק כפי שהורם ב-2026-08-17 — הצורה
הנכונה (בינארי ישיר) אך עם הסביבה המזוהמת. סגירת הפער דורשת
`pm2 delete guesthub && pm2 start ecosystem.config.cjs --only guesthub`
בחלון שירות מאושר, ולא נעשתה כאן.

## D150 — ‏`--update-env` הוסר מהרסטארט של ה-web app; התצורה מגיעה מ-`.env.local` (2026-08-17)

**‏`--update-env` היה מנגנון הזיהום עצמו, לא רק נתיב שעוקף את הסינון.** ‏D149
תיאר את הרישום המזוהם כתוצר של הרמה חד-פעמית מטרמינל אינטראקטיבי. זה היה
תיאור חלקי. ‏`lib/API.js` בתוך `_operate`:

```js
if (update_env === true) {
  if (conf.PM2_PROGRAMMATIC == true)
    new_env = Common.safeExtend({}, process.env);
  else
    new_env = Object.assign({}, process.env);
  Object.keys(envs).forEach(function(k) { new_env[k] = envs[k]; });
}
else { new_env = envs; }
```

המקור הוא `process.env` של ה-**shell שמריץ את pm2**, כלומר של המפעיל. כל
`PROD_DEPLOY_OK=1 npm run deploy:prod` הזריק מחדש לרישום את שער האופט-אין
של הדפלוי ואת ‎20 משתני ה-`npm_*`, ושמר אותם ל-`~/.pm2/dump.pm2`. הזיהום לא
היה שריד היסטורי — הוא חודש בכל דפלוי.

**המנגנון מוסיף ודורס בלבד, לעולם לא מנקה.** ‏`God.restartProcessId` מבצע
`Utility.extend(proc.pm2_env.env, env)` תחת הקומנט "Merge new application
configuration on restart", ו-`Utility.extend` עובר רק על מפתחות ה-**מקור**:

```js
extend : function(destination, source){
  if (!source || typeof source != 'object') return destination;
    Object.keys(source).forEach(function(new_key) {
      if (source[new_key] != '[object Object]')
        destination[new_key] = source[new_key];
    });
  return destination;
},
```

מפתח שקיים ברישום ואינו בסביבה החדשה נשאר. משמעות מעשית: הזיהום **מצטבר**
לאורך דפלויים ואינו ניתן לניקוי ע"י רסטארט — רק ע"י `delete` + `start`.

**הראיה שההסרה בטוחה.** בצילום ה-`pm2_env` שלפני התיקון: ‏`DATABASE_URL
present: false`, ‏`NEXT_PUBLIC_* keys: none` — בעוד האתר שירת ‎200 ברציפות.
כלומר מה שהאפליקציה באמת צריכה מעולם לא הגיע אליה דרך pm2. ‏Next טוען את
‏`.env.local` בעצמו בזמן ריצה (`next-server.js:643,1049` → `loadEnvConfig`
→ `@next/env`), וה-worker דרך `--env-file-if-exists=.env.local`. ארבעת
ה-`NEXT_PUBLIC_*` אכן נקראים בזמן ריצה בצד השרת (‏7/9/8/2 קבצים ב-`.next/server`
עם קריאת `process.env` חיה; ב-`.next/static` אפס — שם הם הוטבעו ב-build),
אבל מקורם הוא הקובץ. גם `NODE_ENV`/`PORT` אינם תלויים בדגל: הם שמורים
ב-`pm2_env.env` מה-`pm2 start`, ו-`node_modules/next/dist/bin/next:68` מבצע
בלאו הכי `process.env.NODE_ENV = process.env.NODE_ENV || "production"` עבור
`start`, בעוד הפורט מגיע מ-`args: "start -p 3007"`.

**‏`filter_env` חל רק בנתיב `_startJson`, ולכן שני ה-apps מטופלים אחרת.**
המופע היחיד של השדה בכל קוד pm2 6.0.14 הוא ב-`lib/Common.js` בתוך
`prepareAppConf`, שנקרא רק מ-`_startScript`/`_startJson` — אין לו זכר
ב-`lib/God.js`, ב-`lib/God/` או ב-`lib/API.js`. מכאן:
- **ה-worker** מופעל דרך `pm2 startOrRestart ecosystem.config.cjs`, כלומר
  `_startJson` — הקובץ נקרא, `filter_env` מוחל, והשדה שנוסף כאן לרשומתו מגן
  עליו. השורה נשארה כמות שהיא, כולל הדגל.
- **ה-web app** מופעל בשורה 69 דרך `pm2 restart <name>`, נתיב שאינו קורא קובץ
  ואינו מחיל `filter_env` בשום שלב. שם אין מנגנון סינון להישען עליו, ולכן
  התיקון היחיד האפשרי הוא הסרת הדגל.

**הסייג, במכוון.** מרגע ההסרה, משתנה שמישהו מייצא ידנית ב-shell לפני הרצת
הדפלוי לא יגיע יותר לתהליך. זו הכוונה: ערוץ התצורה המוצהר היחיד הוא
‏`.env.local`, ומשתנה שאינו בו אינו אמור להשפיע על פרודקשן.

**תוספת 2026-09-04.** ‏guesthub וה-worker נרשמו מחדש מ-shell נקי דרך
`env -i … pm2 start ecosystem.config.cjs`; ה-env החי ירד מ-64 ל-11 מפתחות.
נצפה: ‏`pm2 restart <name>` (שורה 69 בסקריפט הדפלוי) **מוחק את `filter_env`
מהרישום החי** (‏8→0). לא מזיק כל עוד `--update-env` נשאר מחוץ לשורה; המשמעות
היא שהרישום החי אינו נושא שום מסנן אם מישהו אי-פעם יריץ רסטארט עם
`--update-env` מ-shell מזוהם. ההגנה היא הסרת הדגל של D150, לא `filter_env`.

---

## D151 — ‏`Failed to find Server Action` הוא כשל רוחבי של מעבר גרסה, לא באג של כפתור (2026-08-17)

**פריט פתוח. לא תוקן. הכיוון לא הוכרע.** הרשומה הזו מתעדת את היקף הכשל
בלבד, כדי שלא יטופל שוב כתקלה מקומית.

**המנגנון: מזהה ה-action הוא ארטיפקט build, והטאב הפתוח מחזיק את המזהה
הישן.** ‏Next מפנה קריאת server action לפי מזהה שנקבע בזמן ה-build ונצרב
לתוך ה-bundle של הלקוח. ‏deploy מייצר build חדש, ולכן מזהים חדשים. טאב
שנטען **לפני** ה-deploy ממשיך לשלוח את המזהה הקודם — שאינו קיים יותר
בשרת — והקריאה **נזרקת**. אין כאן כשל של הרשאות, של ולידציה, של רשת ולא
של מסלול הכתיבה: המסלול בשרת תקין לחלוטין, פשוט אף אחד לא הגיע אליו.

מכאן שהחשיפה אינה תלויה באיזה כפתור נלחץ אלא **מתי נטען הטאב**. כל טאב
פתוח מלפני דפלוי הוא לקוח מזוהם: כל server action שייקרא ממנו ייכשל באותה
צורה, עד רענון. במערכת שנפרסת כמה פעמים ביום זה מצב שגרתי, לא קצה.

**הראיה, כפי שצוטטה בגוף PR ‏#192:** ‏`Failed to find Server Action` —
‏**28 מופעים בלוג הפרוד, ביום עם שלושה deploys**. שלוש פריסות ביום אחד
ייצרו 28 קריאות שנזרקו. זה אינו רעש: זו התפלגות צפויה של מספר טאבים
פתוחים כפול מספר הפריסות.

**‏#192 מכסה כפתור אחד. אחד.** התיקון שם הוא ‏`try/catch` סביב הקריאה
היחידה ב-`markCharged` — הכפתור "חויב" בווידג'ט "כרטיסי אשראי לחיוב"
([PayWindow.tsx:64-82](src/app/(dashboard)/dashboard/windows/PayWindow.tsx#L64-L82)).
הוא נכון ונחוץ: בלעדיו הקריאה שנזרקת אינה פוגעת באף ענף — ה-chip נשאר
מסומן 'חויב ✓' אופטימית, אפס כתיבה, אפס toast, אפס רישום, ואחרי רענון
השורה חוזרת "טרם שולם". אבל הוא מטפל ב**סימפטום במקום אחד**, ולא בסיבה.
נכון לרשומה הזו ‏#192 עצמו **טרם מוזג**, כך שגם הכפתור הזה עדיין חשוף
ב-main.

**כל שאר ה-server actions באפליקציה חשופים לאותו כשל בדיוק.** נמדד על
main:

| מדד | ספירה |
|------|-------|
| קבצים עם `"use server"` | 39 |
| ‏`export async function` בקבצים האלה | 160 |
| קבצי לקוח (`.tsx`) עם קריאת `…Action(` | 56 |
| מהם קבצים שאין בהם ולו `try {` אחד | 40 |

הספירה האחרונה גסה במכוון — היא נוכחות `try {` ברמת הקובץ, לא כיסוי של
כל אתר קריאה. כלומר 40 היא **רצפה** למספר הקבצים חסרי ההגנה, לא תקרה:
קובץ שנספר כ"יש בו try" עשוי בהחלט להחזיק קריאות נוספות בלי הגנה. הכיוון
של המספר הוא מה שקובע — הרוב המוחלט של אתרי הקריאה אינו מטפל בזריקה.

**למה `try/catch` לכל אתר קריאה אינו הפתרון.** ‏160 actions ו-56 קבצי
לקוח פירושם עשרות עטיפות ידניות שכל אחת יכולה להישכח, ואף אחת מהן לא
פותרת את בעיית האמת: המשתמש יושב מול לקוח שאינו תואם את השרת. גם עטיפה
מושלמת בכל אתר קריאה תניב, במקרה הטוב, toast שגיאה לכל לחיצה — ולא את
הדבר היחיד שמסיים את התקלה, שהוא רענון.

**שני כיוונים אפשריים, ואף אחד מהם לא הוכרע:**
1. **‏error boundary גלובלי** שמזהה את חתימת הכשל הזו ומטפל בה במקום אחד,
   במקום 56.
2. **רענון אוטומטי בזיהוי** — משמאובחן מזהה action מיושן, לרענן את הלקוח
   (או להציג הנחיית רענון חוסמת) ובכך להחזיר אותו לתאימות עם השרת.

הכרעה בין השניים דורשת החלטה על התנהגות מול המשתמש (רענון שקוף מול הנחיה
מפורשת), על גורל קלט שלא נשמר ברגע הרענון, ועל אופן הזיהוי עצמו. שום אחד
מהשלושה לא נדון עדיין, ולכן הפריט נרשם פתוח.

**מה הרשומה הזו אוסרת:** לסגור מופע עתידי של `Failed to find Server
Action` בתור "תוקן" על בסיס עטיפה נקודתית של הכפתור שעליו התלוננו. הכפתור
הוא היכן שראו את הכשל, לא היכן שהוא נמצא.

## D152 — משבצת בלוח = תאריך, לא לילה (2026-08-17)

**ההכרעה.** בגריד לוח השנה כל משבצת מייצגת **תאריך**. הלילה הוא ה**מרווח**
בין שתי משבצות. גרירה על 17+18 היא לילה אחד (‏17→18), לא שניים; שלוש
משבצות הן שני לילות.

**התקלה שזה תיקן.** המודל הקודם ספר את משבצת העוגן עצמה כלילה והוסיף ‎+1
על הקצה, ולכן כל בחירה בגרירה יצאה **לילה אחד ארוכה מדי**. מקור הטעות היה
מפורש בקומנט של הפונקציה — "The first selected cell is always a stay
night" — ולכן נמחק ולא רק תוקן.

**המימוש.** ‏`createRangeTarget`
([calendar-interactions.ts:140-152](src/lib/calendar-interactions.ts#L140-L152)):
‏`ci`/`co` הם המינימום והמקסימום של העוגן ושל `addDays(עוגן, dayDelta)`,
בלי ‎+1 על אף קצה. אינוריאנט: `co > ci` תמיד.

**נגזרות:**
- **`cellRangeGeometry` מכסה גם את משבצת ה-checkout** — הבנד מסמן את מה
  שהמשתמש גרר עליו, ולכן הוא רחב במשבצת אחת מהפיל שייווצר ממנו. זו הבחנה
  מכוונת: **הבנד = בחירה, הפיל = שהות.** ‏N לילות פורשים ‎N+1 משבצות.
- **`dayDelta === 0`** (גרירה שחצתה סף אך התעגלה ל-0) → **רצפה של לילה
  אחד, לא חסימה**: אין מרווח למדוד, ולכן `co = addDays(ci, 1)`. זהו
  החריג היחיד בפונקציה.
- **הפרמטר `minNights` של `createRangeTarget` נמחק** — שני אתרי הקריאה
  ([CalendarGrid.tsx:388](src/app/(dashboard)/calendar/CalendarGrid.tsx#L388),
  [:798](src/app/(dashboard)/calendar/CalendarGrid.tsx#L798)) העבירו `1`
  קשיח, ולכן הענף היה מת. אכיפת מינימום הלילות נשארת ב-`nightsViolation`
  ([CalendarGrid.tsx:321-338](src/app/(dashboard)/calendar/CalendarGrid.tsx#L321-L338)),
  שגוזרת מ-`eachDay(ci, co)` ולא מ-`dayDelta` ולכן מתקנת את עצמה.
  ‏`s.minNights` לא נגע — הוא חי במסלול ה-resize.

**מה לא השתנה.** ‏`barGeometry` (‏mid-cell, נכונה מלכתחילה, שני guards
עליה); הדומיין נשאר checkout-exclusive; אין מיגרציית DB ואין שינוי בצד
שרת — הוא מקבל `ci`/`co` מוכנים.

**סייג נמדד: הרצפה של לילה אחד עקבית עם תפריט ההקשר, אך לא עם
הדאבל-קליק.** תפריט ההקשר יוצר `addDays(menu.date, 1)` בדיוק
([CalendarGrid.tsx:1124](src/app/(dashboard)/calendar/CalendarGrid.tsx#L1124)),
אבל הדאבל-קליק יוצר `addDays(date, Math.max(1, minNights))`
([CalendarGrid.tsx:847](src/app/(dashboard)/calendar/CalendarGrid.tsx#L847))
— כלומר הוא **מותח אוטומטית** את השהות למינימום של המשבצת. זו בדיוק
ההתנהגות שמסלול הגרירה מסרב לה במפורש (הוא **חוסם** בהודעה במקום להאריך
בשקט, כמתועד בקומנט ב-`:794-797`). הפער קדם לרשומה הזו ולא נסגר בה.

**תיקון (2026-08-18) — כאן נרשם ש"אין אכיפת מינימום לילות בשרת". זה
שגוי, והתיקון מחליף את הטענה.** האכיפה קיימת, בכל נתיב שיוצר או מזיז
שהות חיה. הטעות נבעה מ-grep שחיפש `nightsRuleViolation` ו-`min_stay_*`
בקבצי ה-actions ולא מצא אותם — הם באמת לא שם, כי האכיפה עוברת שרשרת
של ארבע חוליות שאף אחת מהן אינה מכילה את המחרוזות האלה:

| חוליה | קובץ:שורה |
|---|---|
| `validateAndPriceStays` — עטיפה דקה: `assertNoInternalOverlap` והמרת שגיאה, אפס לוגיקת מגבלות | [actions.ts:104](src/app/(dashboard)/reservations/actions.ts#L104) |
| `priceReservationStays` | [reservation-pricing.ts:262](src/lib/pricing/reservation-pricing.ts#L262) |
| `calculateReservationPrice` | [engine.ts:124](src/lib/pricing/engine.ts#L124) |
| `stayRestrictionViolationStructured` — הוולידטור המשותף | [engine.ts:363](src/lib/pricing/engine.ts#L363) → [rules.ts:56](src/lib/rates/rules.ts#L56) |

**ההבחנה הקריטית: `enforceRestrictions` אינו מדלג על חישוב.** המנוע תמיד
מעריך את **כל** המגבלות ומחזיר אותן ב-`rq.errors`; הדגל מחליט אילו קודים
**זורקים** ([reservation-pricing.ts:331-337](src/lib/pricing/reservation-pricing.ts#L331-L337),
והסינון עצמו ב-[firstEnforcedError:161-174](src/lib/pricing/reservation-pricing.ts#L161-L174)).
כיבוי הדגל הופך את הבדיקה ל**לא-חוסמת**, לא ל**לא-קיימת**. ההבחנה הזו
קובעת מה בכלל מותר להסיק מהיעדר חסימה: שהות שנכתבה אינה ראיה לכך שהיא
עברה בדיקה — רק לכך שהקוד שלה לא היה ברשימת החוסמים באותו מסלול.

הדגל דלוק בכל נתיב יצירה/הזזה חי: `createReservationAction` מעביר `true`
ללא תנאי ([actions.ts:316](src/app/(dashboard)/reservations/actions.ts#L316));
הבוקינג הציבורי כנ"ל
([create-booking.ts:116](src/lib/public-booking/create-booking.ts#L116));
העדכון וההזזה מעבירים `isBlocking(status)`
([actions.ts:620](src/app/(dashboard)/reservations/actions.ts#L620),
[:1125](src/app/(dashboard)/reservations/actions.ts#L1125)), שהוא true לכל
סטטוס פרט ל-`cancelled` (D126) — כלומר `false` מגיע רק במעבר לביטול.

**‏`nightsRuleViolation` ([rules.ts:138](src/lib/rates/rules.ts#L138)) הוא
ולידטור לקוח בלבד** — תת-קבוצה **מכוונת** של הוולידטור המשותף: אורך שהות
בלבד, בלי CTA/CTD/stop_sell. אתר הקריאה היחיד שלו הוא ה-`nightsViolation`
של הגריד. **היעדרו מקבצי ה-actions אינו מעיד על היעדר אכיפה** — השרת אוכף
סט **רחב יותר**, דרך הוולידטור המשותף. הפער שכן קיים בין שני הסטים נרשם
ב-D154; ייבוא ה-OTA, שבאמת אינו מוודא דבר, נרשם ב-D153.

> **תיקון (2026-08-18, D153).** הפסקה שמעליה **שגויה בעובדה המרכזית שלה**.
> אכיפת min/max-stay בשרת **קיימת**, וקיימת גם ב-`createReservationAction`
> וגם ב-`public-booking/create-booking.ts` — היא פשוט לא עוברת דרך
> `nightsRuleViolation`. השרשרת היא
> `validateAndPriceStays` → `priceReservationStays` → `calculateReservationPrice`
> → `stayRestrictionViolationStructured`
> ([engine.ts:363](src/lib/pricing/engine.ts#L363)), וההפרה נחסמת ב-
> `firstEnforcedError` ([reservation-pricing.ts:168](src/lib/pricing/reservation-pricing.ts#L168))
> כי `MIN_STAY_NOT_MET` ו-`MAX_STAY_EXCEEDED` נמצאים ב-`RESTRICTION_CODES`
> ושני אתרי היצירה מעבירים `enforceRestrictions: true`.
>
> מה שכן נכון בפסקה: `nightsRuleViolation` הוא אכן לקוח-בלבד ואין לו אף
> אתר קריאה בשרת. אבל **הוא לא אמור לאכוף** — הוא תת-קבוצה מכוונת שבודקת
> אורך בלבד ולא CTA/CTD/stop_sell
> ([rules.ts:131-137](src/lib/rates/rules.ts#L131-L137)), כדי שפקיד קבלה
> יוכל להזין הזמנה ידנית בתאריך סגור. השרת מפעיל את הוולידטור המלא.
> העדרו מהשרת הוא תכנון, לא פער.
>
> הפער האמיתי שהאודיט מצא הוא אחר לגמרי — ייבוא Beds24 — ומתועד ב-D153.
> הרשומה הזו נשארת כלשונה כדי שהמסלול שהוביל למסקנה השגויה יישאר גלוי.

**השומר.** ‏`check:calendar-ui` מחזיק את טבלת האמת המלאה (עוגן
`2026-07-17`, חמישה מקרים: ‏0/‏+1/‏+2/‏-1/‏-2)
([check-calendar-ui.mjs:100-113](scripts/check-calendar-ui.mjs#L100-L113)).
הטסט עודכן **לפני** הקוד ו-4 מתוך 5 המקרים נפלו על המימוש הישן; המקרה
החמישי (משבצת בודדת) עבר משום ששני המודלים מסכימים עליו — אין שם רגרסיה
להוכיח.

### פתוח — לא הוכרע: דאבל-קליק מותח בשקט, גרירה חוסמת

שני מסלולי יצירה מאותו גריד מטפלים בשהות מתחת למינימום **הפוך**, ואף
אחת מהתנהגויות לא הוכרעה כנכונה:

| מסלול | קוד | סאב-מינימום |
|---|---|---|
| דאבל-קליק | `addDays(date, Math.max(1, minNights))` ([CalendarGrid.tsx:847](src/app/(dashboard)/calendar/CalendarGrid.tsx#L847)) | **מותח בשקט** למינימום המשבצת |
| גרירה | `createRangeTarget` + `nightsViolation` ([CalendarGrid.tsx:805-809](src/app/(dashboard)/calendar/CalendarGrid.tsx#L805-L809)) | **חוסם בהודעה**, לא מאריך |

הקומנט ב-[CalendarGrid.tsx:794-797](src/app/(dashboard)/calendar/CalendarGrid.tsx#L794-L797)
מצהיר שההארכה-בשקט נדחתה במפורש כהכרעת בעלים ("סאב-מינימום חייב להיחסם
בהודעה, לא לגדול בשקט, כדי שהאכיפה תהיה גלויה ברגע הבחירה") — אבל ההכרעה
הזו חלה על מסלול הגרירה בלבד, והדאבל-קליק עושה בדיוק את מה שהיא שוללת.
הפער קדם ל-D152 ולא נסגר בה; הוא נרשם כאן כפריט פתוח, לא כהכרעה.

**הפער רחב מהכרעת-הבעלים.** הדאבל-קליק אינו רק סוטה מההכרעה — הוא עוקף
את שער האורך כולו. `nightsRuleViolation` (ב-`rules.ts`, דרך `nightsViolation`
ב-`CalendarGrid.tsx`) מעריכה שלושה שדות: `min_stay_arrival` ו-`max_stay` על
תאריך ההגעה, ו-`min_stay_through` כמקסימום על **כל** הלילות התפוסים. מסלול
הדאבל-קליק אינו קורא לה כלל; הוא נשען על ערך סקלרי יחיד שנגזר מ**תא ההגעה
בלבד** — `Math.max(min_nights, min_stay_through)` של אותו תא, המחושב באתר
הקריאה ב-`CalendarGrid.tsx` ומועבר כ-`minNights` ל-`onCellDouble`. לכן טווח
שמפר `min_stay_through` על לילה מאוחר יותר בטווח שנמתח אוטומטית, או שחורג
מ-`max_stay` (שאינו נכנס לסקלר הזה כלל — ההארכה רק מגדילה, לעולם לא בודקת
תקרה), נפתח בפאנל ההזמנה ללא כל התנגדות בצד הלקוח.

**ואין בדיקת התנגשות.** `onCellDouble` אינו קורא ל-`rangeInvalid`, ולכן
ההארכה האוטומטית יכולה לחפוף שהות חוסמת קיימת או סגירת חדר. השומר שהוסף
במיגרציה 037 תופס זאת בשרת ולכן אין השחתת נתונים — אבל המשתמש מקבל פאנל
הזמנה מלא ואז דחייה, במקום חסימה ברגע הבחירה.

| | גרירה (`onCellPointerUp`) | דאבל-קליק (`onCellDouble`) |
|---|---|---|
| בניית הטווח | `createRangeTarget` — הבחירה הגולמית כפי שהיא | `addDays(date, Math.max(1, minNights))` — מתיחה אוטומטית |
| בדיקת אורך | `nightsViolation` על שלושת השדות, חוסם ב-`toast.error` | אין — סקלר יחיד מתא ההגעה, `max_stay` ו-through מאוחר לא נבדקים |
| בדיקת התנגשות | `rangeInvalid`, חוסם ב-`toast.error` | אין — מתגלה רק בשרת |

הציטוטים בשלוש הפסקאות והטבלה שמעל הם לפי שם סימבול + שם קובץ, ללא מספרי
שורה, במכוון: מספרי שורה ברשומה הזו כבר נרקבו פעמיים.

commit: `4f9002aa` · ענף מקור: `fix/calendar-range-semantics` @ `c53f3de`

## D153 — ייבוא OTA נכתב ללא ולידציית מגבלות שהות, במכוון (2026-08-18)

**ההכרעה.** הזמנות נכנסות מ-Beds24 נכתבות **ללא ולידציית מגבלות שהות
כלשהי**. [booking-import.ts:554](src/lib/channel/booking-import.ts#L554)
מכניס ישירות ל-`reservation_rooms`; שינוי הזמנה קיימת הוא
`DELETE` ([:467](src/lib/channel/booking-import.ts#L467)) ואחריו אותו
`INSERT` — גם הוא ללא ולידציה, כולל כשהתאריכים החדשים שונים לגמרי.
‏`pricing_snapshot` נשאר NULL, ו-`is_manual_rate` + `price_mode='manual_night'`
מסמנים "לא תומחר ע"י המנוע": מחיר הערוץ סמכותי להזמנה של אותו ערוץ, ואין
ציטוט מנוע שאפשר לצלם ([:548-552](src/lib/channel/booking-import.ts#L548-L552)).

זהו הנתיב **היחיד** מבין ארבעת נתיבי הכתיבה ל-`reservation_rooms` שאינו
עובר ב-`validateAndPriceStays`/`priceReservationStays`.

**הנימוק.** ההזמנה **כבר קיימת אצל הספק**. דחייה מקומית לא מבטלת אותה —
היא יוצרת פאנטום: האורח מחזיק אישור מ-Booking.com, והמערכת שאמורה לנהל
את השהות אינה מכירה בה. בבחירה בין רשומה שמפרה מגבלה מקומית לבין אורח
שמגיע לנכס בלי רשומה, הרשומה עדיפה.

**ההגנה האמיתית היא מונעת, לא חוסמת.** מה שאמור למנוע הזמנת OTA מפרה
הוא הקרנת ה-ARI כלפי Beds24 — הספק לא אמור למכור מלכתחילה
([beds24-ari-projection.ts:257-258](src/lib/channel/beds24-ari-projection.ts#L257-L258)).

**הנגזרת שחייבת להיאמר במפורש:** כל תקלה בהקרנת ה-ARI — טווח שלא נדחף,
עבודה תקועה, ערך שהתפרש לא נכון — מתורגמת **ישירות** להזמנות שמפרות
מגבלות, **בלי שום רשת ביטחון במורד הזרם**. אין שלב שני שיתפוס אותן.
לכן כשל ARI אינו תקלת סנכרון בלבד; הוא כשל אכיפה.

**ההגנות היחידות שכן חלות על הנתיב הזה** הן ברמת ה-DB, ושתיהן אינן
נוגעות באורך שהות מסחרי:
- `CHECK (check_out > check_in)` — לפחות לילה אחד
  ([000_init_schema.sql:264](db/migrations/000_init_schema.sql#L264))
- ‏`rr_no_double_booking` — ‏exclusion constraint נגד חפיפת שתי שהויות
  חוסמות על אותו חדר
  ([037_double_booking_guard.sql:89-96](db/migrations/037_double_booking_guard.sql#L89-L96))

## D154 — פער CTA/CTD/stop_sell בין הגריד לשרת במסלול הידני (2026-08-18)

**פתוח — טעון הכרעה מסחרית. לא הוכרע כאן.**

**הפער.** [rules.ts:131-137](src/lib/rates/rules.ts#L131-L137) מצהיר
במפורש שפקיד קבלה רשאי להזמין ידנית על תאריך סגור או stop-sold, ולכן
`nightsRuleViolation` הוא תת-קבוצה שבודקת **אורך בלבד** — והגריד אכן חוסם
על אורך בלבד. אבל `createReservationAction` מעביר `enforceRestrictions: true`
**ללא תנאי** ([actions.ts:316](src/app/(dashboard)/reservations/actions.ts#L316)),
ואין במנוע שום הסתעפות לפי `source`: הערך `"manual_reservation"` משמש
כמטא-דאטה בסנאפשוט בלבד ולא נבדק באף תנאי לאורך מסלול המגבלות.

**התוצאה — באג פעיל וניתן לשחזור.** פקיד שיבחר תאריך CTA או stop-sold
יעבור את חסימת הגריד (האורך חוקי), יגיע לשרת, ויידחה עם
`CLOSED_ON_ARRIVAL` או `ROOM_CLOSED` ‏(`STOP_SELL` ממופה ל-`ROOM_CLOSED`
עם תאריך, [engine.ts:365](src/lib/pricing/engine.ts#L365), ונחסם תחת דגל
המגבלות ב-[firstEnforcedError:164-167](src/lib/pricing/reservation-pricing.ts#L164-L167)).
כלומר המערכת מזמינה אותו לבחור מה שהיא תסרב לשמור.

**שתי הכרעות אפשריות:**

1. **הכוונה המתועדת נכונה** — פקיד קבלה גובר על סגירה מסחרית. אז השרת
   צריך להסתעף לפי `source` ולהתיר CTA/CTD/stop_sell במסלול הידני, בעוד
   הבוקינג הציבורי והערוצים ממשיכים לאכוף את הסט המלא.
2. **הכוונה התיישנה** — סגירה מסחרית מחייבת גם את הפקיד. אז
   [rules.ts:131-137](src/lib/rates/rules.ts#L131-L137) והגריד צריכים
   לאכוף את הסט המלא, כדי שהחסימה תופיע ברגע הבחירה ולא אחרי השמירה.

הרשומה אינה מכריעה ואינה ממליצה בין השתיים — ההבדל ביניהן הוא מדיניות
מסחרית (מי גובר על סגירה), לא שאלה טכנית.


## D155 — יחידת ההנחה "₪ להזמנה" חוזרת כיחידה מן המניין; ארבע היחידות וסדרן מוקפאים (2026-08-18)

**ההכרעה.** יחידת ההנחה `amount_total` ("₪ להזמנה") מוחזרת כיחידה מן
המניין ב-`DISCOUNT_UNITS`, וארבע היחידות **וסדרן** מקובעים בשומר
`check:discount-units`. הסדר — שהוא גם סדר ה-DOM וגם, ב-RTL, הסדר הנראה
מימין לשמאל:

1. `amount_per_night` — "₪ ללילה" (‏`הנחה ללילה (₪)`)
2. `amount_total` — "₪ להזמנה" (‏`הנחה להזמנה (₪)`)
3. `percent_total` — "% להזמנה" (‏`אחוז הנחה להזמנה (%)`)
4. `percent_per_night` — "% ללילה" (‏`אחוז הנחה ללילה (%)`)

**למה.** ההסרה ב-#180 סתרה את SPEC ס-2 ועברה ללא שומר.
[SPEC.md ס-2](docs/booking-window/SPEC.md) הכריע במפורש **ארבע** יחידות
(המוק מציג שלוש, ו-‏₪ להזמנה היא היחידה שהוא משמיט) — ו-#180 הסיר בדיוק
אותה מרשימת הלשוניות המוצעות. אף בדיקה לא נדלקה, כי לא היה שומר על
הרשימה.

**מה לא השתנה — היחידה מעולם לא הוסרה מן המערכת, רק מן המסך.**
‏`amount_total` קיים במלואו לאורך כל השכבות, ולכן ההחזרה היא שינוי UI
בלבד:

- הטיפוס: `DiscountMode` ([totals.ts:22-31](src/lib/pricing/totals.ts#L22-L31))
- המנוע: חישוב `discountCents` ([totals.ts:101-115](src/lib/pricing/totals.ts#L101-L115))
- ה-DB: ה-CHECK של מיגרציה 058, ובנוסף `amount_total` הוא ה-DEFAULT של
  העמודה

אין מיגרציה, אין שינוי בשרת, אין שינוי במנוע החישוב, ואין נגיעה בזהות
החישובית של `percent_total` מול `percent_per_night`.

**מה ההסרה השאירה מאחור, ומדוע נמחק.** #180 לא מחק את היחידה אלא הפך
אותה ל-passthrough: קבוע `LEGACY_AMOUNT_TOTAL` שהוזרק לרשימה בזמן רינדור
דרך `unit === "amount_total" ? [...DISCOUNT_UNITS, LEGACY_AMOUNT_TOTAL]`.
השארת ההזרקה לצד ההחזרה הייתה מייצרת **לשונית כפולה** בדיוק בהזמנות
שמחזיקות `amount_total`. לכן הקבוע וההזרקה נמחקו, והשומר אוסר את התבנית
‏`[...DISCOUNT_UNITS,` בקובץ — לא רק את הקבוע הישן.

**השומר.** `check:discount-units`
([scripts/check-discount-units.mjs](scripts/check-discount-units.mjs)) —
סטטי בלבד, fail-closed: אם `DISCOUNT_UNITS` אינו ניתן לאיתור או לפירוק
כליטרל, השומר נכשל. הוא אוכף ארבעה איברים, את רצף ה-`value` המדויק, את
שמונה התוויות (label + fieldLabel) ואת איסור ההזרקה. B2 מובנה: הוולידטור
רץ מחדש מול שמונה מוטנטים של הקובץ האמיתי (החלפת סדר, מחיקת איבר, איבר
חמישי, שינוי תווית, החזרת ההזרקה, ספרד לא-ניתן-לפירוק) — מוטנט שעובר =
כשל הריצה.

**קיבוע הסדר הוא מכוון.** `Segmented` מרנדר את `options` בסדר המערך, ואין
בקוד שום `sort` ושום קונפיג סדר — כלומר המערך **הוא** סדר הלשוניות על
המסך. לכן השומר מקפיא רצף, לא רק חברוּת.

**פריט פתוח — לא לביצוע כאן:**
`scripts/render-pricing-evidence.mjs` אינו רשום ב-`package.json` ואינו רץ
באף מסלול (לא בסוויטה, לא ידנית דרך `pnpm`). כלי הראיות התמחירי הזה קיים
בריפו ואינו מופעל. נרשם כדי שלא יילקח כמכוסה; ההכרעה אם לחווט אותו,
לתעד אותו כארכיון או למחוק אותו — לא נעשתה כאן.


## D156 — טיהור המשתמשים: הפרודקשן צומצם לשני חשבונות; הייחוס נשמר ב-session_info (2026-08-24)

**ההכרעה.** הפרודקשן צומצם ל**שני חשבונות בלבד**:
`r@bios.co.il` (‏`super_admin`) ו-`efratmax76@gmail.com` (‏`admin`). כל השאר
נמחקו מחיקה קשה בטרנזקציה אחת — **7 שורות `guesthub.users` ו-13 שורות
`auth.users`**. פער המספרים אינו טעות: ‏6 מן השורות ב-GoTrue היו **יתומות
מלכתחילה** — זהות אימות חיה בלי משתמש אפליקטיבי מקביל, בדיוק התסמונת
שהשומרים ב-[D157](#d157) נועדו למנוע. בין הנמחקים היה גם **`super_admin` שלישי
שלא היה ידוע** — `liorfeld@gmail.com`, לא-חסום ועם התחברות Google מאופשרת.

**החלטת הייחוס — למה `session_info` מכיל `actor_email=`.** מחיקת משתמש מנתקת
את שורות הביקורת שלו מכל זהות. לפני המחיקה, **144 שורות `audit_logs`** שנכתבו
בידי המשתמשים הנמחקים עודכנו כך שיישאו את זהות הפועל בטקסט:

    actor_email=…; actor_username=…; actor_deleted_at=…

הערכים **צורפו** לעמודה `session_info` דרך `concat_ws`, כך ש-**14 מחרוזות
user-agent קיימות נשמרו** ולא נדרסו. זהו המקור היחיד ל-`actor_email=` בשורות
הללו — מי שיפגוש את התבנית בעתיד ימצא כאן את ההסבר.

**שתי חלופות נשקלו ונדחו:**

1. **מיגרציית `jsonb`** — עמודת ייחוס מובנית. נדחתה: מיגרציה סכימתית לטובת
   אירוע חד-פעמי, בטבלה שהיא לדג'ר לכל דבר.
2. **כתיבה לתוך `after_data`** — נדחתה: `after_data` הוא **תיעוד המצב שהפעולה
   יצרה**. הזרקת מטא-דאטה על מבצע הפעולה לתוכו מזהמת את משמעות השדה ומרעילה
   כל קריאה עתידית של הלדג'ר.

`session_info` הוא שדה טקסט חופשי שממילא מתאר את **הקשר הפעולה**, ולכן הצירוף
בו אינו משנה את משמעות שום שדה קיים.

**עוגן החזרה.**
`/var/backups/guesthub/pre-user-purge-20260823T143530Z.sql.gz` — צולם לפני
המחיקה, מחוץ לעץ הריפו.

**תוצאה ידועה, במכוון.** המפעיל הוא כעת ה-`super_admin` **היחיד**. לפי כללי
הדירוג, ה-`admin` ששרד **אינו יכול** לנהל אותו, לאפס לו סיסמה או לשחזר אותו:
אין בפרודקשן שום חשבון שני שמסוגל להשיב גישה אם החשבון הזה יאבד.

**פריט פתוח — לא הוכרע כאן.** קידום החשבון השני ל-`super_admin` (או הקמת חשבון
שחזור ייעודי) הוא **החלטה נפרדת ופתוחה**. הרשומה מתעדת את הסיכון ואינה
מכריעה בו.


## D157 — שומרי ה-seed שואלים את ה-DB, לא את ה-env; ובלי שום מעקף (2026-08-24, ‏#208 + #209)

**ההכרעה.** `scripts/seed.mjs` מריץ שני שומרים **מול מסד הנתונים עצמו**,
שניהם **לפני ה-TRUNCATE**:

- **CHECK A — חשבונות זרים.**
  [`assertNoForeignUsers`](scripts/seed.mjs) מסרב אם קיימת ב-`guesthub.users`
  ולו שורה אחת שה-seed אינו יוצר. הבדיקה **קטגורית**: רשימת ההיתר נגזרת
  בזמן ריצה מ-`SEED_USER_DEFS` + `OWNER.email` (‏`SEED_EMAILS`), **אין בקוד
  שום כתובת מוקשחת** ואין חריג לאף אדם. שורה בלי כתובת נחשבת זרה — כי לכל
  חשבון seed יש כתובת, ולכן שורה כזו היא של מישהו אחר.
- **CHECK B — טננט הפרודקשן.**
  [`assertNoProductionTenant`](scripts/seed.mjs) מסרב אם `PROD_TENANT_ID`
  (‏`68139d06-…`) נוכח ב-`guesthub.tenants`.

שניהם **fail-closed**: שגיאת DB אינה "עבר" אלא סירוב — מסד שלא ניתן לקרוא הוא
מסד שלא ידוע מה יושמד בו. `42P01`/`3F000` (הסכימה עוד לא קיימת) הם המקרה
היחיד שעובר, כי אין שם מה להשמיד.

**למה בדיקת DB ולא בדיקת env.** השומר הישן קרא **מחרוזות בלבד**: סמן ה-env
‏("bios-vps") יושב במשתמש החיבור מתוך **מקרה תפעולי**, לא מתוך הצהרה. שינוי
pooler או מעבר דומיין (‏`stayme.co.il`) היה מפיל את ההתאמה **בשקט**, והשומר
היה מכריז "לא פרודקשן" על הפרודקשן. הבדיקה החדשה שואלת **מה יש בקצה השני**,
לא **איך התחברנו** — וזה ההבדל היחיד שחשוב לפני TRUNCATE.

**אין דגל מעקף, אין משתנה סביבה, במכוון.** הסירוב אינו ניתן לביטול משום מסלול.
מי שרוצה לזרוע העתק פרודקשן משוחזר חייב **לשנות ידנית ובמודע את מזהה הטננט**
בעותק שלו. הרציונל: ערוץ מעקף היה משחזר **בדיוק את החולשה שהשומרים סוגרים** —
שומר שאפשר לכבות בדגל אינו שומר אלא תזכורת, ובלילה שבו הוא באמת נחוץ מישהו
יכבה אותו כדי "להתקדם".

**החיווט.** `check:seed-safety`
([scripts/check-seed-safety.mjs](scripts/check-seed-safety.mjs)) חובר לחבילת
הבדיקות ב-#209. ‏`run-checks.mjs` מגייס אוטומטית כל מפתח `check:*` מ-
`package.json`, ולכן ההוספה ל-`package.json` **היא** החיווט.

**אי-יעילות ידועה ומקובלת.** הבדיקה מסווגת `db-backed` ולכן מקבלת שיבוט
scratch של המסד — שהיא **לעולם אינה נוגעת בו** (היא סטטית ומבוססת הזרקה).
העלות ידועה, נרשמת כאן, ואינה מוצדקת בסיווג ידני שיצטרך תחזוקה משלו.


## D158 — "נראה לאחרונה" = פעולה אחרונה, לא התחברות ולא נוכחות (2026-08-24, ‏#207)

**שורש הבעיה — לא רגרסיה של הטיהור.** על `auth.users` מופעל RLS **בלי אף
policy**. המשמעות המעשית: המשתמש `guesthub_app` קורא את הטבלה כ**ריקה**. ה-
`LEFT JOIN` הישן החזיר `last_sign_in_at = NULL` לכל שורה, תמיד — כלומר העמודה
**מעולם לא עבדה**, מיום היוולדה. העובדה שהיא נראתה שבורה אחרי
[D156](#d156) היא צירוף מקרים, לא נזק שנגרם שם.

**התחליף.** [staff/page.tsx](src/app/(dashboard)/staff/page.tsx) מחשב
`last_seen_at` דרך `LEFT JOIN LATERAL` על `max(audit_logs.created_at)` לכל
משתמש, **מסונן לפי טננט** (‏`al.user_id = u.id AND al.tenant_id = u.tenant_id`).
אין תלות ב-`auth.users`, **אין מיגרציה**, ואין עמודה חדשה.

**חוזה סמנטי — מפורש, כדי שלא ייקרא לא נכון.** העמודה אומרת **הפעולה
האחרונה**, ולא:

- לא **התחברות אחרונה** — משתמש שנכנס ולא עשה דבר לא יזוז.
- לא **נוכחות** — שימוש לקריאה בלבד אינו מעדכן אותה, כי הוא אינו כותב
  `audit_logs`.

זהו trade-off מכוון מול החלופה — מיגרציה שמוסיפה עמודת חותמת ומסלול כתיבה
ייעודי. נדחתה: היא מוסיפה כתיבה לכל בקשה כדי לענות על שאלה שהלדג'ר כבר עונה
עליה בקירוב טוב דיו למסך צוות.

**`auth.users` נשאר בלתי-קריא ל-`guesthub_app` — בבחירה.** ה-RLS ללא policy
הוא מחסום שלא נפתח כאן, ולא ייפתח כתופעת לוואי של עמודה במסך. אם יידרש בעתיד
מידע התחברות **אמיתי**, זו משימה נפרדת שצריכה להכריע במפורש מי מקבל גישה
לטבלת האימות ובאיזה היקף.


## D159 — ‏6 ההפרות של המודול המוקפא נרשמות כ-baseline; השומר חוזר לירוק בלי לגעת בקוד הקפוא (2026-08-25)

**ההכרעה (נבחר בסשן 25/08 ואושר בדיעבד ע"י הבעלים ב-27/08).** שש ההפרות ב-`MyTasksScreen.tsx` נרשמות בקובץ
‏[scripts/check-design-system.baseline](scripts/check-design-system.baseline)
כ**חוב מוצהר-קפוא**, ‏`check:design` חוזר ל-**ירוק**, וכל הפרה **חדשה** — בכל
מקום, לרבות באותו קובץ ותחת אותו כלל — מאדימה כרגיל.

**שלוש האפשרויות שהיו על השולחן, ולמה נבחרה השלישית:**

1. **לתקן את השורות.** נפסל: המודול מוקפא בהחלטת בעלים ב-STATE.md —
   *"מודול ניקיון/משימות מוקפא לפי החלטת הבעלים — ממתין לאיפיון UI מהבעלים;
   לא לגעת עד הודעה חדשה."* תיקון פירושו עריכת קוד שממתין לאיפיון שעשוי
   לשכתב אותו ממילא.
2. **להשאיר אדום קבוע.** נפסל: שומר שאדום תמיד מפסיק להיות סיגנל. אחרי
   שבועיים איש אינו קורא את הפלט, וההפרה ה-7 נכנסת בלי שאיש ישים לב — בדיוק
   הכישלון ש-`check:design` נועד למנוע.
3. **‏baseline — נבחר.** החוב נכתב, נספר ומקבל שם; כל השאר נאכף במלואו.

**ייחוס הבחירה — דיוק שנוסף ב-27/08.** האפשרות השלישית **נבחר בסשן 25/08 ואושר בדיעבד ע"י הבעלים ב-27/08**. הרישום
המקורי הציג אותה כ"החלטת בעלים" בזמן שהבעלים לא נשאל; ההנחיה שקדמה לה
הייתה **לתקן** את השורות. האישור בדיעבד ניתן במפורש ("המסך ממילא מיועד
לאיפיון מחדש") יחד עם קביעה שהדרך הייתה שגויה — ומכאן **כלל ברזל 12**
ב-AGENTS.md וב-CLAUDE.md. ההקפאה עצמה ב-STATE.md, לעומת זאת, היא החלטת
בעלים אמיתית ואינה משתנה כאן.

**מה בדיוק נרשם.** שש ההפרות נולדו עם הקובץ ב-`b82eac2` (‏2026-07-21) כשהשומר
כבר היה דלוק על אותם כללים בדיוק — כלומר **חוב מקורי, לא רגרסיה** (נמדד ב-#210
בהרצת השומר על שני עצים היסטוריים). חמש `font-size` ואחת `radius`.

**המפתח — הפרה בודדת, לא דלי.** רשומה מזוהה לפי ארבעה שדות:

    rule | file | detail | שורת המקור המנורמלת

שורת המקור אינה קישוט: **שתיים מן השש הן `text-base` באותו קובץ עם אותו
`detail` בדיוק** (שורות 173 ו-196), והשדה הרביעי הוא הדבר היחיד שמבדיל ביניהן.
מפתח לפי קובץ+כלל, או ספירה לפי קובץ+כלל, היה מאחד אותן — ואז הפרה שביעית
באותו קובץ הייתה נבלעת ברשומה קיימת. זה הכישלון שהמנגנון כולו קיים כדי למנוע.

**מספרי שורות אינם חלק מן המפתח, במכוון.** ההתאמה על תוכן: הקובץ מוקפא, אך
ה-baseline לא ייפול על הזזה לא-קשורה. מנגד — עריכה של השורה המפרה **עצמה**
מייתמת את הרשומה מיד, וזה בדיוק הרצוי במודול מוקפא.

**רצ'ט — ה-baseline יכול רק להצטמצם.** שתי אכיפות סימטריות:

- רשומה שאינה מתאימה לכלום → הריצה **נכשלת** עם
  ‏`stale baseline entry, remove it`. אי אפשר להשאיר רשומות מתות שיבלעו הפרות
  עתידיות.
- רשומה **נצרכת**: רשומה אחת משתיקה **מופע אחד**. הפרה זהה שנייה נותרת אדומה.

**אין ערוץ כתיבה — אין `--update-baseline`, אין רגנרציה.** מודע ומכוון:
‏baseline שריצה יכולה לשכתב אינו רצ'ט אלא כפתור "תשתיק". ההוספה של רשומה היא
מתן רישיון להפר את מערכת העיצוב, ולכן היא **חייבת** לעבור החלטת בעלים ולא
להתרחש כתופעת לוואי של הרצה. הקובץ נערך ביד או שאינו נערך.

**מה לא נעשה** — כל אחד מאלה היה הופך את ה-baseline למעקף:

- אין החרגה של `MyTasksScreen.tsx` או של תיקיית `housekeeping` מן הסריקה.
- אין allowlist ברמת כלל או ברמת קובץ.
- ‏`ds-allow:` לא הורחב, ולא נשתלו סמנים בקובץ הקפוא.

**‏B2 מובנה.** המתאם מורץ מחדש בכל ריצה מול מקרים סינתטיים — התאמה מדויקת,
הפרה חדשה מאותו כלל באותו קובץ, מופע כפול מול רשומה אחת, שתי רשומות לשתי
שורות, הזזת מספר שורה, רשומה יתומה, וארבעה near-miss (כלל/detail/שורה/קובץ
שונים). כשל של אחד מהם = כשל הריצה, כך שהמנגנון אינו יכול להירקב בשקט בזמן
שה-baseline האמיתי עדיין נראה עובד.

**תוכנית היציאה.** כשהבעלים יאפיין מחדש את מסך הניקיון, ההפרות מתוקנות עם
העבודה ההיא והשורות נמחקות מן ה-baseline. כשהשורה האחרונה נמחקת — הקובץ נמחק;
השומר מתייחס ל-baseline חסר כאל ריק, ולכן המחיקה אינה דורשת שינוי קוד.

---

## D160 — סגירת ריצת ה-doctor, יישור STATE.md, ושדרוג האבטחה (2026-08-27)

ריצת אחזקה אחת שסגרה שלושה אדומים בסוויטה, שדרגה את שרשרת האספקה, ויישרה
שני מסמכי-אמת שהתיישנו. נרשמת כי חלק מן ההכרעות כאן הן החלטות בעלים שאסור
שיישארו רק בהיסטוריית ה-shell.

### ‏1. ‏`/doctor` אינו סקיל — ולכן אין מה "להתקין" בו

‏`/doctor` הוא **פקודת אבחון מובנית של Claude Code**, לא סקיל שמותקן ולא
תוסף. אין ולא היה `~/.claude/skills/doctor`; מה שנרשם ב-`skillUsage`
כ-`doctor` הוא ריצת הפקודה המובנית מ-14/08. לכן השאלה "האם הותקן טוב"
נענית: **אין התקנה שיכולה להישבר** — מה שהיה פתוח הוא רשימת הממצאים שלה,
שנסגרת כאן.

### ‏2. מה בוצע בסביבה (הכרעות בעלים, 27/08)

| ממצא | הכרעה | מצב |
|---|---|---|
| ‏snap `claude-code` מפרסם `pfsmorigo` — **לא Anthropic** (אין snap רשמי) | להסיר | הוסר (`snap remove`); snapshot נתונים נשמר, ניתן למחוק ב-`snap forget` |
| ‏CLI בטרמינל: `~/.local/…/@anthropic-ai/claude-code@2.1.197` — ‏50 גרסאות מאחור | לרענן ל-latest | ‏2.1.247, תואם לתוסף ה-VSCode |
| ‏6 סקילים באפס שימוש | לכבות את **כולם** | הועברו ל-`~/.claude/skills-disabled/` — **לא נמחקו**; חמישה מהם גם מגובים ב-`Ronus922/claude-skills` |
| ‏`defaultMode` לא מוגדר בשום scope | ‏`auto` | ב-`~/.claude/settings.json` |
| מחברי claude.ai ‏(Figma/higgsfield/Gmail/Calendar/Drive/Canva) ב-0 קריאות | לא הוכרע | ניתוק אפשרי רק דרך `/mcp` או claude.ai; ‏Gmail ו-Canva אף דורשים אימות מחדש |

**כיבוי ≠ מחיקה, במכוון.** הסקילים שכובו נבדקו אחד-אחד למקורם לפני הכיבוי:
‏`humanizer` הוא חבילה חיצונית (‏symlink ל-`~/.agents/skills`, credits @blader),
וחמשת האחרים נכתבו ידנית ומקומטים ב-repo פרטי. הכיבוי הוא העברת תיקייה
והחזרה היא העברה חזרה.

### ‏3. שלושת האדומים שנסגרו

- **‏`check:design`** — ‏#212 (‏D159) מוזג. ‏6 ההפרות של המודול המוקפא רשומות
  ב-baseline; השומר ירוק בלי לגעת בקוד הקפוא.
- **‏`check:automation-design`** — לא באג: ארבעה קבצי `design-ref/` היו
  **מחוקים בעץ העבודה ולא מקומטים**, והשומר קרס ב-ENOENT על
  `whatsapp-automation.html`. שוחזרו מ-git; ‏135 מאפיינים נמדדים שוב.
- **‏`check:no-secrets`** — ‏#213. הפטור לפיקסטורה הוא **פר-שורה עם נימוק**
  (`no-secrets-allow:`), לא הוספת קובץ ל-`ALLOW`. ראה את ה-PR לנימוק המלא.

### ‏4. שדרוג האבטחה — ‏#214

‏7 התרעות high ב-`pnpm audit --prod`, **כולן בגרף הפרודקשן**: ‏`next` ‏15.5.20
(‏DoS ב-Server Actions + שני ‏SSRF), ‏`sharp` ‏0.34.5 ‏(4 CVE ב-libvips),
‏`postcss` ‏8.5.16 (‏path traversal), ‏`nanoid` ‏3.3.15. ‏`next` עלה ל-15.5.24
ושלוש התלויות העקיפות ננעלו ב-overrides.

**ה-overrides מוגבלים ל-major (`^`) במכוון:** ‏`>=3.3.18` פתוח משך את nanoid 6,
שהוא ESM-only, לתוך `postcss` שדורש `require('nanoid/non-secure')` — שדרוג
אבטחה ששובר את ה-build אינו שדרוג.

### ‏5. ‏STATE.md — שלוש עובדות שהתיישנו

המסמך נשא מ-18/07 "מיקוד בלעדי בהסמכת Channex" בעוד ש-Channex הוסר כליל
ב-D91; הצהיר שניקיון/משימות מוסתרים בעוד ששני הלוחות גלויים מ-D88; והפנה
ל-`/tasks` שנמחק ב-D88.1. תוקן.

**המשפט של ההקפאה נשמר בנוסחו המדויק** — הוא מצוטט מילה במילה ב-
`scripts/check-design-system.baseline` וב-D159, ושינוי נוסחו היה מייתם את
הציטוט. מה שהשתנה הוא **ההיקף**: מה שקפוא היום הוא מסך העובד
`MyTasksScreen.tsx`, לא מודול הניקיון כולו.

בנוסף: שורת ה-Runtime ב-CLAUDE.md הפנתה ל-`/var/www/guesthub-production`
כ"prod נפרד" — תיקייה שאינה קיימת, בסתירה לפרק Production Runtime באותו
קובץ עצמו. תוקנה. **פריט פתוח:** ב-crontab יש שורה מוערת שמפנה לאותה
תיקייה; לא נגעתי ב-crontab.

### ‏6. פריטים שנמדדו ולא טופלו — במכוון

- **‏D156 (‏super_admin יחיד).** ההכרעה: **להשאיר ולתעד**. הפרודקשן מחזיק
  ‏super_admin אחד, ואין בו חשבון שמסוגל לאפס לו סיסמה או לשחזר אותו אם
  ייאבד. הסיכון מוכר ומקובל; אינו נסגר כאן.
- **‏247 שגיאות `inbound_quarantine` לא-פתורות** מ-03–04/08 ו-**15 ‏dead_letter
  jobs** מ-05/08 (‏`permission denied for guest_conversations`, שורש שנסגר
  ב-D144/מיגרציה 082). שאריות היסטוריות שאיש לא סימן כפתורות.
- **‏`ari_readback_oversell` פתוחה מ-07/08** — "‏Beds24 מוכר 1 לילות שתפוסים
  אצלנו". צריכה אימות חי: או שנפתרה ולא סומנה, או שיש חשיפה.
- **‏`Failed to find Server Action`** נצפה בלוג הפרוד גם ב-27/08 ‏03:38, ‏45
  שעות אחרי הפריסה — כלומר טאבים ישנים ממשיכים לירות פעולות מתות (‏D151).
  התאוששות בצד הלקוח לא נבנתה.
- **‏Node 20** — ‏`supabase-js` כבר מזהיר על deprecation; `engines` נעול
  `>=20 <21`.

---

## D161 — ל-`channel_sync_errors` יש מחזור חיים: רענון, ספירה וסגירה עצמית; והאזעקה מבחינה בין מיטה תפוסה לחדר שלא רצינו למכור (2026-08-27)

השורה ב-`channel_sync_errors` נכתבה פעם אחת ומאותו רגע קפאה. `alertOnce`
(‏D112, `beds24-ari-readback.ts`) דיכא במכוון כל חזרה כדי שסחיפה שנמשכת שבוע
לא תמלא את רשימת עשר השגיאות ב-`/channels` בהודעה אחת חוזרת — והדיכוי הזה
היה **שתיקה מוחלטת**: המחזור השני והשלוש-מאותים היו no-op. `resolved_at`
נסגר רק ביד. התוצאה: מסך שמדווח על בעיות שכבר לא קיימות, ושורה בת שבועיים
שאי אפשר לדעת אם ירתה פעם אחת או ירתה לפני שתי דקות.

בנוסף, ‏`numAvail: 0` הוא ערך אחד על החוט עם שתי משמעויות שונות לגמרי אצלנו,
ו-`beds24-ari-payloads.ts` משטח אותן לאותו מספר:
`available = physicallyAvailable && !stopSell && !blocked`. האזעקה קראה לשתיהן
"סכנת overbooking".

### ההכרעות (בעלים, 27/08)

| # | ההכרעה | הנימוק |
|---|---|---|
| 1 | הסוגר מוגבל ל-`ari_readback_*` ועל **אותו** `connection_id` בלבד | מחזור נקי מוכיח שהיומן שפורסם תואם עבור החלון של החיבור הזה — ולא אומר דבר על כשל ייבוא, על טוקן בחיבור אחר, או על שורה של יצרן אחר. סגירתן היא שקר שלמפעיל אין דרך להבחין בו |
| 2 | ‏300 השורות הקיימות אינן נוגעות | אין backfill: איש לא ספר את הופעותיהן, והמצאת מונה מ-`created_at` היא בדיה. שלוש שורות ה-readback הפתוחות ייסגרו מעצמן במחזור הנקי הראשון — מראיה אמיתית, לא מ-`UPDATE` במיגרציה |
| 3 | הרענון נשען על עמודות אמיתיות: `occurrence_count` + `last_seen_at` | ‏086. שורה אחת לכל (חיבור, קוד) נשמרת — הרשימה עדיין לא יכולה להצפה — אבל היא נושאת מעתה את ההודעה, ההקשר והחלון של **המחזור הנוכחי**, מונה צפיות, וחותמת אחרונה |
| 4 | הספירה מתפצלת לפיזי מול מסחרי | `availability = 0` (תפוס/סגור) → `oversellCells`; `stopSell` / חסימת תוכנית / ללא מחיר → `commercialBlockCells`. הפיצול נגזר מ**אותו** חצי `availability` של הפרויקציה שבונה ה-payload קרא — אפס שאילתות חדשות |
| 5 | ההבחנה בין "תפוס" ל-OOO **נדחית** | ההודעה אומרת "תפוסים/סגורים אצלנו". אין שינוי ב-`AvailabilityRow` ואין עמודות פרויקציה חדשות: שתיהן מיטה שאי אפשר למכור, וההבדל אינו משנה את הפעולה שהמפעיל צריך לעשות |
| 6 | מסלול היציאה השקט בכשל טוקן נסגר | כותב מעתה שורת ledger `failed` + אזעקה `ari_readback_failed` עם `context.stage = "token"`. שני המסלולים השקטים האחרים (אין מיפויים / אין תאים) **נשארים שקטים**, ובכוונה: "אין מה להשוות" הוא באמת אין-מה-לדווח, ולא כישלון להסתכל |

### למה הפיצול הוא ההכרעה החשובה כאן

חדר ריק שלא מכרנו כי התוכנית פגה הוא **לא** overbooking — אי אפשר לשכן שני
אורחים בחדר ריק. הקריאה הישנה תייגה שבעה לילות ריקים כ"סכנת overbooking" כל
‏20 דקות, וזו בדיוק הדרך שבה מפעיל לומד להתעלם מן האזעקה האחת שמסמנת מיטה
אמיתית. מעתה: `oversell` (פיזי) → `ari_readback_oversell`; מסחרי בלבד →
`ari_readback_commercial`; השאר → `ari_readback_drift`. **קוד אחד והודעה אחת
למחזור, לפי הגרוע ביותר שנמצא** — מחזור שמחזיק את שניהם הוא מחזור overbooking,
והפיצול המדויק תמיד נוסע ב-`context`.

### שתי ההודעות מסתיימות בפעולה (הכרעת בעלים, 27/08)

```
oversell:   Beds24 מוכר N לילות שתפוסים/סגורים אצלנו — סכנת overbooking — הרץ סנכרון מלא
commercial: Beds24 מוכר N לילות שחסומים אצלנו מסחרית (stop-sell או ללא מחיר) —
            פער מסחרי, לא סכנת double-booking — הרץ סנכרון מלא לגישור
```

אבחנה בלי הוראה שולחת את המפעיל לחפש הוראה. **התרופה זהה בשני המקרים** —
כפתור "סנכרון מלא" ב**אותו מסך** שבו האזעקה מופיעה
(`channels/Beds24Section.tsx`), שמצהיר מחדש את היומן הקנוני מול Beds24 —
וההבדל בין השתיים הוא **דחיפות, לא תרופה**. הנוסח אומר את זה: ב-oversell זו
פקודה, ובפער המסחרי זה גישור.

הנוסח הזה נעוץ ב-`check:beds24-ari-readback` **במלואו** (‏`assert.equal` על
המחרוזת כולה, לא `match` על תת-מחרוזת) בשני התרחישים — ‏5 ו-`S-physical`.
נעיצה חלקית הייתה ממשיכה לעבור אילו ההכוונה נושרת שוב, וזו בדיוק התקלה
שההכרעה הזאת באה לתקן.

בהיעדר ידיעה — כשה-`diff` נקרא בלי הפרויקציה ביד — הסיבה מדווחת כ**מסוכנת**,
לעולם לא כשקטה. תא שחסר מן המפה נחשב פיזית-תפוס, בדיוק כמו ה-`?? 0` של בונה
ה-payload, כך ששני החצאים אינם יכולים לחלוק.

### נקודת הסגירה, במדויק

`comparedCells > 0 AND requests > 0 AND errors.length === 0 AND driftCells === 0`.
כל גרסה חלשה יותר סוגרת מתוך בורות: עמוד חלקי (שגיאה + חלק מן הישויות) מגיע
ל-`diff` עם תאי `missing` ולכן לעולם אינו מגיע לכאן, והמסלולים הכושלים והשקטים
חזרו הרבה קודם. אף פעם לא סוגרים במסלול כושל, במסלול חלקי או ביציאה שקטה.

### אינטראקציה עם ה-retention

`purge_channel_sync_errors` (‏043) מוחקת שורות **פתורות** אחרי 30 יום ולא-פתורות
אחרי 180. סגירת שורה מעבירה אותה אל השעון הקצר — במכוון: אזעקה סגורה היא
היסטוריה, וה-`channel_evidence_ledger`, לא הטבלה הזאת, הוא השובל העמיד.
**ה-purge היא פונקציה, לא לוח זמנים** — שום דבר אינו קורא לה בטיימר היום, ולכן
אין כאן מחיקה מתוזמנת שנוצרה יש-מאין.

### שינוי מכוון בתרחיש 5 של `check:beds24-ari-readback`

שבעת הלילות ללא מחיר בתרחיש 5 נבדקו עד היום כ-`oversellCells = 7`. מעתה
`commercialBlockCells = 7`, ‏`oversellCells = 0`, קוד `ari_readback_commercial`.
**זהו שינוי הכרעה, לא תיקון באג בבדיקה**, והוא מסומן ככזה בקוד הבדיקה עם
הפניה להחלטה הזאת. הטענה המקורית של התרחיש — שמחיר-שארית אצל הספק בתאריך חסום
אינו סחיפה — נשארת בתוקף ולא נגעו בה. תרחיש 3 עבר **ללא שינוי** בטענותיו
המקוריות והורחב בטענות `occurrence_count` / `last_seen_at`.

חמישה תרחישים חדשים (`S-close`, `S-noclose-failed`, `S-noclose-partial`,
`S-physical`, `S-411`), כל אחד עם הוכחת מוטציה בתקן B2: הפרדיקט מנוטרל
בארטיפקט המהודר, התרחיש חייב **למות**, הקובץ מוחזר ומאומת ב-sha256.

---

## D162 — ייבוא OTA מדווח על מגבלות שהות ולעולם לא חוסם (2026-08-18, אושר ע"י הבעלים 2026-08-28)

**רקע — D153.** ‏D153 תיעדה את המצב שקדם להכרעה הזאת: ייבוא OTA
נכתב ללא שום ולידציית מגבלות שהות, **במכוון**. הרשומה הזאת אינה
מבטלת אותה ואינה סותרת אותה — היא ממשיכה אותה, ומחליפה את
"לא נבדק כלל" ב"נבדק, מדווח, ולעולם לא חוסם". אי-החסימה עצמה
נשארת בדיוק כפי ש-D153 קבעה; מה שנוסף הוא הדיווח.

**הרקע.** אודיט שיצא מ-D152 מיפה את כל נתיבי יצירת השהות. חמישה מתוך שישה
מוגנים במלואם. הנתיב היחיד שאינו מוגן הוא **ייבוא Beds24**:
[booking-import.ts:554](src/lib/channel/booking-import.ts#L554) עושה
`INSERT` ישיר ל-`reservation_rooms` בלי לעבור ב-`priceReservationStays`
או ב-`calculateReservationPrice`. ההערה שהייתה שם תיעדה כוונה לגבי
**מחיר** ("the channel's price is authoritative") ושתקה לגבי מגבלות שהות.

**ההכרעה.** הייבוא **רץ תמיד ומצליח תמיד**, גם כשהשהות מפרה min/max-stay.
ההזמנה כבר קרתה בערוץ; דחיית הייבוא לא מבטלת אותה — היא רק מסתירה חדר
שנמכר. שתי התוצאות שזה מייצר — אורח שמגיע בלי רשומה, וחדר שנמכר פעמיים —
גרועות מהפרת מגבלה.

**אבל הוא בודק ומדווח.** הפרה שמגיעה מ-OTA היא עדות לתקלה אמיתית: או
שההקרנה ל-Beds24 פרסמה מגבלה שגויה, או שמישהו עקף אותה ידנית באקסטרא-נט.
שניהם דורשים ידיעה. עד היום המידע נזרק — המנוע מחשב את ההפרה ורושם אותה
ב-`roomErrors` גם כשהאכיפה כבויה, והייבוא פשוט לא הסתכל.

**המימוש.** `reportOtaRestrictionViolations`
([ota-restriction-report.ts](src/lib/channel/ota-restriction-report.ts))
קורא ל-`calculateReservationPrice` — קריאה טהורה, `engine.ts` לא מכיל אף
`INSERT`/`UPDATE`/`DELETE` — מסנן ל-`RESTRICTION_CODES`, וכותב לשניים:

| יעד | למה |
|---|---|
| `channel_sync_errors`, קוד `OTA_STAY_RESTRICTION_VIOLATION` | מוצג במסך הערוצים כשורה לא-פתורה ([admin.ts:59-65](src/lib/channel/admin.ts#L59-L65)), וניתן לסימון כטופל דרך `resolved_at` |
| `channelAudit`, פעולה `channel_import_restriction_violation` | היסטוריה קבועה על ההזמנה עצמה |

**המחיר של הערוץ נשאר סמכותי** — הצעת המחיר של המנוע נזרקת במכוון.

**אי-אפשרות להפיל את הייבוא.** המודול בולע את שגיאותיו ומחזיר מערך ריק,
ואתר הקריאה עוטף אותו ב-`try/catch` נוסף. אובדן הדיווח רע; אובדן ההזמנה
גרוע יותר.

**`RESTRICTION_CODES` יוצא** מ-`reservation-pricing` כדי שרשימת הדיווח לא
תוכל להיפרד מרשימת האכיפה.

**הידוק נלווה מאותו אודיט — אינווריאנט `skipChecksForRr`.** זהו הדילוג
היחיד בתפר שלא מייצר שום שגיאה: הקורא בונה את ה-set בהשוואה בין הקלט
לשורה השמורה ([actions.ts:565-578](src/app/(dashboard)/reservations/actions.ts#L565-L578)),
ודריפט בהשוואה היה מעביר בשקט שהות שתאריכיה השתנו — מעבר לבדיקות
הזמינות וגם מעבר לבדיקות המגבלות. השומר קורא את התאריכים המחויבים
**מה-DB** ולא מההשוואה של הקורא, ולכן הוא בלתי תלוי בלוגיקה שעליה הוא
שומר. שהות שדילגה חייבת לתפוס בדיוק את הטווח המחויב שלה, אחרת
`INVALID_DATE_RANGE`.

**השומר.** `check:ota-restriction-report` — חמישה תרחישים: ייבוא תקין
עובר נקי; ייבוא שמפר min-stay **נכתב וגם מסומן** (כולל אימות שהשורה
בפועל לא-פתורה ונושאת את `reservation_id`); כשל בבדיקה לא מפיל ולא מייצר
רעש; שהות שדילגה עם תאריכים זהים עוברת; שהות שדילגה עם תאריכים שהשתנו
נחסמת.

**סייג תשתית נמדד.** הסוויטה יוצרת DB זמני משלה בשרת המבודד (`:5433`)
ומוחקת אותו בסיום. ה-DB המשותף שם צבר דריפט וצ׳יין המיגרציות כבר לא
עולה עליו — `check:pricing-equality` נכשל עליו כרגע באותה מיגרציה (005,
`channex_room_type_id`). הצ׳יין **כן** עולה נקי על DB טרי (71 טבלאות),
כך שזו תקלת סביבה ולא רגרסיית מיגרציה. לא טופלה כאן.

---

## D163 — אכיפת מגבלות שהות בשכבת ה-DB: נבחנה ונדחתה (2026-08-18)

**ההכרעה.** אין ולא יהיה `CHECK`, טריגר או constraint שמשווה את מספר
הלילות של שהות מול `min_stay_arrival` / `min_stay_through` / `max_stay`.
זו **החלטה, לא חוב** — כדי שלא תחזור כממצא באודיט הבא.

**הנימוק.**

1. **`min_stay` אינו מאפיין של השהות אלא של שורת תעריף** — הוא משתנה לפי
   תאריך ולפי תוכנית תמחור, וה"מינימום החל" הוא ה-MAX על פני כל הלילות
   התפוסים ([rules.ts:76-90](src/lib/rates/rules.ts#L76-L90)). `CHECK`
   פועל על שורה אחת ואינו יכול לבטא זאת.
2. **טריגר היה חוסם בדיוק את שני המקרים הלגיטימיים** — ייבוא OTA (D162)
   וחריגה ידנית מכוונת של פקיד קבלה ([rules.ts:131-137](src/lib/rates/rules.ts#L131-L137)).
   רשת ביטחון שחוסמת את מה שהוחלט במפורש להתיר אינה רשת ביטחון.

**מה כן קיים ב-DB.** `CHECK (check_out > check_in)` בלבד
([000_init_schema.sql:246](db/migrations/000_init_schema.sql#L246),
[:264](db/migrations/000_init_schema.sql#L264),
[005:219](db/migrations/005_phase3_channel_foundation.sql#L219)).
ה-`CHECK`ים על `min_stay_*` ב-[016_rate_plans.sql:219-221](db/migrations/016_rate_plans.sql#L219-L221)
הם על **טבלת התעריפים** (`>= 1`) ולא על השהות — הם לא אוכפים דבר על
הזמנה.

**היכן האכיפה כן יושבת.** בשכבת האפליקציה, נקודה אחת:
[engine.ts:363](src/lib/pricing/engine.ts#L363), שדרכה עוברים חמישה
מתוך שישה נתיבי היצירה. הששי הוא ייבוא OTA, ועליו חלה D162.

---

## D164 — ‏247 שורות ה-quarantine הן הזמנה אחת שכבר יובאה; נסגרות כממצא, לא כתקלה (2026-08-28)

**הרקע.** ‏`/channels` הציגה 247 שורות `inbound_quarantine` פתוחות. אודיט
read-only מלא (‏28/08) מצא ש-**כולן שייכות להזמנה אחת**: `booking_id`
בודד `90904497`, ‏`revision_id` בודד `90904497:2026-08-03T22:04:38Z`
(‏Expedia, ‏`ota_reservation_code` 2503722138). לא 247 בעיות — בעיה אחת
שנרשמה 247 פעם.

**למה 247 ולא אחת.** נתיב ה-quarantine ב-
[booking-import.ts:812-819](src/lib/channel/booking-import.ts#L812-L819)
קורא ל-`logChannelError` **הגולמי**
([queue.ts:162](src/lib/channel/queue.ts#L162)) — `INSERT` ללא שום דיכוי.
‏`alertOnce` (‏D161) חי **רק** ב-`beds24-ari-readback.ts` ואינו חל כאן. לכן
sweep ההתכנסות, שמנסה מחדש כל ~5 דקות, רשם שורה חדשה בכל מחזור: ‏12 לשעה
במשך ~21 שעות רצופות, ‏03/08 22:09 → 04/08 18:50.

**מה עצר את זה — ולא מיגרציה.** הסיבה הייתה `התנגשות מקומית בחדר` על
06–07/08 בחדר 1424. יומן הביקורת מתעד מפעיל אנושי: `reschedule` על השהות
החופפת ב-18:53:11, ‏`request_full_sync` ב-18:53:25, ו-`channel_import_create`
ב-18:55:09. מאותו רגע — אפס שורות חדשות (נמדד:
`count(*) filter (where created_at >= '2026-08-05') = 0`).

> **תיקון עובדתי שנרשם במפורש:** מיגרציה 082 **אינה** קשורה. היא הוחלה
> ‏08/08 15:32, ארבעה ימים **אחרי** השורה האחרונה, ועניינה
> ‏DEFAULT PRIVILEGES (‏D144). ייחוס העצירה אליה היה שגוי.

**גורל ההזמנה — יובאה במלואה.** הרוויזיה היום `import_status='imported'`,
‏`attempts=247`, ‏`mapping_error` NULL, מקושרת להזמנה `ccb2f46b` (#1085,
‏`checked_out`). התאמה מלאה ל-payload: `arrival`/`departure` = `check_in`/
`check_out` (‏06→07/08), ‏`roomId 707492` דרך מיפוי `mapped` = חדר 1424
שבהזמנה, `numAdult 2` = `adults`, ‏`price 769.37` = `total_price`.
**אפס הזמנות חסרות, אפס חשיפה עתידית.** השהות היסטורית — האורח כבר עזב.

**המחיר התפעולי שהצדיק את הסגירה.** רשימת השגיאות היא
`ORDER BY created_at DESC LIMIT 10`
([admin.ts:65](src/lib/channel/admin.ts#L65)) — ולכן **7 מתוך 10 המשבצות**
של המפעיל היו תפוסות ע"י ההזמנה המתה הזאת, ומסתירות 7 בעיות אמיתיות
שונות (‏422 validation מ-28/07, ‏`cancellation_reconciled`, ועוד). רשימה
שידוע שהיא מיושנת — מפסיקים לקרוא.

**ההכרעה.** כל 247 השורות **בטוחות לסגירה, אפס חריגים**:

1. התנאי שיצר אותן הופרך בראיה — ההזמנה יובאה, לא נשארה בעיה פתוחה.
2. הסגירה אינה מחמשת שום דיכוי, כי אין דיכוי בנתיב הזה מלכתחילה.
3. הכרטיס `quarantined_revisions` שבמסך נשען על טבלה אחרת
   (`channel_booking_revisions`) ועומד ממילא על 0 — הוא לא יזוז.
4. ההשפעה היחידה היא שעון הרטנציה: `purge_channel_sync_errors(30, 180)`
   (מיגרציה 043) מעביר שורה סגורה מ-180 יום ל-30 — ואין לו timer כלל
   (נבדק: `crontab` ו-`systemctl list-timers`), כך שבפועל דבר לא נמחק.

**מצב הביצוע — בוצע.** הסגירה רצה ‏2026-08-28 **20:07:33** UTC באישור
בעלים — טרנזקציה מפורשת, בלי מחיקה ובלי כיווץ. אומתה מול הפרודקשן
ב-2026-08-29:

| מה נמדד | ערך |
|---|---|
| שורות הרוויזיה | **247** — מתוכן עדיין פתוחות **0** |
| ‏`resolved_at` — ערכים מובחנים | **1** (‏20:07:33.107465 UTC) — כלומר כתיבה אחת |
| ‏`occurrence_count` שנגעו | **0** |
| ‏`last_seen_at` שנגעו | **0** |
| סך השורות בטבלה | **300** — אפס מחיקות |
| פתוחות בסך הכול אחרי הסגירה | **50** |
| שורות quarantine חדשות מאז 04/08 18:50 | **0** |

חותמת זמן יחידה ל-247 השורות היא הראיה שזו הייתה כתיבה אחת ולא סדרה.
הראיה נשמרה במלואה, והמונים לא זזו: ‏086 אינה עושה backfill במכוון,
ושורות אלה מעולם לא נספרו.

> **תיקון גבול — הנוסח שנרשם כאן תחילה היה שגוי, והוא עצר ריצת סגירה.**
> הרשומה רשמה `created_at <= '2026-08-04'`. הליטרל נפתר ל-
> `2026-08-04 00:00:00+00`, ולכן הוא תופס **23 שורות בלבד**: ‏23 נוצרו
> ב-03/08 (האחרונה 23:59:58.5) ו-**224 ב-04/08 עצמו** (הראשונה 00:05:00.6).
> שלושה תנאים מחזירים 247 מדויק (נמדד מחדש 29/08): ה-`revision_id`
> **לבדו**, ‏`created_at < '2026-08-05'`, או
> `created_at::date <= date '2026-08-04'`. הריצה בפועל נרשמה עם
> ה-`revision_id` היחיד + `created_at < '2026-08-05'`, ועם אכיפת
> `rowcount = 247` בתוך הטרנזקציה לפני `COMMIT`.
>
> **אפס over-capture** — נמדד, לא הונח: ‏247 שורות ה-quarantine הן **כל**
> שורות ה-quarantine בטבלה, ו-`count(distinct revision_id) = 1`.

**החוב שנשאר פתוח ולא הוכרע כאן:** נתיב ה-quarantine עדיין חסר דיכוי.
אם תנאי דומה יחזור, הוא ישחזר את אותו הצפה של 12 שורות בשעה. החלת דפוס
`alertOnce` של D161 גם על היצרן הזה היא שינוי התנהגות שדורש הכרעה נפרדת.

---

## D165 — ‏super_admin שני: אפרת מקס מקודמת דרך ה-UI, לא דרך SQL (2026-08-28)

**ההכרעה.** ‏`efratmax76@gmail.com` (‏`d0518219`, `admin` בעת ההכרעה) מקודמת
ל-`super_admin`, כדי שהטננט יחזיק **שני** מנהלי-על פעילים במקום אחד.
הנימוק אינו נוחות אלא שחזור הדדי: כל עוד `r@bios.co.il` הוא ה-super_admin
היחיד, אין אף חשבון שיכול לשחזר אותו.

**הקידום מתבצע דרך מסך הצוות, ולא בכתיבת SQL ידנית.** זו עצם ההכרעה
כאן. נבדקה השרשרת המלאה מול actor=בעלים (`super_admin`), target=אפרת
(`admin`), תפקיד חדש `super_admin`, וכל שער בה מתיר את הפעולה:

| שער | הסיבה שהוא מתיר |
|---|---|
| `requirePermission(actor,"staff.update")` | [permission-check.ts:14](src/lib/auth/permission-check.ts#L14) — `actor.roleKey === "super_admin"` עוקף בדיקה גרנולרית |
| `canManageTarget` | [guards.ts:20-22](src/lib/auth/guards.ts#L20-L22) — `rank('admin')=2 <= rank('super_admin')=3` |
| `canChangeRole` (‏לא-עצמי) | [guards.ts:50](src/lib/auth/guards.ts#L50) — `d0518219 ≠ db214c1c` |
| `canAssignRole` | [guards.ts:39](src/lib/auth/guards.ts#L39) — `rank(new) > rank(actor)` הוא `3 > 3` = **false**, ולכן אינו חוסם |
| `assertControlsRole` / `assertControlsUser` | [guards.ts:70](src/lib/auth/guards.ts#L70) — `PROTECTED_ROLE_KEYS.includes('super_admin')` מחזיר `ok` מיידית |
| הדרופדאון עצמו | [EmployeeSidePanel.tsx:99-103](src/app/(dashboard)/staff/EmployeeSidePanel.tsx#L99-L103) מסנן ב-`canAssignRole(...).ok` — "מנהל-על" **מוצג** |

**למה זה נרשם כהחלטה ולא כפעולה טכנית.** הפיתוי היה להריץ
`UPDATE guesthub.users SET role_id = …` מול הפרודקשן. זה נדחה: כשהאפליקציה
עצמה מתירה את הפעולה, כתיבה ידנית עוקפת את יומן הביקורת שהאפליקציה כותבת,
ומייצרת רשומת `role_changed` מזויפת או חסרה. **כתיבה ידנית ל-`users` היא
מוצא אחרון לשערים חסומים בלבד** — וכאן אף שער אינו חסום.

**מצב הביצוע — בוצע.** הקליק נעשה, ואומת מול הפרודקשן ב-2026-08-29:

| מה נמדד | הערך |
|---|---|
| תפקיד אפרת | **`super_admin`** (‏`94bcc607`), ‏`is_active = true` |
| `users.updated_at` | ‏2026-08-28 **20:12:23.375738** UTC |
| שורת ביקורת | ‏20:12:23.**381667** UTC — ‏`update` על `entity_type=user`, actor `r@bios.co.il`, ‏`role_id` מ-‏`814354dc` (`admin`) ל-‏`94bcc607` (`super_admin`) |
| super_admin פעילים | **2** — ‏`r@bios.co.il` ‏+ ‏`efratmax76@gmail.com` |

פער ששת המילישניות בין `updated_at` לשורת הביקורת הוא ההוכחה שהנתיב שנבחר
כאן הוא זה שרץ בפועל: העדכון והביקורת נכתבו באותה בקשה. ‏SQL ידני היה
מזיז את `updated_at` ומשאיר את יומן הביקורת ריק.

**מה שהשתנה בפועל.** אפרת עוברת את השערים שבהם `admin` **אינו**
מספיק: `canManageChannels` ([guards.ts:129](src/lib/auth/guards.ts#L129),
שם נכתב במפורש ש-`admin` לא כשיר), `canManageMessaging` ו-`canManageTTLock`
([settings/page.tsx:46,55](src/app/(dashboard)/settings/page.tsx#L46)) —
ומקבלת יכולת לנהל את חשבון הבעלים. שחזור הדדי מושג.

---

## D166 — שורת quarantine אחת פתוחה לכל רוויזיה, לא שורה לכל מחזור sweep (2026-08-29)

**ההכרעה.** נתיב ה-quarantine ב-
[booking-import.ts](src/lib/channel/booking-import.ts) מפסיק לקרוא
ל-`logChannelError` הגולמי ועובר ל-`logQuarantineOnce`: לפני INSERT הוא
מחפש שורה **פתוחה** עם אותו `tenant + connection + error_code` **ואותו
`context->>'revision_id'`** — אם יש, הוא מרענן אותה (‏`occurrence_count + 1`,
‏`last_seen_at = now()`, ההודעה הנוכחית) במקום להוסיף. סמנטיקת ה-REFRESH
של 086 (‏D161) נשמרת: המפעיל רואה את המצב הנוכחי, מונה הופעות, ומתי
נראתה לאחרונה.

**זה סוגר את המנגנון של D164:** sweep ההתכנסות מנסה רוויזיה תקועה כל
~5 דקות, וכל ניסיון רשם שורה — הזמנה תקועה אחת ייצרה 247 שורות וקברה
7 בעיות אמיתיות מאחורי ה-`LIMIT 10` של רשימת המפעיל. מעכשיו: מחזור
ראשון = שורה, כל מחזור נוסף = ריענון של אותה שורה.

**האלטרנטיבה שנדחתה — `alertOnce` כמו-שהוא.** המפתח של `alertOnce` הוא
`error_code` בלבד, כי שגיאת readback מתארת **מצב אחד של החיבור** ושורה
אחת לקוד נכונה שם. ‏`inbound_quarantine` מתאר **‏N הזמנות תקועות
בלתי-תלויות** תחת קוד אחד: מיפתוח לפי הקוד לבדו היה ממזג שתי הזמנות
תקועות שונות לשורה אחת, שהריענון שלה דורס את הראיה של הראשונה —
המפעיל רואה `×2` ו-`booking_id` אחד, בלי דרך לדעת שקיימת שנייה.
**ההצפה הייתה מוחלפת באובדן שקט.** לכן המפתח כאן הוא הרוויזיה.

**מה זה לא פותר.** דיכוי לבדו לא היה מונע את הרשימה המשקרת של D164 —
רק מקטין אותה: ההזמנה יובאה ב-04/08 והשורה (אחת או 247) הייתה נשארת
פתוחה עד סגירה ידנית. החצי הסוגר הוא D167.

---

## D167 — ייבוא שהצליח סוגר את שורות ה-quarantine של הרוויזיה שלו, באותה טרנזקציה (2026-08-29)

**ההכרעה.** ‏`importNormalizedRevision` סוגר (`resolved_at = now()`) את
שורות ה-`inbound_quarantine` הפתוחות של הרוויזיה שהוא זה עתה ייבא —
**בתוך אותה טרנזקציה** של הייבוא, מיד אחרי `markRevisionImported`.

**זה החצי שהיה מונע את D164 בפועל.** נמדד: הכתיבה האוטומטית
היחידה ל-`resolved_at` בכל שכבת הערוצים הייתה `resolveReadbackAlerts`,
מוגבלת ל-`ari_readback_%`. שום דבר לא סגר `inbound_quarantine` — ולכן
כשההזמנה של D164 יובאה ב-04/08 18:55, השורות נשארו פתוחות **24 יום**,
עד סגירה ידנית ב-28/08. דיכוי (D166) לבדו היה משאיר שורה מיושנת אחת
במקום 247 — רשימה שעדיין משקרת, רק בשקט. העיקרון של 086 חל: רשימה
שידוע שהיא מיושנת — מפסיקים לקרוא.

**למה בתוך הטרנזקציה ולא אחריה.** האינווריאנט של קובץ הייבוא הוא
ש-"imported" גורר שמור-בעמידות באותה טרנזקציה. סגירה אחרי ה-COMMIT
הייתה פותחת שני מצבים רעים: כשל בסגירה היה מפיל את ה-catch הכללי
ומסמן `failed` רוויזיה שכבר יובאה, וחלון שבו ההזמנה יובאה אך עדיין
מוצגת כתקועה. בתוך הטרנזקציה — שתי העובדות מתחייבות יחד או כלל לא.

**תחום, בכוונה צר** — כמו `resolveReadbackAlerts`: רק החיבור הזה, רק
`inbound_quarantine`, רק הרוויזיה הזאת. ייבוא מוצלח אינו ראיה על שום
שורה אחרת, וסגירה רחבה ממנו הייתה שקר שהמפעיל לא יכול להבחין בו.

---

## D168 — הזוג של D166/D167 חל גם על `inbound_import_failed` (2026-08-29)

**ההכרעה.** נתיב הכשל הכללי של הייבוא — `markRevisionFailed` +
שורת `inbound_import_failed` — מקבל את אותו זוג בדיוק: דיכוי במפתח
רוויזיה (ההלפר הוכלל ל-`logImportErrorOnce` עם פרמטר קוד), וסגירה
אוטומטית של שני הקודים בטרנזקציית ייבוא מוצלח.

**הבסיס העובדתי, לא רק סימטריה:** ה-sweep מנסה מחדש
`IN ('pending', 'quarantined', 'failed')`
([beds24-booking-import.ts:396](src/lib/channel/beds24-booking-import.ts#L396)) —
רוויזיה שנכשלת שוב ושוב מייצרת שורה כל ~5 דקות, מנגנון ההצפה של D164
אחד-לאחד. ההבדל היחיד: התנאי הזה טרם ירה בפועל (0 שורות
`inbound_import_failed` בטבלה, נמדד 29/08) — ולכן זו סגירה מונעת של
אותה מחלקת פגם, בעלות של הכללת פרמטר.

**שינוי לוואי מכוון אחד:** ה-context של שורת `inbound_import_failed`
מקבל גם `booking_id` (עד כה נשא `revision_id` בלבד) — יישור לשורת
ה-quarantine האחות. אין צרכן שנשען על היעדרו.

**הגבול נשאר:** רק שני הקודים שהמודול הזה עצמו מייצר לכל-רוויזיה.
`partial_warnings`, `validation`, קודי ה-readback וכל יצרן אחר — מחוץ
לתחום, מאותו נימוק של D167: ייבוא מוצלח אינו ראיה עליהם.

---

## D169 — כרטיס "הזמנות תקועות": מכסה גם רוויזיות `failed`, לא רק `quarantined` (2026-08-29)

**ההכרעה (בעלים).** הכרטיס ב-/channels שספר רק
`import_status = 'quarantined'` עובר ל-`IN ('quarantined', 'failed')`,
והתווית מתעדכנת ל"הזמנות תקועות (הסגר/כשל)".

**הפער שנסגר:** רוויזיה שנתקעה במצב `failed` (כשל טכני, לא הסגר) לא
הופיעה באף כרטיס — הכרטיס "עבודות שנכשלו" סופר jobs של סנכרון, לא
הזמנות — כך שהעדות היחידה לה הייתה שורת שגיאה ברשימה. מנקודת מבטו
של המפעיל שני המצבים זהים: הזמנה שקיימת אצל ה-OTA ולא נכנסה ללוח,
וה-sweep מנסה אותה שוב (שני המצבים נכללים ב-retry — D168). כרטיס
שסופר רק חצי מהן מדווח "0 תקועות" כשיש תקועה.

**היקף:** שני צרכנים בלבד (admin.ts + page.tsx), מסך פנימי, אפס
מיגרציה; ה-alias שונה ל-`stuck_revisions` כדי שהשם לא ישקר על התוכן.

---

## D170 — נקודת בריאות `/api/health`: ללא אימות, בודקת DB, חתומה ב-BUILD_ID; פטורה מה-middleware דרך דגל-נתיב (2026-09-04)

**ההכרעה (בעלים).** נתיב `GET /api/health` ב-`src/app/api/health/route.ts`,
ללא אימות, ללא קריאת cookies, ללא הקשר דייר, ללא PII וללא dump של env.
מחזיר `200 {"ok":true,"db":true,"build":"<BUILD_ID>"}` כאשר `SELECT 1` על
החיבור הקיים (`sql` מ-`@/lib/db`) עונה בתוך 2 שניות, ואחרת
`503 {"ok":false,"db":false}`. לעולם לא זורק: כשל בבדיקה הוא 503 עם שורת
לוג אחת, לא 500 עם stack. ‏`dynamic = "force-dynamic"` ו-`Cache-Control:
no-store`. ‏`BUILD_ID` נקרא מ-`.next/BUILD_ID` בזמן הבקשה, קריאה מצליחה
נשמרת ל-scope המודול לחיי התהליך (התהליך מתאפס בכל דפלוי), כשל = `"unknown"`.

**מנגנון הפטור — קיים, לא חדש.** ‏`src/middleware.ts` פוטר נתיבים חסרי-סשן
דרך דגלי-נתיב בוליאניים (`isOauthCallback`, `isMessagingWebhook`,
`isPublicBookingApi`) שמורכבים לתנאי ההפניה ל-`/login`. נוסף דגל רביעי,
`isHealth = path === "/api/health"` (התאמה מדויקת, בלי תת-נתיבים), לאותו
תנאי. **נדחה:** הוספת הנתיב ל-negative lookahead של ה-`matcher` — זה המנגנון
של נכסים סטטיים ו-manifest, לא של נתיבי API, והוא היה מכניס מנגנון שני
לאותה מטרה. המחיר של הבחירה: ה-middleware עדיין מריץ `supabase.auth.getUser()`
על כל בקשת health; בלי cookie זו קריאה מקומית שמחזירה `user=null` בלי
פנייה לרשת, זהה לנתיבי ה-webhook.

**מה חשוף ומה לא.** nginx (`sites-enabled/guesthub.bios.co.il`) מעביר את
`location /` כולו ל-3007 בלי rate-limit ובלי auth, ולכן הנתיב נגיש מהאינטרנט
בדיוק כמו `/api/public/*` (ראה NIGHT_AUDIT ח3). הוא חושף שלושה ביטים בלבד:
חי/לא, DB נגיש/לא, ו-BUILD_ID (מזהה build אקראי, לא commit ולא גרסה). כל
פגיעה = שאילתת `SELECT 1` אחת מה-pool (‏max 10). ‏nginx גם דורס את ה-
`Cache-Control` של האפליקציה ב-`no-store, must-revalidate` שלו, כך שמול
ה-origin ההדר מגיע מ-nginx ומול loopback מהנתיב — בשני המקרים no-store.

**סייג ידוע.** ‏porsager אינו מבטל שאילתה; ב-timeout הבדיקה מחזירה 503 אבל
ה-`SELECT 1` ממשיך לחכות ב-pool עד שיסתיים. תחת ניתוק DB ממושך ומוניטור
אגרסיבי זה עלול לתפוס חיבורים. אם זה יימדד — הפתרון הוא `limit_req` על
`/api/health` ב-nginx, לא שינוי בנתיב.

**אימות אחרי דפלוי (ידני):** ‏(א) `curl -s localhost:3007/api/health` →
‏200 עם שלושת השדות ו-`build` זהה ל-`cat .next/BUILD_ID`; ‏(ב) אותו URL מול
`https://guesthub.bios.co.il/api/health` → אותו גוף, ‏Cache-Control של
nginx; ‏(ג) מסלול ה-503 **לא נבדק** — הוא דורש ניתוק DB, ואין דרך בטוחה
לעשות זאת בפרודקשן; ההוכחה שלו היא קוד בלבד (`Promise.race` + `catch`).

---

## D171 — כותרות אבטחה ב-nginx + הגבלת קצב ל-`/api/health` (2026-09-04)

**ההכרעה (בעלים).** ארבע כותרות אבטחה נוספות ברמת nginx לבלוק
`guesthub.bios.co.il` / `stayme.co.il`: ‏`Strict-Transport-Security
"max-age=31536000; includeSubDomains"`, ‏`X-Content-Type-Options nosniff`,
‏`X-Frame-Options SAMEORIGIN`, ‏`Referrer-Policy strict-origin-when-cross-origin`,
כולן `always`, דרך snippet `/etc/nginx/snippets/guesthub-security-headers.conf`
שמוכלל ברמת ה-server ובתוך `location /`. ‏`/api/health` (D170) מקבל
`location = /api/health` עם `limit_req zone=health burst=10 nodelay` על
`limit_req_zone $binary_remote_addr zone=health:1m rate=30r/m` ברמת http{},
ועם **`limit_req_status 429` — התקבל**: מבדיל חסימת-קצב מה-503 של DB-down
שהנתיב עצמו מחזיר. אין `preload`.

**למה nginx ולא האפליקציה.** אף אחת מהכותרות לא נשלחה משום שכבה;
‏next.config.ts ללא `headers()`. ‏nginx הוא נקודת הכניסה היחידה של שלושת
השמות, ושינוי בו אינו דורש build ו-restart של Next.

**למה SAMEORIGIN ולא DENY.** מציג המסמכים ב-`BookingDocuments.tsx` ממסגר
ב-iframe את `/uploads/bookings/<id>/<name>` מאותו origin. ‏DENY היה שובר
אותו. שאר ה-iframes הם `srcDoc`+`sandbox` ואינם מושפעים; תצוגת ההדפסה
וה-PDF נפתחים בטאב חדש.

**למה includeSubDomains נשאר.** הכותרת מ-`guesthub.bios.co.il` חלה רק על
`*.guesthub.bios.co.il`, לא על pms/vps/invoice וכו' (אחים, לא צאצאים). אין שם
שירות; ה-wildcard DNS מוביל ל-catch-all של :80 בלבד. על ה-apex
`stayme.co.il` אין תת-דומיינים, אין wildcard ואין MX, וכל תת-דומיין עתידי
יעבור ב-Cloudflare. לא נמצא תת-דומיין http-only.

**מלכודת הירושה.** ‏`location /` מוסיף Cache-Control ולכן אינו יורש
`add_header` מרמת ה-server. ה-snippet מוכלל בשני המקומות. ‏`/_next/`
ו-`= /api/health` נשארים ללא `add_header` ויורשים; ה-`Cache-Control:
no-store` של הנתיב עובר כפי שהוא.

**יושם 2026-09-04 על ידי רונן.** קבצים: ‏`/etc/nginx/snippets/guesthub-security-headers.conf`
(חדש), ‏`/etc/nginx/sites-available/guesthub.bios.co.il` (גיבוי
`backup-<timestamp>` נשמר לצדו). **אומת:** ארבע הכותרות על `/login` ועל
`/api/health`; הגבלת הקצב — ‏10 × 200 ואז 429.

**סייגים.** דרך `stayme.co.il` ה-`$binary_remote_addr` הוא IP של Cloudflare,
כי אין `real_ip`; המוניטורים פוגעים ישירות דרך guesthub ולכן זה לא משנה
בפועל. **מחוץ להיקף, הכרעות נפרדות:** ‏`X-Powered-By`, ‏`server_tokens`,
‏Content-Security-Policy, ‏`real_ip` לטווחי Cloudflare.
