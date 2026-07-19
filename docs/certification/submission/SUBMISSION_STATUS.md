# SUBMISSION_STATUS — Channex PMS Certification Package

**Product:** GuestHub · **Environment:** Channex Staging · **Assembled:** 2026-07-19 ·
**Branch:** `main` · **Task:** documentation-only (no application code modified).

---

## Checklist

| Item | Status | Notes |
|---|---|---|
| Scenario 1 — Full Sync (2 requests / 500 days) | ❌ evidence pending | Path built + verified; **live Task IDs pending** (D-1). |
| Scenario 2 — Single date, single rate | ❌ evidence pending | Firing path fixed; Task ID pending (D-1). |
| Scenario 3 — Single dates, multiple rates | ❌ evidence pending | 1-batched call; Task ID pending (D-1). |
| Scenario 4 — Date ranges, multiple rates | ❌ evidence pending | Task ID pending (D-1). |
| Scenario 5 — Min Stay | ❌ evidence pending | Task ID pending (D-1). |
| Scenario 6 — Stop Sell | ❌ evidence pending | Task ID pending (D-1). |
| Scenario 7 — Combined restrictions | ❌ evidence pending | Task ID pending (D-1). |
| Scenario 8 — Half-year update | ❌ evidence pending | Task ID pending (D-1). |
| Scenario 9 — Single-date availability | ❌ evidence pending | 0/1 model; Task IDs + screenshots pending (D-1). |
| Scenario 10 — Multi-date availability | ❌ evidence pending | Task IDs pending (D-1). |
| Scenario 11 — Booking receiving (+ACK) | ❌ evidence pending | Flow built + verified; **needs Booking.com test acct / CRS** (D-3). |
| Declaration 12 — Rate-limit compliance | ✅ | Written; `check:channex-rate-limit-cooldown` PASS. |
| Declaration 13 — Delta-update-only | ✅ | Written; `check:channex-full-sync-two-requests` + `check:channex-group-update-batching` PASS. |
| Declaration 14 — Supported features / PCI | ✅ | Written; min-stay/env/guard checks PASS. |
| Adaptations (vacation-rental 0/1 model) | ✅ | `04-adaptations.md` — form-ready. |
| Demo script (UI → API → file+function) | ✅ | `05-demo-script.md` — all file+function refs grep-verified. |
| No-secrets scan | ✅ | Only route placeholders / column names matched; no credential values. |
| Zip bundle | ✅ | `certification-submission.zip` (excludes itself). |

**Executable-scenario evidence: 0 / 11** (all live-run pending — external dependency V2 §2).
**Declarations: 3 / 3** · **Adaptations: ✅** · **Demo script: ✅** · **No-secrets: ✅** · **Zip: ✅**.

---

## What is ready to send today

Cover (intended identity), declarations 12–14, vacation-rental adaptations, the live
screenshare demo script, and the offline-verification evidence (`assets/check-outputs.log`
— every `check:channex-*` gate PASS). The integration architecture, the single ARI send
seam, "1 call" batching, exactly-2 Full Sync, the 429 circuit breaker, environment
separation and the append-only evidence ledger are all verified now.

## What blocks a complete submission (the live run)

Per `DECISIONS.md`:

- **D-1** — no scenario has been executed against live Channex Staging → **0 evidence-ledger
  rows**, so no real Task IDs / screenshots exist for scenarios 1–11.
- **D-2** — the dedicated certification property (`Test Property - GuestHub`, USD,
  Twin/Double, 4 BAR/B&B plans) is **not provisioned**; the only live Staging connection is
  an unrelated ILS development property, so the certification-property Channex UUIDs are not
  yet issued.
- **D-3** — test 11 needs a Booking.com test account or the Booking CRS injector.

Closing these three is a **live-execution** task (out of scope for this documentation-only
package), not a code change. The runbook to execute them is
`docs/channex/CERTIFICATION_RUNBOOK.md`.
