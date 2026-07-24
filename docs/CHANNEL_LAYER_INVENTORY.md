# Channel layer inventory (post-D91)

After D91, **Beds24 is the only channel provider**. This is the authoritative
map of what remains under `src/lib/channel/` — what each file does, and which
pieces serve the LIVE Beds24 traffic (inbound booking ingestion + outbound ARI).
Channex and Hospitable were removed entirely.

## The live Beds24 path

**Inbound (bookings in) — polling, not webhooks.** The PM2 worker
(`guesthub-channel-worker`) runs `pull_booking_revisions` on a timer:

```
worker.ts → beds24-booking-import.ts → beds24-http.ts / beds24-token.ts
          → beds24-normalize.ts → booking-import.ts (importNormalizedRevision → reservation INSERT)
          → revisions.ts · payloads.ts · external-changes.ts · outbox.ts
```

**Outbound (ARI out) — availability, rates, restrictions.** Enqueued by the
canonical rate save and by the `/rates` "sync channels" button; drained by the
worker's `sync_ari_range` / `full_sync`:

```
worker.ts → beds24-ari-sync.ts → beds24-ari-projection.ts → beds24-ari-payloads.ts
          → beds24-ari.ts → evidence.ts · circuit-breaker.ts · ranges.ts
```

## File-by-file

### Provider-neutral infrastructure (shared; must never be provider-coupled)
| File | Role |
|------|------|
| `worker.ts` | PM2 worker loop + job dispatch. **Beds24-only**: any other provider's job dead-letters. |
| `queue.ts` | Durable job queue — claim/complete/fail/enqueue (`FOR UPDATE SKIP LOCKED`). |
| `channel-http.ts` | The leak-proof HTTP request core + error taxonomy + defensive parsers. Formerly `channex-http.ts`; renamed in D91 because every Beds24 module imports it. |
| `booking-import.ts` | The shared post-normalize import core: `importNormalizedRevision` → the reservation INSERT/UPSERT for any provider. `RoomResolver` is injected (required) — the core never guesses a provider. |
| `booking-normalize.ts` | Provider-neutral interchange types (`NormalizedRevision`, `NormalizedRoom.externalRoomId`). |
| `revisions.ts` | Raw revision persistence + quarantine; card staging. |
| `payloads.ts` | Redaction + card extraction from a raw revision. |
| `external-changes.ts` | Modify/cancel OTA email dispatch (D82). |
| `external-changes-admin.ts` | Server actions behind the (provider-neutral) External Changes card. |
| `outbox.ts` | `markAriDirty` — re-dirties ranges after an import. |
| `evidence.ts` | The ARI certification evidence ledger (outbound DB write). |
| `circuit-breaker.ts` | Per-connection failure/circuit state. |
| `ranges.ts` | ARI horizon, backoff, range coalescing, permanent-error classification. |
| `ari-projection.ts` | Shared ARI interchange **types only** (`AriProjection`, `CommercialRow`, `DrainSummary`, …). |
| `config.ts` | `ChannelEnvironment` type + `beds24BaseUrl()`. |
| `crypto.ts` | Secret encrypt/decrypt (AES-256-GCM, key from `CHANNEL_SECRETS_KEY`). |
| `admin.ts` | The one provider-neutral observability action `getChannelStatusAction` (queue/health/errors snapshot for `/channels`). |

### Beds24-specific (the live provider)
| File | Role |
|------|------|
| `beds24-http.ts` | Beds24 HTTP client (over `channel-http.ts`). |
| `beds24-token.ts` | 24h access-token cache (encrypt at rest, refresh). |
| `beds24-booking-import.ts` | Inbound pull loop + Beds24 property/room ownership guard → shared import core. |
| `beds24-normalize.ts` | Beds24 booking payload → `NormalizedRevision`. |
| `beds24-ari-sync.ts` | Outbound orchestrator: `drainBeds24AriDirtyRanges`, `runBeds24FullSync` (+ the today-clamp fix). |
| `beds24-ari-projection.ts` | Canonical availability/rate/restriction projection from inventory + rates. |
| `beds24-ari-payloads.ts` | Projection → Beds24 calendar request payloads. |
| `beds24-ari.ts` | Push ARI to the Beds24 API. |
| `beds24-admin.ts` | Operator server actions: connect (invite code), test, map rooms, enable/disable inbound, run full sync. |
| `beds24-properties.ts` | Beds24 property/room discovery for the mapping UI. |

### `/rates` channel-sync surface (provider-neutral, drives the active provider)
| File | Role |
|------|------|
| `rates-sync.ts` | `getRatesSyncStatus` + `requestIncrementalSyncNow` for the `/rates` "סנכרן ערוצים" chip/button. Enqueues the same `sync_ari_range` job the worker drains. |
| `sync-state.ts` | Pure derivation of the rates-sync status shape. |

### Not on the channel path (left as-is)
- `card-ingest.ts` — channel-card ingestion helper; no live importer (pre-existing dead-code candidate, outside the D91 scope; untouched).

## Intentional residue — RESOLVED by migration 054 (2026-07-24)
Migration `054_external_column_rename.sql` renamed all 19 legacy `channex_*`
columns across the 6 channel tables to the `external_*` convention (RENAME
COLUMN only; the fixture in `scripts/check-rate-grid.mjs` was updated with it).
`grep -rni channex src/ scripts/` returns 0.

Still carrying the historical name, by explicit choice (names only, no data or
behavior): index/constraint names (`uq_crtm_channex_id`, `uq_crpm_channex_id`,
`uq_crm_channex_room_type`, `uq_crrm_channex_rate_plan`, 023's `chk_*`) and the
`channel_inbound_rate_plan_aliases.source` value/CHECK `'channex_verified'`.
Renaming those is a possible future 055 — a deliberate decision, not an
oversight.

## Coverage note
The deleted Channex integration guards (`check-channex-*`, worker/rates-sync/
inbound integration tests) are **not yet replaced** with Beds24 equivalents.
The Beds24 ARI drain, inbound feed import and cancellation paths currently have
no integration guard — writing `check-beds24-*` fixtures (fake Beds24 API +
`channel_beds24_room_mappings`) is follow-up work that needs a disposable DB.
