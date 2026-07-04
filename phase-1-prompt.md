# Phase 1 — DB + Auth + Shell

We are rebuilding the GuestHub PMS from scratch in this repository.

## Before writing any code

1. Read `PROJECT_OVERVIEW.md` in full. It is the single source of truth. Every rule in it is binding.
2. Look at `docs/design/screens/login.png` and `docs/design/screens/sidebar.png` — these are the visual references for this phase.
3. If an HTML reference exists under `docs/design/html/`, render it in a real browser first. Never implement from a thumbnail, loading shell, or unrendered bundle.

## Work mode — important

Work **autonomously, end to end, without stopping to ask questions**. Every decision you need is already in `PROJECT_OVERVIEW.md`. If a detail is genuinely unspecified, make the most conservative reasonable choice, document it in a `DECISIONS.md` file at the repo root, and continue. Return to me only when the entire phase is finished and all checks pass.

## Scope of this phase (and nothing beyond it)

1. **Full database schema** — one migration file creating ALL tables from section 6 of the overview:
   `tenants, users, roles, permissions, role_permissions, areas, room_types, rooms, guests, lookup_items, reservations, reservation_rooms, rates, payments, housekeeping_tasks, audit_logs, bulk_rate_update_logs, bulk_rate_update_items`.
   Indexes on every `tenant_id` and on `(room_id, check_in, check_out)` for reservations lookups.
2. **Seed** — exactly per section 20 of the overview: 1 tenant, 4 users (one per key role), full roles+permissions, 2 areas, 3 room types, 12–15 rooms (incl. one in maintenance, one inactive), 20 guests, 30–40 reservations across current month ±1 with overlaps and all statuses, partial rates (some dates intentionally without a rate), partial payments with balances, full lookup_items.
3. **Supabase Auth** — login page (`/login`) per the design reference: email/username + password, forgot password. Supabase is auth only; all data access goes through the plain Postgres driver (`lib/db.ts`, porsager `postgres`).
4. **Session middleware** — unauthenticated users are redirected to `/login`; authenticated users cannot see `/login`.
5. **Actor context** — a server-side `getActor()` that resolves session → `{ userId, tenantId, roleKey, permissions }`. Implement `requirePermission(actor, "module.action")` + `AuthorizationError` now; every future Server Action will start with it.
6. **App Shell** — `(dashboard)` layout with Sidebar (collapsible, per reference) + TopBar (minimal) + TenantProvider streaming actor context to the client. Cleaner role redirects to `/housekeeping/my-tasks` (placeholder page for now).
7. **No business screens.** Dashboard route shows an empty placeholder only.

## Hard rules for this phase

- TypeScript strict. RTL-first (`<html lang="he" dir="rtl">`, logical CSS properties).
- Tailwind v4 tokens in `app/styles/base.css` via `@theme inline` — no tailwind.config. Azure Ethos palette per overview section 16.
- Every query tenant-scoped. No hardcoded tenantId. No mock data.
- No unrelated refactors. Do not fake completion. Do not start Phase 2.
- Staged, isolated commits only — never `git add -A`.

## Definition of Done (all must pass before you report back)

```bash
tsc --noEmit && pnpm lint && pnpm build
```

Then start the app and verify: login works with a seeded user, shell renders, redirect rules work, no console errors, no hydration errors. Save a proof screenshot of the loaded shell to `docs/proof/phase-1-shell.png`.

## Final report (single message, only when everything is done)

1. Files changed (list)
2. Tables created + row counts of seed data
3. Auth/session flow — how it works
4. Actor/tenantId flow — how it works
5. Decisions made on unspecified details (from DECISIONS.md)
6. Output of typecheck/lint/build
7. Proof screenshot path
8. Any known limitations
