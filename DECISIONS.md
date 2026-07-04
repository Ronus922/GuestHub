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
