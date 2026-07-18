# GuestHub PMS — Threat Model

- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Author:** Agent I (security, read-only threat modeling)
- **Status:** FINALIZED — Stage 6. Full red-team executed; see the resolution addendum at the end + `SECURITY_TEST_REPORT.md`.
- **Scope:** Design-level threat model from static source review only. No exploitation, no attack traffic, no fixes. All references are `file:line` into the working tree. This document is written for a PUBLIC repo and contains no secrets, keys, tokens, or working exploit payloads.

---

## 1. System overview (security-relevant)

- **Framework:** Next.js 15 App Router. Auth session at the edge (`src/middleware.ts`), business logic in Server Actions (`"use server"`) and a small set of Route Handlers under `src/app/api/`.
- **Identity:** Self-hosted Supabase GoTrue (session cookie via `@supabase/ssr`). The session is resolved server-side to a `guesthub.users` row + tenant + role + effective permissions in `getActor()` (`src/lib/auth/actor.ts:80`).
- **Data access:** `porsager postgres` tagged-template client over the Supavisor **session pooler** as a privileged Postgres role (`src/lib/db.ts:11`). All tables live in the `guesthub` schema and are hand-qualified. **PostgREST/RLS is not in the data path** for application queries.
- **Multi-tenancy:** Every table carries `tenant_id`; isolation is enforced **entirely in application code** by threading `actor.tenantId` into each `WHERE` clause.
- **Secrets at rest:** AES-256-GCM vaults keyed from env, never from DB — card PAN (`src/lib/card-vault.ts`), messaging provider secrets (`src/lib/messaging/secrets.ts`), channel secrets (`src/lib/channel/crypto.ts`).

---

## 2. Trust boundaries

1. **Browser ↔ Next server** — session cookie; Server Actions and Route Handlers are the only server entry points. Client-supplied `tenantId` is never trusted (`src/lib/auth/actor.ts:6-7`).
2. **Next server ↔ Postgres** — privileged pooled connection; the DB grants no per-tenant enforcement of its own.
3. **Next server ↔ GoTrue** — anon key (session) + service-role key for admin user ops (`src/lib/supabase/admin.ts`).
4. **External ↔ webhook endpoints** — unauthenticated server-to-server POSTs (Channex, Twilio, GREEN-API) authenticated by opaque path token (+ Twilio HMAC).
5. **Next server ↔ third-party APIs** — outbound fetches to Google OAuth/Gmail, Twilio, GREEN-API, Channex, using operator-configured hosts/credentials.

---

## 3. Assets & STRIDE analysis

### Asset A — Guest PII (names, phone, email, ID number)
- **Threats:** cross-tenant read (I/EoP); leakage via PDF/email/logs (I); tampering of guest records (T).
- **Mitigations:** every query tenant-scoped by `actor.tenantId` (e.g. `getReservationAction` `WHERE res.id = ${id} AND res.tenant_id = ${actor.tenantId}`, `src/app/(dashboard)/reservations/actions.ts:~1332`); PDF route resolves actor + `reservations.view` + tenant scope before rendering (`src/app/api/reservations/[id]/pdf/route.ts:19-20` → `src/lib/pdf/booking-doc-data.ts:142-147`); audit trail on PDF generation (`:29-37`).
- **Gaps:** tenant isolation has **no DB-level backstop** (see Finding F2). A single missing `tenant_id` predicate silently leaks another tenant's PII. **Severity: High** (design-level, defense-in-depth).

### Asset B — Card vault (PAN)
- **Threats:** ciphertext/key reaching the browser (I); PAN in logs/audit (I); forged charge (EoP/T).
- **Mitigations:** `src/lib/card-vault.ts` is `server-only`; AES-256-GCM with fresh 96-bit IV, key = SHA-256(`CARD_VAULT_KEY`) held only in env, **fail-closed** (missing key throws, no plaintext fallback, `:22-26`); versioned ciphertext for rotation (`:15-16`). **CVV is never stored** — column dropped in migration 018, wrappers removed (`:43-47`). No `console.log` of PAN anywhere (0 hits).
- **Gaps:** `console.error("[reservation-cards]", e)` (`src/app/(dashboard)/reservations/card-actions.ts:53`) and `[stripe-tokenization]` (`src/lib/channel/payments-admin.ts:41`) log whole error objects — low risk of provider metadata in logs, no PAN observed. **Severity: Low.**

