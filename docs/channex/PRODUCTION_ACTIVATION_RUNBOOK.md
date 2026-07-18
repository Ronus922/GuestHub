# Channex — Production Activation Runbook

- **Status:** Complete (guard built + inactive) — Stage 4; verified in **Stage 7**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** ADR-0004 (§5), `docs/architecture/TARGET_ARCHITECTURE.md` (§3), V2 §26

The gated procedure to switch a tenant from Channex Staging to Production **after**
certification — built but disabled; the cutover is never executed in this program.

## The guard (shipped, M8)

`src/lib/channel/production-guard.ts` is the single decision point:

- `isProductionActivationEnabled()` — true only when `CHANNEX_PRODUCTION_ACTIVATION`
  is set to an explicit on-value (`1`/`true`/`on`/`enabled`). Default: off.
- `effectiveChannexEnvironment()` — `production` only when the flag is on, else
  `staging`. All setup ops route through it, so activation is one switch, not a
  code edit.
- `assertProductionActivationAuthorized()` — fails closed; gates
  `upsertChannelConnectionAction` so a production connection cannot even be created
  while the flag is off.
- `channexActivationStatus()` — read-only status for the certification console.

Because switching environment is a **data + flag** change (never a code change),
there is no code path that reaches the production base URL without the flag.
`check:production-activation-guard` executes the real guard across flag values and
proves staging-by-default; it also asserts no committed env file turns it on.

## Pre-activation checklist (run before flipping the flag, post-program)

1. Certification passed (all executable scenarios green; declarations accepted).
2. Mappings 100% verified on the production property (rooms + rate plans).
3. Production Channex credentials installed (encrypted with `CHANNEL_SECRETS_KEY`).
4. Evidence archived (scenario matrix + evidence ledger export + screenshots).
5. Backups + DB isolation verified on the production DB (Stage 2 runbooks).

## Gated activation procedure (post-program, user-approved — NOT executed here)

1. Create the production connection (requires the guard authorized).
2. Install + verify the production API key (connection test only — the guard's own
   authentication test per §26; no ARI).
3. Set `CHANNEX_PRODUCTION_ACTIVATION=1` for the deployment (audited change).
4. Operator runs one Full Sync on the production property; verify 2 requests + clean
   baseline in the evidence ledger before enabling incremental.
5. Monitor the console; confirm outbound routes to `app.channex.io`.

## Rollback to staging

Unset `CHANNEX_PRODUCTION_ACTIVATION` (→ staging) and/or disable
`outbound_sync_enabled` on the connection. No code change required.

## Stage 7 verification (no activation)

Confirm the guard is present and **refuses**: `effectiveChannexEnvironment()` is
`staging` with the flag unset; `assertProductionActivationAuthorized()` throws;
`upsertChannelConnectionAction({environment:"production"})` is rejected. Nothing is
activated; no production call is made beyond the guard's own auth-test definition.
