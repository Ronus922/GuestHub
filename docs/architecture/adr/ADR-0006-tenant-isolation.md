# ADR-0006 — Tenant isolation enforcement (H3)

- **Status:** Accepted (Stage 3) — approved by Agent A
- **Date:** 2026-07-18
- **Deciders:** Agents A, E, I
- **Context inputs:** `docs/security/THREAT_MODEL.md` (F2), `docs/audit/DOMAIN_INVENTORY.md` (#6), `db/migrations/000_init_schema.sql`, ADR-0002

## Context

GuestHub is multi-tenant. Today tenant isolation is enforced **entirely in application code** — every query is scoped by `actor.tenantId`, and there are **no Row-Level Security (RLS) policies** in the schema (defect H3). The Stage-1 threat model rated this High because a single missing `WHERE tenant_id = …` silently leaks cross-tenant PII, with no database backstop.

Key facts that shape the decision:
- The `guesthub` schema is **not exposed through PostgREST**; there is no browser-side direct DB access (migration `000` header + REVOKE from `anon`/`authenticated`). All data access is server-side through the `postgres` (porsager) driver.
- After Stage 2, the runtime connects as `guesthub_app` (a least-privilege DML role) — but that role is still a normal login role, and RLS is bypassed by the table owner, not by ordinary roles. RLS *could* therefore be enforced for `guesthub_app`.
- The app relies on a connection pool (Supavisor) shared across requests; a per-request `SET app.current_tenant` GUC would have to be set on every checkout and is fragile under session pooling.

## Decision

**Server-side scoping remains the canonical enforcement layer; it is hardened and made verifiable, and RLS is deferred (not adopted now) with an explicit re-evaluation trigger.**

1. **Canonical layer:** every data-access path scopes by `actor.tenantId`. This is the single source of truth for isolation.
2. **Verifiable backstop (this stage):** `check:pms-domain-invariants` asserts, against real data, that no row crosses a tenant boundary (reservation_rooms↔reservation, payments↔reservation, reservation_rooms↔room, reservation_cards↔reservation all share a tenant). This turns "we always scope correctly" from a claim into a continuously-checked invariant.
3. **Composite-key defense in depth:** where migrations already added composite `(tenant_id, id)` foreign keys (026/036-era), they stay; new cross-tenant-referencing tables should prefer composite FKs so the database rejects a cross-tenant link structurally. (Retrofitting composite FKs across all legacy tables is a larger migration — tracked, not done this stage.)
4. **RLS deferred, with a trigger:** RLS is **not** adopted now because (a) the schema is server-only (no untrusted direct DB client — the primary case RLS defends), (b) session-pooled connections make a per-request tenant GUC fragile, and (c) it would duplicate the enforcement without removing the need for correct server-side scoping. **Re-evaluate and adopt RLS if any of these change**: the schema is ever exposed via PostgREST/GraphQL; a browser/edge client ever connects to the DB directly; or a second, less-trusted service shares the database. This is recorded so the decision is not silently permanent.

## Consequences

- Isolation correctness is now guarded by a check (regression-safe), closing the "no backstop" part of H3.
- The `service_role`/owner credentials remain confined to trusted server code (Stage-2 role model; verified in Stage 6 red-team).
- If the RLS trigger conditions occur, this ADR is superseded by an RLS rollout ADR (policies per table + a tenant GUC set on connection checkout).
- Full red-team verification of authorization/tenant boundaries is Stage 6.