### Asset C — Channel & messaging credentials (Channex API key, Gmail refresh token, Twilio/GREEN-API secrets)
- **Threats:** credential exfiltration (I); privilege abuse of integration secrets (EoP); SSRF via operator-set host (I/EoP).
- **Mitigations:** all encrypted at rest via GCM vaults; decryption is `server-only`; secrets excluded from audits (`gmail/oauth/callback/route.ts:151-157`). Managing connections/credentials is **super_admin-only**, stricter than the generic `admin` bypass (`src/lib/auth/guards.ts:128-140`). Gmail OAuth callback verifies a state-cookie CSRF nonce AND re-checks same super_admin + same tenant (`gmail/oauth/callback/route.ts:41-54`).
- **Gaps:**
  - GREEN-API webhook token is stored **plaintext** in `config->>'webhookToken'` and is the *sole* authenticator (GREEN-API does not sign) — `src/lib/messaging/store.ts:83`. Inconsistent with the Channex model, which stores only a `webhook_token_hash` (`src/app/api/channel/webhook/[token]/route.ts:56`). DB/backup read → forged delivery-status events. **Severity: Medium.**
  - Provider **base host is operator-controlled** and the apiToken is placed directly in the request URL path (`src/lib/messaging/whatsapp/green-api.ts:12-18`); a malicious/typo `apiHost` exfiltrates the token. super_admin-only → limited. **Severity: Low (SSRF/exfil).**

### Asset D — Tenant data at large (rooms, rates, settings, staff)
- **Threats:** cross-tenant CRUD (I/T/EoP); privilege escalation via role/permission edits (EoP).
- **Mitigations:** Server Actions consistently resolve `getActor()` + `requirePermission()` and thread `actor.tenantId` — sampled coverage: reservations 23 auth / 78 tenant refs, rooms 24/49, rate-plans 17/36, staff 12/30. Privilege-escalation guards are pure and unit-checkable (`src/lib/auth/guards.ts`): rank-dominance (`canManageTarget`), no self role-change (`canChangeRole:46-53`), can't grant a role/override carrying a sensitive permission you lack (`canControlRole:66-79`, `canGrantOverride:113-122`), protected roles read-only.
- **Gaps:** `admin` and `super_admin` **bypass all granular permission checks** (`src/lib/auth/permission-check.ts:14-18`) — broad by design; a compromised admin session is unbounded within its tenant. Channel-admin helper files (`src/lib/channel/*-admin.ts`) show low `getActor` counts (2 each) — several are called from already-authorized Server Actions, but Stage 6 should confirm none is reachable unauthenticated. **Severity: Medium (verify in red team).**

### Asset E — Reservation integrity & availability truth
- **Threats:** forged inbound bookings / status via webhook (S/T); replay/duplicate (T); race between webhook and poll (T).
- **Mitigations:** Channex webhook authenticates via **hashed** opaque token requiring an active inbound-enabled connection, rate-limits per token, caps body size, dedupes and enqueues in one transaction (`src/app/api/channel/webhook/[token]/route.ts:46-102`). Twilio status webhook verifies **X-Twilio-Signature (HMAC-SHA1, timing-safe)** over the canonical configured origin, never the request Host (`src/app/api/messaging/webhook/twilio/[token]/route.ts:34-84`), plus idempotent `recordMessageEvent` + monotonic `advanceMessageStatus`.
- **Gaps:** in-memory fixed-window rate limiter is per-process; multi-process inbound would weaken it (noted in code, `channel/webhook/[token]/route.ts:20-21`). GREEN-API status forgery per Asset C. **Severity: Low–Medium.**

### Asset F — Environment / runtime integrity
- **Threats:** dev/test operations mutating production data (T, catastrophic).
- **Gaps:** **Known Critical.** The dev checkout resolves its DB purely from `DATABASE_URL` with no environment guard in code (`src/lib/db.ts:11-17`); memory records the shared-host hazard that `:5432` is the PROD Supabase DB and a stray dev server / broad `pkill -f next` has previously hit production (MEMORY: D45, shared-host pkill hazard). **Severity: Critical.**

---

## 4. Findings summary (severity-ranked)

