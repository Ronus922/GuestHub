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

**Hooks.** `writeRateCells` (the ONE path the Rate Grid and Bulk Update share) marks rates+restrictions per room, never availability. Rate Plan mutations mark the plan **plus its transitive children** (a derived plan's price is computed from its parent's resolved price) on their assigned rooms, and — on an assignment change — on the rooms observed *before* the write, so a dropped room is republished rather than forgotten. `savePlanOverridesAction`, which previously reached Channex not at all, marks its exact units/dates. Reservation create/modify/cancel/move mark old **and** new ranges; closures and room status mark availability over the published horizon (`ARI_HORIZON_DAYS = 500`, in the import-free `ranges.ts` so no save path pulls in the HTTP client).

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
