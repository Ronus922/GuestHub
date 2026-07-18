# GuestHub — Authorization & Tenancy

- **Status:** Skeleton — Stage 1; completed in **Stage 3**, verified in **Stage 6**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/ARCHITECTURE_INVENTORY.md` (§5), `docs/security/THREAT_MODEL.md` (§2, Assets D/F, F2), `docs/audit/DOMAIN_INVENTORY.md` (§1, §2.1)

Identity, session, actor resolution, RBAC, and how tenant isolation is enforced.

## Current state

Auth is Supabase GoTrue (session cookie via `@supabase/ssr`). Login accepts email or username (resolved to email from `guesthub.users`, active only), then `signInWithPassword`; errors are deliberately vague (`ARCHITECTURE_INVENTORY.md` §5). `src/middleware.ts` refreshes the cookie and gates every non-static request, with explicit bypasses for `/auth/callback` and the token-authenticated webhook routes. The actor is resolved server-side to a `guesthub.users` row + tenant + role + effective permissions in `getActor()` (`THREAT_MODEL.md` §1); every server action tenant-scopes by `actor.tenantId` and client-supplied tenant ids are never trusted. RBAC is complete for single-property: `users/roles/permissions/role_permissions` + per-user overrides (003), 6 seeded roles, pure and unit-checkable privilege-escalation guards (rank dominance, no self role-change, cannot grant a permission you lack) (`THREAT_MODEL.md` Asset D; `DOMAIN_INVENTORY.md` §2.1).

Security-relevant weaknesses spanning Stage 3 (fix) and Stage 6 (red-team verify): **tenant isolation has no DB-level backstop** — no RLS, and the pooled privileged role would bypass RLS anyway; a single missing `tenant_id` predicate silently leaks another tenant's data (High, F2). `admin`/`super_admin` bypass all granular permission checks by design — a compromised admin session is unbounded within its tenant (F5). Channel `*-admin.ts` helpers have thin local auth — Stage 6 must confirm none is reachable unauthenticated (F5). No app-layer login rate-limiting/lockout (F3). The environment-crossover Critical (F1) — dev checkout can point at the prod DB — is the tenancy/runtime integrity concern resolved structurally by the Stage-2 dedicated clusters.

## Target state

- Canonical authz model documented; the RLS-vs-server-side-only decision per access path recorded as a Stage-3 ADR addendum (`TARGET_ARCHITECTURE.md` §6, H3).
- Audit read surface + append-only enforcement by grant/trigger not convention (ADR-0001, Stage 3).
- MFA/2FA for operators (`PMS_GAP_MATRIX.md` §14, HV Stage 3).
- Stage 6 red-team: verify `*-admin.ts` reachability, login lockout behavior, least-privilege DB roles (ADR-0002 four roles).

## To be completed in Stage 3 (verified Stage 6)

- [ ] Auth/session/actor-resolution sequence diagram.
- [ ] RBAC model + escalation-guard invariants table.
- [ ] Tenant-isolation strategy decision (RLS vs server-side-only) as ADR addendum (H3).
- [ ] Least-privilege DB roles mapping (from ADR-0002).
- [ ] Stage-6 verification checklist (helper reachability, lockout, DB backstop).
