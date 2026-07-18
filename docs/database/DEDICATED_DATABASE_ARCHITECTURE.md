# Dedicated Database Architecture

**Date:** 2026-07-18 · **Stage:** 2 · **Status:** Staging provisioned; production prepared (not cut over) · **Decision:** ADR-0002

## Why

Defect C1 (`docs/audit/DEFECT_MATRIX.md`): GuestHub production and dev both used one shared self-hosted Supabase stack (`supabase-db`, Supavisor `:5432`), schema `guesthub`, alongside unrelated apps (`marketpilot`, `sea_tower`, and 22 foreign tables in `public`). V2 §9 requires infrastructure dedicated only to GuestHub.

## Topology (ADR-0002)

Dedicated PostgreSQL clusters per environment, reusing GoTrue only where auth needs it — not a full Supabase stack per environment. GuestHub consumes GoTrue + plain Postgres (porsager driver); it does not use PostgREST, and uses pg `NOTIFY`/SSE instead of Realtime and local disk instead of Storage.

| Environment | Where | Binding | Status |
|---|---|---|---|
| **Certification/Staging** | container `guesthub-staging-db` (`supabase/postgres:15.8.1.085`), db `guesthub_staging` | **127.0.0.1:5434 only** (localhost — never `0.0.0.0`) | **Provisioned & validated** |
| **Disposable test** | container `guesthub-testdb`, db recreated per run | 127.0.0.1:5433 | In use (replay/restore drills) |
| **Production** | dedicated `supabase/postgres:15.8.1.085` container, db `guesthub_production`, localhost-bound | to be provisioned at cutover | **Prepared, not executed** (see cutover runbook) |

Every dedicated DB binds to localhost only, so the C2 exposure class (Docker publishing DB ports on `0.0.0.0`) does not recur for the new clusters. The legacy shared stack is **not modified** — GuestHub moves off it.

## Roles (least privilege, V2 §9 — `db/roles/roles.sql`)

| Role | Purpose | Privileges |
|---|---|---|
| `guesthub_owner` | migrations / DDL | owns the `guesthub` schema + all objects |
| `guesthub_app` | runtime | DML only (SELECT/INSERT/UPDATE/DELETE) + EXECUTE; **owns nothing, cannot DDL** |
| `guesthub_readonly` | diagnostics | SELECT only |
| `guesthub_backup` | dump/restore | `pg_read_all_data` |

Verified on staging: all 61 tables + schema owned by `guesthub_owner`; `guesthub_app` DML works, DDL denied; `guesthub_readonly` SELECT works, INSERT denied.

## Authentication

Each environment gets its own GoTrue bound to that cluster's `auth` schema (preserves logins). The `supabase/postgres` image seeds the `anon`/`authenticated`/`service_role`/`supabase_admin` roles that migration `000` grants to, so migration replay works unchanged. Backups now include the `auth` schema (H4) so a restore keeps logins.

## Supabase key / RLS posture (V2 §9 audit)

GuestHub does **not** expose the `guesthub` schema through PostgREST; tenant isolation is enforced server-side (`actor.tenantId`), not via RLS (see `000_init_schema.sql` header and `docs/security/THREAT_MODEL.md` F2). The `service_role` key is server-only. The decision to keep server-side enforcement canonical (vs adding RLS as a DB backstop) is H3, owned by Stage 3.

## Migration ledger (H5)

`guesthub.schema_migrations` (version, checksum, applied_at) records every applied `db/migrations/*.sql` in `manifest.txt` order. Runner: `scripts/db/migrate.mjs` (`npm run db:replay`). Replay-from-zero is proven (38/38, schema structurally identical to production).

## Isolation guarantee

`npm run check:db-isolation` asserts a target DB contains only GuestHub + Supabase-infra schemas. PASSES on staging; FAILS on the legacy shared DB (detects the foreign apps) — i.e. it detects C1.

## Related docs
`MIGRATION_AND_CUTOVER_RUNBOOK.md` · `BACKUP_RESTORE_AND_ROLLBACK.md` · `DATA_INTEGRITY_CHECKLIST.md` · `DB_EXPOSURE_MITIGATION.md` · ADR-0002.
