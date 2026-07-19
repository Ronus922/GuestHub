# Hospitable Integration — Architecture (D77)

GuestHub ↔ Hospitable Public API v2. GuestHub is the ARI source of truth: it pushes price + availability + min-stay to Hospitable's per-property calendar and imports reservations from it. Hospitable fans out to Airbnb/Booking/Vrbo — GuestHub talks to ONE upstream. Channex remains intact alongside (D77: dispatch-by-provider, no interface).

## Verified API surface (web-verified 2026-07-19)

| Item | Value |
|---|---|
| Base URL | `https://public.api.hospitable.com/v2` (no staging/sandbox exists) |
| Auth | Personal Access Token (JWT), `Authorization: Bearer` — my.hospitable.com → Apps → API access; scopes read/write; **expires after 1 year** |
| Validate | `GET /user`, `GET /properties?per_page=1` |
| Properties | `GET /properties?page&per_page` (≤100/page), `GET /properties/{uuid}`; `calendar_restricted:true` → calendar pushes rejected |
| Calendar write | `PUT /properties/{uuid}/calendar` — `{"dates":[{"date","price":{"amount":<cents>},"available","min_stay","closed_for_checkin","closed_for_checkout"}]}` |
| Reservations | `GET /reservations?properties[]=&start_date&end_date&include=guest,financials&page&per_page` |
| Webhooks | Registered **manually in Hospitable UI** (Apps → Webhooks). Events `reservation.created`/`reservation.changed`. Retries 1s/5s/10s/1h/6h. Source IPs `38.80.170.0/24`. **No HMAC** — auth = our hashed webhook-token URL |
| Rate limits | Calendar 1000 req/min (429 + Retry-After) |
| MCP (agent-only) | `https://mcp.hospitable.com/mcp`, OAuth; registered per-project in `~/.claude.json` for /var/www/guesthub |

## Runtime verification checklist (unconfirmed by public docs — close during Phase 8.2)

- [ ] Exact webhook `action` string (`reservation.changed` vs `.updated`) and payload shape (where the reservation uuid sits)
- [ ] `date_query` allowed values on GET /reservations
- [ ] Whether financials include a per-night breakdown
- [ ] Reservation `status` enum values
- [ ] Max dates per calendar PUT (we chunk at 90)
- [ ] Whether mcp.hospitable.com accepts a fallback PAT as Bearer for headless MCP use

## Known limitations (accepted, review F6/F8)

- `channel_hospitable_property_mappings.calendar_restricted` is verified fresh at map time and rejected if true, but is **not refreshed afterwards** — a property restricted post-mapping will surface as 4xx drain failures (visible in `last_error`/dead ranges), not as the documented silent skip. Remap (unmap+map) re-verifies. Refresh-on-drain is a future hardening.
- The synthetic revision id hashes the raw payload; the webhook single-GET body and the list-page body for the same reservation may hash differently → an occasional duplicate revision row. Harmless (idempotent re-import), accepted as churn.

## Model mapping

| GuestHub | Hospitable |
|---|---|
| Physical room (sellable unit) | Property (UUID) — via `channel_hospitable_property_mappings` |
| Designated pricing plan, base occupancy rate | `price.amount` (integer cents) |
| `availability` 0/1 (`sellable_unit_inventory`) AND NOT `stopSell` | `available` |
| `minStayArrival` | `min_stay` |
| `closedToArrival` / `closedToDeparture` | `closed_for_checkin` / `closed_for_checkout` |
| Reservation identity | `(channel_connection_id, external_booking_id=reservation uuid)` |
| Revision id (synthetic) | `"{uuid}:{sha256(payload)[:16]}"` — content-hash idempotency, rows insert pre-acked |

## Module map (mirrors `channex-*`)

- `config.ts` — `hospitableBaseUrl()` (production only)
- `hospitable-http.ts` — the ONE request path (Bearer, 12s timeout, single attempt, safe categories)
- `hospitable-properties.ts` — property list/get
- `hospitable-admin.ts` — PAT save (encrypt + JWT `exp` → `api_key_expires_at`), validate, map property↔room+plan
- `hospitable-ari-payloads.ts` — pure `AriProjection` → calendar dates builder
- `hospitable-ari.ts` — `pushHospitableCalendar` + evidence + circuit breaker
- `hospitable-ari-sync.ts` — full sync + dirty-range drain (reuses outbox/queue/projection)
- `hospitable-normalize.ts` — reservation JSON → `NormalizedRevision`
- `hospitable-booking-import.ts` — poll/webhook-triggered pull → synthetic revisions → shared `importNormalizedRevision`
- `worker.ts` — provider dispatch on `pull_booking_revisions` / `full_sync` / `sync_ari_range`

## Webhook runbook

1. Enable inbound on the Hospitable connection in /channels → copy the webhook URL (existing token mechanism).
2. Hospitable UI → Apps → Webhooks → +Add new → paste URL, select `reservation.created` + `reservation.changed`.
3. Optional nginx allowlist: `allow 38.80.170.0/24;` on the webhook location.
4. Missed webhooks are covered by the 5-minute fallback poll — the webhook is a wake-up, never the source of truth.

## Rollout gates (Phase 8 — no sandbox, staged blast radius)

1. Read-scope PAT → connect, validate, map one room, inbound poll; verify idempotency (second poll imports 0).
2. Webhook end-to-end (trivial change in Hospitable → event → job → import).
3. Read+write PAT → push ONE far-future date (+330d, distinctive price) to one property; verify in Hospitable calendar.
4. Operator Full Sync → only then `outbound_sync_enabled`. Nothing drains before the Full Sync (existing gate).

## PAT expiry

`api_key_expires_at` decoded from the JWT at save; /channels warns ≥30 days before expiry. Rotation = paste a new PAT (same save action).
