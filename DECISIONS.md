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
