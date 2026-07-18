# STAGE 4 — CHANNEX INTEGRATION AND CERTIFICATION READINESS

Read first: `00_COMMON_CHARTER.md`, `GUESTHUB_PROGRAM_V2.md`, `docs/program/STATE.md`, Stage 3 report.

## Stage mission

Deliver a Channex integration that passes the full official certification process — including the live screenshare — as a side effect of real GuestHub workflows: correct environment routing, evidence ledger, exact Full Sync, batched Group Update, rate-limit resilience, hardened inbound bookings with acknowledgement, and a built-but-inactive Production activation guard.

## Entry gate

Charter entry gate (§5). Additionally: re-fetch the current official Channex documentation and update the versioned requirements document — the certification tables, dates, values and limits change over time and the Stage 1 capture may be stale. Verify the Stage 3 sync outbox and canonical services are live, since everything here consumes them.

## Binding V2 scope for this stage

* §11 in full: environment separation, routing rules, and its listed checks and tests.
* §12 in full: the mandatory certification execution model (UI-driven, anti-patterns forbidden, arbitrary-value capability, file-and-function traceability, tests 1–11 executable versus declarations 12–14), the certification tenant and property, the vacation-rental interpretation with form notes, the realistic varied-data requirement, and provisioning through GuestHub's own domain services.
* §13 in full: the evidence ledger and the strictly read-only certification console (evidence, monitoring and test-data administration only — no scenario triggers).
* §14 in full: Full Sync as a real channel-management product feature; exactly 500 property-local dates; exactly two requests; size preflight; delta-only operational policy.
* §15, remaining portion: Group Update expansion (multi-room, multi-plan, multi-range, weekday filters, combined restrictions), the single logical sync envelope, one combined Channex request per scenario, and the Min Stay Arrival/Through semantics determination and declaration.
* §16 in full: rate limits (verify current documented figures at execution), cooldown, circuit breaker, and the full fault-test list.
* §17 in full: canonical inbound flow, revisions feed only, webhook hardening, polling backup, new/modify/cancel handling, ACK after commit, and the booking-receiving certification workflow — Booking.com test account preferred, Booking CRS as the documented fallback — with all identifiers, evidence and required screenshots.
* §18, declaration portion: card and tokenization answers for the certification form.
* §26 in full: the Production activation guard — built, tested, and inactive.
* §23, Channex documents: all listed `docs/channex/` files, including a complete draft of `SCREENSHARE_DEMO_SCRIPT.md` (executed as a rehearsal in Stage 7).

## Stage-specific directives

* Every executable scenario is performed on staging through the normal product UI, with the triggering workflow and the firing file and function recorded per scenario in the evidence ledger. Browser automation may drive the real UI; nothing may bypass it.
* Prepare written answers for declarations 12–14 and the certification form fields, stored with the evidence.
* All Channex traffic in this stage is Staging-only. Production credentials, if present, are stored but never exercised beyond the guard's own authentication test as defined in §26.

## Active agents

D (lead), A, F, G, L, I, K, M. Agent N reviews environment-crossover impossibility and the guard.

## Milestones

1. Environment routing canonical; crossover tests pass.
2. Evidence ledger and read-only console.
3. Certification property provisioned with varied realistic data; mappings verified.
4. Full Sync: 500 days, two requests, Task IDs, clean baseline, incremental activation.
5. Group Update expansion and batching; ARI price equality with the Stage 3 engine proven.
6. Rate-limit cooldown and circuit breaker with fault tests.
7. Inbound bookings: create/modify/cancel with ACK evidence via the preferred test channel.
8. Production activation guard built and tested inactive.
9. Channex documentation set, screenshare script draft, declaration answers.

## Checks added in this stage

`check:channex-environment-routing`, `check:channex-certification`, `check:channex-certification-evidence`, `check:channex-full-sync-two-requests`, `check:channex-group-update-batching`, `check:channex-rate-limit-cooldown`, `check:channex-booking-crs-flow`, `check:channel-security`, `check:channel-chaos`, `check:production-activation-guard`.

## Exit gate

Charter exit gate (§6), plus:

* Every executable scenario has evidence: UI workflow, firing file and function, request counts matching the official expectation, Task IDs, pass status.
* Quote-to-ARI price equality proven end to end.
* All ten new checks pass; all previous checks still pass.
* Production remains inactive; guard test evidence recorded.
* Tag `stage-4-complete`.
