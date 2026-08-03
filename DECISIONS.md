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
