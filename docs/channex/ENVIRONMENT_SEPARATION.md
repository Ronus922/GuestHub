# Channex — Environment Separation

- **Status:** Complete — Stage 4 (G6 closed)
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** ADR-0004 (§5), ADR-0002, `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`

How Staging and Production Channex environments are kept apart, and how the base URL is resolved per call.

## The single boundary (shipped, M1)

Every Channex HTTP call derives its base URL from **one resolver** —
`config.channexBaseUrl(env)` — and nothing else reads the `CHANNEX_BASE_URLS`
map. `check:channex-environment-routing` fails CI if any module reads the map
directly, hardcodes a `staging.channex.io`/`app.channex.io` literal, or assigns a
string literal to `baseUrl`. This makes a staging/production crossover
structurally impossible.

The environment fed to the resolver comes from exactly two honest sources:

| Path | Environment source |
|---|---|
| Runtime send / inbound / reporting / payments | the connection row's own `conn.environment` column (`channexBaseUrl(conn.environment)`) |
| Setup / management ops (`admin.ts`, `room-type-admin.ts`, `rate-plan-admin.ts`) | `production-guard.effectiveChannexEnvironment()` — staging until the activation flag is set |

The former G6 gap (outbound/setup paths hardcoding `.staging`) is **closed**: there
are no environment literals at any call site.

## Fail-closed on unknown environment

`channexBaseUrl(env)` throws on an unrecognised environment; `conn.environment` is
a NOT-NULL column constrained to `staging`/`production`. `effectiveChannexEnvironment()`
returns `production` **only** behind the explicit `CHANNEX_PRODUCTION_ACTIVATION`
flag, else `staging` — so an absent/garbage flag can never route to production.

## Environment × credential × DB

- **Credentials:** per-tenant Channex API key, encrypted with `CHANNEL_SECRETS_KEY`;
  a production connection cannot even be created while the activation guard is off
  (`upsertChannelConnectionAction` asserts it).
- **Data:** certification + Channex Staging data live on the dedicated Staging DB
  (ADR-0002, `:5434`), distinct from Production.

## Relationship to the activation guard

Production is reachable only through `effectiveChannexEnvironment()` returning
`production`, which requires the activation flag AND (to actually authenticate)
`CHANNEL_SECRETS_KEY`. See `PRODUCTION_ACTIVATION_RUNBOOK.md`. Proven by
`check:channex-environment-routing` + `check:production-activation-guard`.
