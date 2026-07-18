# Channex — Environment Separation

- **Status:** Skeleton — Stage 1; completed in **Stage 4**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/CHANNEX_CERTIFICATION_MAPPING.md` (G6), ADR-0004 (§5), ADR-0002, `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`

How Staging and Production Channex environments are kept apart, and how the base URL is resolved per call.

## Current state

`channel_connections.environment` exists and is the intended single source of the environment boundary (ADR-0001), and **inbound** paths already honor it (`booking-import.ts:94`, `inbound-admin.ts`). But **outbound** ARI, room-type, rate-plan, and admin paths **hardcode `CHANNEX_BASE_URLS.staging`** (`ari-sync.ts:107`, `room-type-admin.ts`, `rate-plan-admin.ts`, `admin.ts`) — gap G6 (`CHANNEX_CERTIFICATION_MAPPING.md` §4, §6). This is Low severity until go-live (staging is correct for certification) but blocks the post-certification production cutover. Credentials are per-tenant API keys encrypted with `CHANNEL_SECRETS_KEY`; `CHANNEX_BASE_URLS` holds both `staging.channex.io` and `app.channex.io` (`ARCHITECTURE_INVENTORY.md` §4).

## Target state (per ADR-0004, ADR-0002)

- Environment resolved from `channel_connections.environment` on **every** call — outbound and inbound (ADR-0004 §5, removes G6).
- Production stays disabled behind the activation guard (V2 §26) — see PRODUCTION_ACTIVATION_RUNBOOK.
- Separate credentials per environment; the dedicated Certification/Staging DB (ADR-0002) holds Channex Staging + certification data, distinct from Production.
- Unknown/unset environment refuses (fail-closed, `TARGET_ARCHITECTURE.md` §1).

## To be completed in Stage 4

- [ ] Base-URL resolution rule (`CHANNEX_BASE_URLS[conn.environment]`) applied to all outbound paths (G6).
- [ ] Environment × credential × DB matrix (Staging vs Production).
- [ ] Fail-closed behavior on unknown environment.
- [ ] `check:channex-environment-routing` test description.
- [ ] Relationship to the production activation guard.
