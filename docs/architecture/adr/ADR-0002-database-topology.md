# ADR-0002 — Dedicated database topology

- **Status:** Accepted (Stage 1) — approved by Agent A; primary input to Stage 2
- **Date:** 2026-07-18
- **Deciders:** Agents A, E, I
- **Context inputs:** `docs/audit/ARCHITECTURE_INVENTORY.md` (C1, C2, H4, H5), `docs/program/STATE.md`, V2 §9

## Context

Today GuestHub production and dev both point at one shared self-hosted Supabase stack (`supabase-db` container, Supavisor `:5432`) in schema `guesthub`, alongside unrelated apps (`pms`, `mail-system`, `sys-app`). This is the program's Critical C1 (environment crossover) and contributes to C2 (DB exposed past UFW), H4 (backup omits `auth`, no off-host copy) and H8 (PANs in shared DB). V2 §9 requires infrastructure **dedicated only to GuestHub**, with separate Production, Certification/Staging, and disposable test databases, least-privilege roles, and no unrelated data. The shared stack must not be modified/restarted/reconfigured (other apps depend on it). Host headroom: 109 GB disk free, 13 GB RAM available, 8 cores.

## Decision

**Dedicated PostgreSQL clusters per environment, reusing GoTrue only where authentication truly needs it — not a full Supabase stack per environment.**

Rationale (V2 §9 topology decision): GuestHub consumes from Supabase almost exclusively **GoTrue (auth)** and plain Postgres via the `postgres` (porsager) driver — it does **not** meaningfully depend on PostgREST, Realtime (it uses pg `NOTIFY`/SSE, D77), or Storage (uploads are local disk). A full Supabase stack per environment (Postgres + GoTrue + PostgREST + Realtime + Storage + Kong + Studio + analytics + vector) is heavy and operationally redundant. Therefore:

- **GuestHub Production DB:** a dedicated PostgreSQL cluster (own container/instance, own port, own data volume) owning schemas `guesthub` (+ `public`), plus a dedicated **GoTrue** bound to that cluster's `auth` schema so login relationships are preserved. Not the shared stack.
- **GuestHub Certification/Staging DB:** a completely separate dedicated Postgres + its own GoTrue, used for dev, Channex Staging, certification scenarios, Booking CRS, and realistic integration data.
- **Disposable test DB:** already exists as container `guesthub-testdb` (`:5433`); reused for destructive automated tests. Keep.

Auth topology: because GuestHub relies on GoTrue, each environment gets its own GoTrue pointed at that environment's `auth` schema; the migration/cutover tooling (Stage 2) must copy `auth.users` + identities together with `guesthub` data so logins survive. Backups must include the `auth` schema (fixes H4).

Roles (least privilege, V2 §9): `guesthub_owner` (migrations/DDL), `guesthub_app` (runtime DML only, owns nothing), `guesthub_readonly` (diagnostics), `guesthub_backup` (dump/restore). The runtime role must not own schema or migration objects.

Exposure: the dedicated clusters bind to localhost / the app network only; no `0.0.0.0` publish. The `DOCKER-USER` iptables gap (C2) is documented for Stage 6; the shared stack's binding is **not** changed by us (shared-infra rule) — instead GuestHub moves off it.

## Consequences

- Stage 2 provisions the two dedicated clusters + GoTrue, the four roles, the migration-replay-from-zero + data-copy + checksum + smoke + rollback tooling, and the cutover runbook — **without executing the production cutover** (V2 §9, §26).
- C1 is structurally resolved once the dev/cert app points at the Certification DB and prod points at the dedicated Production DB.
- H8 blast radius shrinks: PAN ciphertext leaves the shared multi-project DB.
- Migration ledger + recovery of migration 021 into the branch (H5) is a Stage 2 prerequisite for replay-from-zero.
- Decision recorded as required by V2 §9; revisit only if Stage 2 provisioning finds the host cannot host two clusters safely (then a lighter single-cluster-multi-database fallback is documented).
