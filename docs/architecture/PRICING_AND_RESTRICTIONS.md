# GuestHub — Pricing & Restrictions

- **Status:** Skeleton — Stage 1; completed in **Stage 3**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/audit/PRICING_AUDIT.md`, ADR-0001, `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`

The pricing engine, the one quote seam, restriction semantics (min-stay Arrival/Through, CTA/CTD, stop-sell), and money/VAT/currency discipline.

## Current state

There is ONE server-side pricing engine — `calculateQuote`/`calculateReservationPrice` (`src/lib/pricing/engine.ts:124-557`) — reached by every committing/publishing surface: booking-panel preview ≡ save, the simulator, and the Channex ARI projection all share `resolveChainNightPrice` verbatim, mutation-verified by `check:pricing-equality.mjs` and `check:channex-ari.mjs` (`PRICING_AUDIT.md` §1, §2, F-1). Price precedence is strict and fail-closed: exact (plan,unit,date) → per-unit adjustment → plan adjustment → parent chain → base room-night → structured `NO_PRICE_FOR_DATE`; a 0 or missing base is refused, not sold (`PRICING_AUDIT.md` §1.1, F-12). Plans are dual-scope (016); weekly/monthly are ordinary derived plans (no special engine). Restrictions are dual-semantics and canonical: `min_stay_arrival` (arrival-date row), `min_stay_through` (MAX over occupied nights), CTA/CTD, stop-sell — all validated by the single `stayRestrictionViolationStructured` and all published explicitly to Channex (`PRICING_AUDIT.md` §3.1, F-11).

Residual risks for Stage 3: the trivial base-price fallback rule is re-implemented ~5× (engine TS, ARI TS, `planNightlyPrice`, SQL `effective_sell_state`, calendar tooltip) with no compiler/test tying the SQL copy to the TS copies (F-2); restriction enforcement on **direct operator entry** (min-stay/CTA/CTD) is projected to Channex but not evidenced in `createReservationAction` — verify and close (`PMS_GAP_MATRIX.md` §5, PRICING F-verify). Money is `numeric(12,2)` but flows through JS floats with compensating `round2`/integer-cent totals; the manual/committed fast path multiplies without rounding (float dust, F-6). Tourist VAT zero-rating is unimplemented (single per-tenant scalar, F-4); inbound OTA currency is stored as-is with no conversion (F-8).

## Target state (per ADR-0001)

- `calculateReservationPrice`/`calculateQuote` confirmed as the single price source; reschedule inline total converted to an engine call (ADR-0001, M7).
- One shared base-price fallback projection replacing the ~5 copies (F-2).
- Restrictions enforced on direct operator bookings, not just projected (ADR-0001; GAP).
- Residual float fast-paths removed; one money module owns rounding (`TARGET_ARCHITECTURE.md` §1).
- Min-stay declaration = dual (Arrival + Through) carried into the Stage-4 Channex declarations.

## To be completed in Stage 3

- [ ] Engine call-graph and the one quote seam (`priceReservationStays`) diagram.
- [ ] Restriction-semantics table (Arrival vs Through, CTA/CTD, stop-sell, overlay tighten-only merge).
- [ ] Base-price fallback consolidation plan (F-2).
- [ ] Direct-entry restriction enforcement design + test.
- [ ] Money/VAT/currency discipline statement (integer minor units target; tourist-VAT dimension deferred to Stage 5).