| # | Finding | Severity | Evidence |
|---|---------|----------|----------|
| F1 | **Environment crossover** — dev checkout can point at the shared PROD DB; no in-code guard distinguishing prod from dev/test connection | Critical | `src/lib/db.ts:11-17`; MEMORY D45 / shared-host pkill |
| F2 | **No RLS / DB-level tenant backstop** — isolation is 100% application-layer; pooled privileged role bypasses RLS even if added; migrations contain zero `CREATE POLICY` / `ROW LEVEL SECURITY` | High | `src/lib/db.ts:1-6`; `db/migrations/*` (no policy statements); enforcement pattern in every `*/actions.ts` |
| F3 | **No app-layer login rate-limiting / lockout** — brute force depends entirely on upstream GoTrue config (unverified); minor username-enumeration timing (username path returns before password verification) | Medium | `src/app/login/actions.ts:22-34` |
| F4 | **GREEN-API webhook token plaintext at rest & sole authenticator** (no provider signature); inconsistent with Channex hashed-token model | Medium | `src/lib/messaging/store.ts:83`; contrast `src/app/api/channel/webhook/[token]/route.ts:56` |
| F5 | **Admin/super_admin bypass all granular permissions**; channel `*-admin.ts` helpers have thin local auth — confirm none reachable unauthenticated | Medium | `src/lib/auth/permission-check.ts:14-18`; `src/lib/channel/*-admin.ts` |
| F6 | **SSRF / token-exfil via operator-controlled provider host** (apiToken in URL path; super_admin-only) | Low | `src/lib/messaging/whatsapp/green-api.ts:12-18`; `src/lib/channel/inbound-admin.ts:454` |
| F7 | **Service-role key = full GoTrue admin**; well-contained (staff actions only) but total blast radius if leaked | Low | `src/lib/supabase/admin.ts:7-13`; used only in `src/app/(dashboard)/staff/actions.ts:11` |
| F8 | **Error-object logging** may capture provider metadata (no PAN/CVV observed) | Low | `card-actions.ts:53`, `payments-admin.ts:41` |
| F9 | **Client `dangerouslySetInnerHTML` trusts server renderer output** — safe only while renderer stays escape-first; a coupling risk | Low | `src/components/communications/TemplateEditor.tsx:704` ← `src/lib/communications/renderer.ts:51-61` |

## 5. Notable strengths (mitigations already in place)
- Email/template renderer is **escape-first-then-substitute**; a guest name with `<` can never become markup; URLs pass an http(s) allowlist (`src/lib/communications/renderer.ts:32-61,91-98`).
- **No string-concatenated SQL** anywhere; all queries are `postgres` tagged templates; `sql.unsafe`/`sql(\`…\`)` not used (0 hits).
- **Zero `console.log`** in `src/` (Iron Rule honored); prod dependency audit `npm audit --omit=dev` = **0 vulnerabilities**.
- Uploads validate MIME map, size cap, and **magic bytes**, with UUID filenames + tenant/room ownership checks (`src/app/api/rooms/images/route.ts:27-49`, `src/app/api/branding/logo/route.ts`).
- Card vault fail-closed AES-256-GCM; **CVV never persisted** (migration 018); Twilio HMAC timing-safe; Gmail OAuth CSRF state + re-auth; SSE endpoint auth-checked and tenant-scoped at connect (`src/app/api/events/route.ts:26-45`); webhook dedupe/idempotency across Channex + Twilio.

## 6. Out of scope for Stage 1 (deferred to Stage 6 red team)
- Live authentication behavior of upstream GoTrue (lockout, password policy, token lifetime).
- Runtime reachability of `src/lib/channel/*-admin.ts` helpers via any unauthenticated path.
- Multi-process webhook rate-limit behavior; backup/at-rest exposure of `config` JSON secrets.
- Actual `.env.local` contents and key strength (not read; confirmed git-ignored and untracked).

---

## Stage 6 resolution addendum (finalization)

The full red-team review ran in Stage 6 (`SECURITY_TEST_REPORT.md`). Resolution of the findings raised above:

| Finding class | Resolution | Evidence |
|---|---|---|
| C1 dev/prod DB share | Closed (Stage 2) — dedicated staging DB, cutover runbook | `check:db-isolation` |
| C2 DB exposed past UFW | Closed (Stage 2) — DOCKER-USER DROP, persisted | `DB_EXPOSURE_MITIGATION.md` |
| Tenant isolation / authz | Closed — server-side canonical scoping + data backstop + composite FKs | `check:pms-domain-invariants`, `check:guards` |
| Secrets in code/history | Closed — none present; env-only, fail-closed vaults | `check:no-secrets` |
| PAN retention / PCI scope (H8) | Closed — `purge_expired_cards`, CVV never stored | `check:retention` |
| Log growth (H11) | Closed — `purge_channel_sync_errors` | `check:retention` |
| Supply chain | Closed — audit clean, pinned runtime | `check:supply-chain` |
| Double-booking / sync attacks | Closed — DB exclusion constraint + idempotency + circuit breaker | `check:reservation-concurrency`, `check:channel-chaos` |
| Webhook / app attacks | Closed — hashed token, no oracle, bounded, redacted, injection-hardened exports | `check:channel-security`, `check:reports` |

**Residual (Medium/Low, accepted with plan):** Kong gateway (8000/8443) external hardening (needs ingress-path confirmation with the operator; DB ports already blocked); off-host backup destination (operator-provided); GREEN-API messaging token hashing + operator-host allowlist (messaging module, Medium — plaintext token asymmetric with Channex hashed model; impact limited to forged outbound delivery-status); automated `CARD_VAULT_KEY` rotation tooling (Low, `key_version` supports it). See `SECURITY_TEST_REPORT.md` + `SECRET_HANDLING.md`.

**Zero unresolved Critical or High.**
