# GuestHub — Security Test Report

- **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification`
- **Scope:** staging (:5434) + disposable (:5433) DBs and the application source. Never run against production or shared infrastructure (charter §3).
- **Method:** code-level red-team review across the V2 §19 attack classes, backed by automated invariant checks (each finding maps to a check that keeps it closed) + rolled-back DB probes. This is a source + behavioral review, not an external network pentest.

## Result summary

**Zero unresolved Critical or High findings.** The two program Criticals (C1 dev/prod DB share, C2 DB exposed past UFW) were closed in Stage 2; all Stage-3/4/5 Highs are closed or re-scoped-and-now-closed (H8/H11 in this stage). Residual Medium/Low are documented below with justification.

## §19 attack classes

### Authorization attacks
- **Tenant isolation:** every server action scopes by `actor.tenantId` (ADR-0006, server-side canonical); `check:pms-domain-invariants` is the data backstop; composite `(tenant_id, id)` FKs make cross-tenant child references impossible even on a faulty query. Inbound imports are tenant-scoped (`check:inbound-bookings` cross-tenant case). **Closed.**
- **Permission bypass:** `requirePermission`/`canManageChannels` enforced server-side on every mutating action (UI hiding is never the boundary); `check:guards`. Charge/refund fail closed (`payments.refund`, D42). Housekeeping cleaner cannot touch another cleaner's task (`check:housekeeping`). **Closed.**
- **Privilege of the pooled DB role:** `guesthub_app` is DML-only, owns nothing, cannot DDL (`db/roles/roles.sql`, `check:db-isolation`). **Closed.**

### Secrets
- **Committed secrets:** `check:no-secrets` — 430 tracked files, no secret material; no `.env*` in the tree or anywhere in git history; encryption/activation env vars never hardcoded. **Closed.**
- **Key discipline:** PANs AES-256-GCM under `CARD_VAULT_KEY`; channel credentials under `CHANNEL_SECRETS_KEY`; both read only from `process.env`. CVV removed entirely (migration 018). PAN retention bounded (H8, migration 043). API key travels only in the `user-api-key` header, never a URL/log/audit (`check:channel-security`). **Closed.**
- **Supabase key discipline:** service_role JWT pattern scanned by `check:no-secrets`; the app uses the pooled least-privilege role, not service_role, for domain work. **Closed.**

### Supply chain
- `pnpm audit --prod` clean of high/critical (one moderate resolved via pinned override); lockfile committed; Node + package manager pinned (`check:supply-chain`). **Closed.**

### Application attacks
- **SQL injection:** all queries use the `postgres` tagged-template parameterization; no string-built SQL in app code. **Closed.**
- **CSV/formula injection:** report exports neutralize `=+-@` and RFC-4180-quote (`check:reports`). **Closed.**
- **Webhook abuse:** hashed-token auth, no existence oracle (404), rate limit, body-size cap, redacted persistence, sanitized 5xx, async-only (`check:channel-security`). **Closed.**
- **Card data exposure:** masked views never select the ciphertext; reveal is explicit + audited (`check:cards`). **Closed.**

### Synchronization attacks & failures
- **Double booking:** DB exclusion constraint proven under true concurrency (`check:reservation-concurrency`). **Closed.**
- **Idempotency:** payments (reference key), inbound revisions (unique + ON CONFLICT), Full Sync (idempotency key), housekeeping tasks (NOT EXISTS). **Closed.**
- **Rate-limit / provider failure:** 429 Retry-After cooldown + circuit breaker (`check:channex-rate-limit-cooldown`). **Closed.**
- **Full §24 fault list:** exercised in `check:channel-chaos` + `check:background-job-recovery` (two Full Sync clicks, credential rotation, expired lease, corrupted payload, DB unavailable, webhook+poll, cert reset). **Closed.**

## Residual Medium/Low (documented, accepted)

| Item | Severity | Why accepted / plan |
|---|---|---|
| Kong gateway (8000/8443) external hardening | Medium | Restricting it risks the `db.bios.co.il` auth ingress; requires ingress-path confirmation with the operator. The DB ports themselves are already blocked (C2). Documented in the DB exposure runbook; apply with the operator during a maintenance window. |
| In-memory webhook rate-limit (per-process) | Low | Adequate for the single-process inbound worker; move to a shared store only if inbound goes multi-process (noted in the route). |
| Real invoice provider not wired | Low (not a vuln) | Seam fails closed; external dependency (V2 §2). |

## Verified by

`check:no-secrets`, `check:supply-chain`, `check:retention`, `check:channel-security`, `check:channel-chaos`, `check:guards`, `check:db-isolation`, `check:pms-domain-invariants`, `check:reservation-concurrency`, `check:payment-refund-void`, `check:cards`.
