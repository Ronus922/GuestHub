# 01 — Cover Sheet · Channex PMS Certification Submission

**Product:** GuestHub (PMS)
**Submission date:** 2026-07-19
**Environment:** **Channex Staging** (all traffic; Production is guarded and inactive)
**Package:** `docs/certification/submission/`

---

## Certification identity

| Field | Value |
|---|---|
| Certification tenant | **GuestHub Certification** |
| Certification property | **Test Property - GuestHub** |
| Currency | **USD** |
| Environment | Staging only (`staging.channex.io`) |
| Guest data | Isolated test data — no real guests |

## Room types (occupancy 2 each)

| Room Type | Occupancy | Channex Room Type ID |
|---|---|---|
| **Twin Room** | 2 | *assigned at provisioning* |
| **Double Room** | 2 | *assigned at provisioning* |

Availability model: one physical unit per Channex Room Type, `count_of_rooms = 1`
(GuestHub D64 model). Availability is therefore **0 / 1 per room** — see
`04-adaptations.md`.

## Rate plans (4, USD)

| # | Rate Plan | Room Type | Rate | Channex Rate Plan ID |
|---|---|---|---|---|
| 1 | Twin / BAR | Twin Room | $100 | *assigned at provisioning* |
| 2 | Twin / B&B | Twin Room | $120 | *assigned at provisioning* |
| 3 | Double / BAR | Double Room | $100 | *assigned at provisioning* |
| 4 | Double / B&B | Double Room | $120 | *assigned at provisioning* |

## Room × rate-plan mappings (4)

Each mapping is `(local room × local plan) → one Channex Rate Plan`, born stop-sold
(D65), `count_of_rooms = 1`:

| Local room | Local plan | → Channex Rate Plan |
|---|---|---|
| Twin Room | BAR | Twin / BAR ($100) |
| Twin Room | B&B | Twin / B&B ($120) |
| Double Room | BAR | Double / BAR ($100) |
| Double Room | B&B | Double / B&B ($120) |

## Channex property

| Field | Value |
|---|---|
| Channex property ID | *assigned at provisioning* |
| Channex environment | Staging |

> **Provisioning note (see `DECISIONS.md` D-2).** The concrete Channex Staging
> UUIDs above are assigned when the operator creates `Test Property - GuestHub` on
> Channex Staging via `/channels` (GuestHub never auto-creates a property — operator
> create/adopt only, D60). At the time this package was assembled, the only live
> Staging connection was an unrelated development property (ILS), so the
> certification-property UUIDs are not yet issued. Once provisioned, paste them into
> this table and into `02-evidence-index.md`.

---

## Package contents

| File | Purpose |
|---|---|
| `01-cover.md` | This sheet — identity, IDs, mappings |
| `02-evidence-index.md` | One row per scenario 1–11: UI screen, code path, evidence location, counts |
| `03-declarations.md` | Written answers to items 12–14 |
| `04-adaptations.md` | Vacation-rental adaptations (form notes) |
| `05-demo-script.md` | Live screenshare script (UI path → API call → file+function) |
| `assets/` | Offline-verification evidence (captured `check:channex-*` outputs) |
| `DECISIONS.md` | Open items / gaps (honest log) |
| `SUBMISSION_STATUS.md` | Final ✅/❌ checklist |

## What is verified vs. pending

- **Verified now (offline):** integration architecture, the single ARI send seam,
  batching / "1 call" semantics, 429 circuit breaker, environment separation, the
  evidence-ledger design, declarations, adaptations and demo script — all covered by
  passing `check:channex-*` gates (see `assets/check-outputs.log`).
- **Pending the live run (external dependency, V2 §2):** the certification-property
  UUIDs (D-2), the executable-scenario Task IDs and screenshots (D-1), and the
  booking-receiving evidence (D-3).
