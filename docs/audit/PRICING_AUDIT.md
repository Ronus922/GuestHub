# PRICING AUDIT — Rates & Revenue Logic (Agent G)

- **Date:** 2026-07-18
- **Branch:** feat/pms-hardening-channex-certification
- **Scope:** V2 §5 (Agent G) + §10 pricing portion + §8 one-source-of-truth quote equality
- **Method:** static read of `/var/www/guesthub` + read-only SELECTs against the `guesthub-testdb` snapshot (`guesthub_stage1_restore`). No writes, no prod access.

---

## 1. Engine description & call graph

### 1.1 The canonical engine

ONE server-side pricing engine exists: `calculateQuote` / `calculateReservationPrice` (alias, same function) in `src/lib/pricing/engine.ts:124-557`. Header comment (engine.ts:22-33) declares it the single calculation for simulator, manual reservations, future booking engine and Channex. The business half is pure and standalone-compilable:

```
calculateReservationPrice (engine.ts:124)  ==  calculateQuote (engine.ts:131)
 ├─ tenants (currency, timezone, vat_rate, extra_guest)          engine.ts:136-146
 ├─ getRoomPlanRates()          src/lib/rates/effective-state.ts:30   ← guesthub.pricing_plan_rates (base ARI layer)
 ├─ pricing_plans (tenant-scope, sellable_unit_id IS NULL)       engine.ts:178-187
 ├─ pricing_plan_units (assignments)                             engine.ts:206-215
 ├─ pricing_plan_unit_rates (per-(plan,unit,date) overlay)       engine.ts:218-228
 ├─ checkRoomAvailability()     src/lib/inventory                engine.ts:242-245
 ├─ PURE rules:
 │   ├─ resolveParentChain()            src/lib/pricing/resolve.ts:64   (max depth 5, cycle guard)
 │   ├─ resolveChainNightPrice()        resolve.ts:164                  (root-first chain walk)
 │   │    └─ resolveNightPrice()        resolve.ts:106                  (precedence §8.3)
 │   ├─ applyPlanAdjustment()           resolve.ts:84                   (% or fixed ADJUSTMENT, never fixed final price)
 │   ├─ mergeRestrictionRows()          resolve.ts:213                  (base ∪ plan overlay; tighten-only)
 │   ├─ planStayRuleViolation()         resolve.ts:253                  (validity, booking window, DOW, plan min/max)
 │   ├─ assignmentViolation()           resolve.ts:283
 │   ├─ stayRestrictionViolationStructured()  src/lib/rates/rules.ts:56 (THE shared stay validator)
 │   └─ calculateChargeableGuests()/resolveEffectivePricing()  src/lib/commercial/room-pricing.ts (extra guests §11)
 └─ result: NightQuote[] + RoomQuote[] + VAT decomposition + sha256 quoteFingerprint (engine.ts:112-117, 519-536)
```

**Price precedence** (resolve.ts:8-15): (1) exact (plan, unit, date) row → (2) per-unit assignment adjustment → (3) plan default adjustment → (4) parent plan resolved value → (5) base room-night price (`pricing_plan_rates.price`, else `room_types.base_price`) → (6) structured `NO_PRICE_FOR_DATE`, never a silent fallback. A price of `0` or a missing base is refused, not sold (engine.ts:458-461).

### 1.2 Reservation seam

`priceReservationStays` (`src/lib/pricing/reservation-pricing.ts:221-306`) is the ONE bridge from reservation server actions (create/edit/move/preview) to the engine. It adds reservation-domain semantics:

- **Committed-price snapshot immutability (§6):** an unchanged confirmed stay keeps its stored price via `snapshotByRr` (reservation-pricing.ts:210-215, 286-291) — never re-priced from current rates.
- **Manual override (§13):** `manualRatePerNight` is the final nightly price; engine bypasses extra-guest math (engine.ts:364-370, 424-443); precedence manual → snapshot → auto in `resolveStayPrice` (`src/lib/rates/rules.ts:231-251`).
- **Immutable snapshot** stored per stay in `reservation_rooms.pricing_snapshot` (migration `db/migrations/017_reservation_pricing.sql:21`), built by `buildStaySnapshot` (reservation-pricing.ts:152-203) — full nightly breakdown, sources, fingerprint, VAT rate.
- **Canonical total formula:** `reservationTotal` (reservation-pricing.ts:314-320) — one formula, discount floored once at zero.

### 1.3 Plan model (dual scope, migration 016)

`pricing_plans` is dual-scope (`db/migrations/016_rate_plans.sql:57-138`):
- **SU-scoped** (`sellable_unit_id NOT NULL`, `is_base`) — the Phase-4A base ARI layer, one per sellable unit; constraint `pricing_plans_scope_chk` (016:104-106) forces SU rows to `plan_kind='base'`.
- **Tenant-level** (`sellable_unit_id IS NULL`) — commercial Rate Plans: `base | derived_percentage | derived_fixed | independent` (016:90-91), parent chain guarded by `pricing_plans_self_parent_chk` (016:108-110) plus DB trigger + engine re-guard (resolve.ts:59-81).
- Room-specific rates: `pricing_plan_units` (assignment + per-unit adjustment override, 016:192-201) and `pricing_plan_unit_rates` (exact (plan, unit, date) price/restriction overlay, 016:208-218, `price >= 0` CHECK).

**Weekly/monthly logic:** there is NO special weekly/monthly engine code. In data they are ordinary derived plans: `Weekly-rate` = −15% with `default_min_stay=7`, `Monthly-rate` = −30% with `default_min_stay=30` (snapshot query, §6 below). Correct by design — one mechanism.

**Cancellation-policy link:** `pricing_plans.cancellation_policy_id` (016, loaded engine.ts:77/185) points at fee templates (`cancellation_policies` + `_tiers`, `db/migrations/011_commercial_settings.sql:49-107`). Policies never modify the nightly price; they are snapshotted immutably onto the reservation at booking with precedence OTA terms → plan's template → tenant default → NULL (`src/lib/commercial/policy-snapshot.ts:7-24`, migration 034). Non-refundable pricing is expressed as a plan's own price + an assigned policy — no hidden discount math.

---

## 2. Quote equality — does the same canonical price reach every surface? (V2 §8)

| Surface | Function traced | Canonical? |
|---|---|---|
| (a) Booking panel quote (create + edit + dblclick default) | `getStayQuoteAction` → `calculateReservationPrice` (`src/app/(dashboard)/reservations/actions.ts:1143-1165`); save path → `priceReservationStays` (actions.ts:113) | **YES** — same engine for preview and commit; comment guarantees preview ≡ stored price |
| (a') Booking panel client totals | `BookingPanel.tsx:216,590,821,889` — auto stays display `q.total` (the engine quote); manual stays display `ratePerNight × nights`, identical to the server manual rule (rules.ts:239-242) | **YES** (client mirrors, does not compute prices) |
| (b) Calendar empty-cell price strip / tooltip | direct SQL read of `pricing_plan_rates` (base plan) projected to rooms (`src/app/(dashboard)/calendar/data.ts:98-107`); fallback `price ?? room.base_price` in `RateCellTooltip.tsx:66-67` | **PARTIAL** — same canonical table + same fallback RULE, but the rule is re-implemented locally, not called (see F-2, F-3). Displays the base-ARI layer only, which equals engine mode `ratePlanId=null` |
| (c) Rate grid (/rates) | `getRateGridState` (`src/lib/rates/grid-state.ts:79-351`) — effective price from SQL `guesthub.effective_sell_state()` (`db/migrations/009_phase4a_sellable_units.sql:218-254`: `COALESCE(ppr.price, rt.base_price)`); explicit values from raw `pricing_plan_rates`; sellability re-derived through shared `collectSellReasons` (rules.ts:182-205) | **PARTIAL** — same table + same fallback rule, implemented a third time in SQL (F-2). Writes go through the ONE service `writeRateCells` (`src/lib/rates/service.ts:83-186`) |
| (d) Channex ARI projection | `projectAri` (`src/lib/channel/ari-projection.ts:206-496`) calls **the exact engine functions**: `resolveChainNightPrice` (ari-projection.ts:447-451 ≡ engine.ts:448-455), `resolveParentChain`, `mergeRestrictionRows`, `getRoomPlanRates` (ari-projection.ts:323), and the same extra-guest mechanism (ari-projection.ts:159-204). Fail-closed: unpriceable (room, plan, date) publishes `stop_sell` with NO rate, never ₪0 (ari-projection.ts:32-34, 453-459) | **YES** — shared verbatim; `scripts/check-channex-ari.mjs` asserts projected price ≡ `calculateQuote` resolvedPlanPrice |
| Simulator (/rate-plans) | `calculateReservationPrice` (`src/app/(dashboard)/rate-plans/actions.ts:560`) | **YES** |
| Group Update | `bulkUpdateRatesAction` → `applyPriceMode` (rules.ts:259-273) → `writeRateCells` (`src/app/(dashboard)/rates/actions.ts:129-183`) — a WRITE surface; reads current price + base fallback from the canonical rows | **YES** |
| Room picker average (booking panel step 1) | `planNightlyPrice` over base-plan rows, `Math.round` whole-shekel average (`reservations/actions.ts:1107-1120`) | **PARTIAL** — base layer only, ignores selected rate plan + extra guests (F-5) |

**Verdict:** there is no surface computing a *sale* price independently — every price that can be committed or published flows through `resolveChainNightPrice`/`calculateReservationPrice`, and this is mutation-verified by `scripts/check-pricing-equality.mjs` (simulator ≡ reservation seam ≡ fingerprints) and `scripts/check-channex-ari.mjs`. The residual risk is that the trivial *base-price fallback rule* exists in ~5 parallel implementations for display surfaces (F-2).

**Inbound channel bookings are deliberately NOT engine-priced:** `booking-import.ts:609-619` stores the OTA-sent amount (`rate_per_night = round2(amount/nights)`, `price_total = round2(amount)`). The OTA price is the contract; correct by design, but such stays carry no `pricing_snapshot` (F-9).

---

## 3. Restriction semantics

### 3.1 Min Stay — what GuestHub actually implements (Stage 4 must declare this)

GuestHub stores and evaluates **BOTH** semantics as separate canonical fields, never collapsed (`rules.ts:11-20`, migration 009:228):

- **`min_stay_arrival` (Arrival):** checked only on the check-in date's row — `nights < arrival.min_stay_arrival` fails (`rules.ts:65-66`).
- **`min_stay_through` (Through):** the **MAX** through-value across all occupied nights; `nights < maxThrough` fails (`rules.ts:74-88`). This is true "Through" semantics (the strictest applicable night governs).
- **Plan-level `default_min_stay`:** evaluated once per stay as a plain nights-count rule (`resolve.ts:274-275`) — behaviorally Arrival-based (applies to the stay being booked). The ARI projection consistently folds it into `min_stay_arrival` per date (`ari-projection.ts:422`), so channel behavior matches engine behavior.
- **Outbound:** both fields are sent explicitly to Channex — `min_stay_arrival` and `min_stay_through` on every restriction value (`src/lib/channel/ari-payloads.ts:187-188`), and both (with their `inherit_*` flags) are managed on the Channex Rate Plan (`rate-plan-sync.ts:346-357`). **Declaration for Stage 4: GuestHub is dual-semantics; per-date arrival = Arrival, per-date through = Through (max over occupied nights); plan default min stay maps to Arrival.**

### 3.2 CTA / CTD / Stop Sell

- **CTA** on the arrival date only (`rules.ts:64`); ARI also folds `allowed_checkin_days` (DOW rule) into per-date `closedToArrival` (`ari-projection.ts:417-419`) — an honest Channex expression of a rule Channex can't natively model.
- **CTD** on the checkout date — the engine loads the checkout row on purpose (`engine.ts:190-192`, `getRoomPlanRates` called with `toInclusive = checkOut`; validator `rules.ts:71-72`).
- **Stop sell** on any occupied night blocks the sale (`rules.ts:78-80`); engine maps commercial STOP_SELL → `ROOM_CLOSED` **with a date**, distinguishing it from a physical closure (no date) at the enforcement seam (`reservation-pricing.ts:109-118, 139-142`).
- **Overlay merge is tighten-only:** base room-night restriction ∪ plan overlay — min-stays via `max`, max-stay via `min`, booleans via OR; a plan can never open what the room closed (`resolve.ts:203-237`). Missing overlay row falls back to plan static CTA/CTD defaults; an explicit overlay `false` deliberately opens the plan layer.

### 3.3 One canonical restriction projection

Yes — `stayRestrictionViolationStructured` (rules.ts:56-90) is the single stay validator used by the engine (engine.ts:328-336), the grid/booking UI (message wrapper rules.ts:107-113), and the ARI restriction fields come from the same `mergeRestrictionRows` output (ari-projection.ts:402, 421-427). The calendar strip re-labels `min_stay_arrival` as `min_nights` for display only (`calendar/data.ts:97-107`, `inventory-rules.ts:83-90`) — it shows Arrival min but not Through min (F-7).

### 3.4 Sale-state / open-close (D75)

`classifySellState` / `collectSellReasons` (rules.ts:124-205) return ONE primary reason per (SU, date) in strict precedence — mapping → plan → physical (why zero) → commercial stop-sell → price. CTA/CTD/min/max are deliberately NOT closure reasons (they fail specific stays only, rules.ts:118-122). Physical wins over commercial (the exact conflation that once made "close" feel one-way). The grid recomputes `sellable` from the reason (grid-state.ts:264-267) because the DB `sellable` covers only availability ∧ ¬stop_sell. Open/close is two-way via `stop_sell` patches through `writeRateCells`.

### 3.5 Date ranges & valid periods

Plan validity (`valid_from`/`valid_until`) checked against check-in and **last night** (not checkout) — resolve.ts:258-262; assignment windows identically (resolve.ts:283-292); ARI marks per-date out-of-window cells stop_sell (ari-projection.ts:409-415, 430-437). Booking window `min/max_advance_days` from tenant-local today (resolve.ts:264-268). Writable rates horizon: tenant-local today → +5 calendar years, ONE rule `ratesWritableWindow` (`src/lib/dates.ts:55-74`) enforced in grid + Group Update actions (`rates/actions.ts:43-47, 75-77, 128-130`).

---

## 4. Money & VAT & currency & time discipline

### 4.1 Money representation

- **DB:** `numeric(12,2)` everywhere (`db/migrations/000_init_schema.sql:131,230-236,261`, `016:218`, `009:109`). `pricing_plan_rates.price` CHECK `>= 0` (016:218).
- **In transit:** columns are cast `::float8` into JS `number` (engine.ts:165-167, effective-state.ts:62, ledger.ts:41) — **floats, not integer minor units**. Compensating discipline: nightly prices `round2`-ed at every resolution step (resolve.ts:57, 89-94), extra-guest amounts through the property rounding rule `roundMoney` (none/unit/increment — `src/lib/commercial/extra-guest.ts:64-72`), and **totals summed in integer cents** (`cents()` engine.ts:39, 465, 481, 513) with the policy string embedded in every result (engine.ts:35-36). Explicit money inputs validated as ≤2-decimals (`extra-guest.ts:75-76`).
- **Gap:** the manual/committed fast path multiplies without rounding — `priceTotal: r * nights` (rules.ts:241) can carry float dust (e.g. 100.1×3 = 300.29999...) into `numeric(12,2)` (DB rounds on write, but JS-side totals built from it can show dust) (F-6).
- **Channex:** rates serialized as fixed 2-decimal strings `toFixed(2)` (`ari-payloads.ts:115-118`) — unambiguous.

### 4.2 VAT (Israeli model)

- Rate: per-tenant `settings->vat_rate`, default **18** (`src/lib/vat.ts:8`), range 0-50, ≤2 decimals (vat.ts:12-24). Prices are **VAT-inclusive**; VAT is *extracted for display* from the gross total: `includedVatAmount` rounds to a **whole currency unit** (`Math.round`, vat.ts:32-35); `subtotalNet = round2(gross − vat)` absorbs the remainder (engine.ts:515-516). Changing the rate never recalculates reservations (vat.ts:1-4) — the rate is snapshotted per stay (reservation-pricing.ts:60).
- **Tourist zero-rating:** NOT implemented. VAT rate is a single per-tenant scalar; there is no per-reservation / per-guest (foreign-passport) zero-rating flag anywhere in the engine or the snapshot. Under Israeli law hotel stays by foreign tourists are zero-rated per reservation, not per property — a tenant serving both populations cannot express this (F-4).

### 4.3 Currency

Single-currency per tenant (`tenants.currency`, default "ILS"); a mismatched `requestedCurrency` fails the quote (`CURRENCY_MISMATCH`, engine.ts:149-150). No conversion logic exists; inbound channel bookings store `norm.currency ?? "ILS"` (booking-import.ts:548) without conversion — an OTA booking in a non-ILS currency would be stored at face value in the foreign currency amount against ILS-denominated ledgers (F-8).

### 4.4 Timezone / date-only discipline

Strong. All stay boundaries are `DateOnly` strings, checkout-exclusive, with UTC-noon-anchored arithmetic killing DST/UTC drift (`src/lib/dates.ts:1-33`). "Today" is always tenant-local: `todayInTz(tenant.timezone || "Asia/Jerusalem")` in the engine (engine.ts:146), plan rules (resolve.ts:253-257 receives it), and rates actions (rates/actions.ts:43-47). SQL overlap twin uses the identical half-open formula (dates.ts:6-8). The D71 hydration lesson (server-format, never `toLocaleString` w/o TZ) is institutionalized.

---

## 5. Data sanity (read-only, guesthub_stage1_restore)

| Check | Result |
|---|---|
| pricing_plans total / scope split | 18 plans: 14 SU-scoped `base/is_base/active`, 4 tenant-level (1 `base` "No_Refuneble", 3 `derived_percentage`: BG +5%, Weekly −15%, Monthly −30%) |
| Scope-constraint mismatches (SU-scoped non-base; ppr.sellable_unit_id vs plan's) | **0** mismatches |
| pricing_plan_rates distribution | 14 plans with rows; largest 1,522 rows (2026-07-11→2030-09-09) incl. **728 NULL-price rows** = restriction-only rows (legal; price falls back to room-type base) — others 395-571 rows each |
| Zero / negative prices | **0** of each |
| NULL-price sellable future dates whose base fallback is 0 | **0** (room-type base prices: 450 / 680 / 980) |
| Active rooms without `included_occupancy` | **0** |
| pricing_plan_units / pricing_plan_unit_rates | 56 assignments (14 SU × 4 plans); **0** per-unit-date overrides |
| Restrictions in use | stop_sell 0, CTA 2, CTD 1, min_stay_arrival 27, min_stay_through 6,262, max_stay 4,740 |
| Tenant | ILS, Asia/Jerusalem, `vat_rate` **unset** → engine default 18, extra_guest configured=true |
| Snapshot coverage | 82 reservation_rooms; 25 with `pricing_snapshot`; without: 32 manual (created 2026-07-04/05, pre-migration-017) + 25 channel imports (by design, OTA amount is the contract) |

---

## 6. Findings

| # | Severity | Description | Evidence |
|---|---|---|---|
| F-1 | **Pass (Info)** | One canonical engine genuinely reached by every committing/publishing surface: booking-panel preview ≡ save (same engine), simulator, Channex ARI share `resolveChainNightPrice` verbatim; mutation-verified by dedicated suites | engine.ts:124-131, 445-455; ari-projection.ts:447-451; reservations/actions.ts:113, 1165; rate-plans/actions.ts:560; scripts/check-pricing-equality.mjs:1-15; scripts/check-channex-ari.mjs |
| F-2 | **Medium** | The base-price fallback rule ("plan row price, else room-type base, 0 unpriceable") is re-implemented ~5×: engine TS, ARI TS, pure `planNightlyPrice`, SQL `effective_sell_state`, calendar tooltip. Equal today, but no compiler/test ties the SQL copy to the TS copies — a future edit to one silently forks grid/calendar display from sold prices | engine.ts:419-421; ari-projection.ts:439-444; src/lib/rates/rules.ts:31-38; db/migrations/009_phase4a_sellable_units.sql:238 (`COALESCE(ppr.price, rt.base_price)`); calendar/RateCellTooltip.tsx:66-67; grid-state.ts:216 |
| F-3 | **Low** | Calendar tooltip lacks the `>0` guard: with a base_price of 0 and no row price it would display "₪0" where the engine refuses to sell (`NO_PRICE_FOR_DATE`) and the grid says `MISSING_EFFECTIVE_PRICE`. No current data hits it (all base prices > 0) | RateCellTooltip.tsx:67 vs engine.ts:419,458-461 and rules.ts:172-174 |
| F-4 | **Medium** | No tourist (foreign-guest) VAT zero-rating: VAT is one per-tenant scalar; a per-reservation zero-rate cannot be expressed, though Israeli law zero-rates tourist stays. Stage-4/Channex tax declaration should acknowledge this limitation | src/lib/vat.ts:1-35; engine.ts:144, 515; reservation-pricing.ts:60 |
| F-5 | **Low** | Room-picker `avg_price` uses the base-ARI layer only — ignores the selected rate plan (FLEX/derived %) and extra guests, and rounds to whole shekels; the step-2 live quote corrects it, but the picker can rank rooms by a price the guest won't pay | reservations/actions.ts:1107-1120 (`planNightlyPrice`, `Math.round(total/nights)`) |
| F-6 | **Low** | Float dust: manual/committed fast path computes `priceTotal = r * nights` without `round2`; JS float product of a 2-decimal rate can carry 1e-13 dust into display/DB write paths (DB numeric(12,2) rounds on write; JS-side sums built before write may not) | src/lib/rates/rules.ts:241 (`priceTotal: r * nights`), 245 by contrast rounds |
| F-7 | **Low** | Calendar restriction strip shows only `min_stay_arrival` (as `min_nights`); `min_stay_through` — the dominant restriction in live data (6,262 rows vs 27) — is invisible on the calendar, though enforced at booking | calendar/data.ts:97-107; inventory-rules.ts:83-90; snapshot counts §5 |
| F-8 | **Low** | No currency conversion on inbound channel bookings: `norm.currency ?? "ILS"` stored as-is; a non-ILS OTA amount would enter ILS-denominated totals at face value. Acceptable while the sole tenant is ILS/BDC-ILS, but unguarded | booking-import.ts:548, 609-619; engine.ts:149-150 |
| F-9 | **Info** | 32 pre-migration-017 manual stays and 25 channel stays have no `pricing_snapshot`. Committed-price immutability still holds (stored `rate_per_night` drives `snapshotByRr`), but price *explanations* are absent for those stays; channel stays are OTA-priced by design | §5 snapshot query; reservation-pricing.ts:210-215; booking-import.ts:609-619 |
| F-10 | **Info** | Edit-panel line display `ratePerNight × nights` can differ by cents from stored `price_total` when nightly prices vary (ratePerNight is the rounded average). Display-only; BookingPanel uses the engine total | EditReservationPanel.tsx:789 vs rules.ts:247-250 |
| F-11 | **Pass (Info)** | Min-stay dual semantics (Arrival + Through) stored separately, validated canonically, both published to Channex; plan default min-stay consistently mapped to Arrival in ARI | rules.ts:56-90; ari-projection.ts:422-423; ari-payloads.ts:187-188; rate-plan-sync.ts:346-357 |
| F-12 | **Pass (Info)** | Fail-closed everywhere: unpriceable night → structured error / stop_sell-no-rate; extra guest without configured amount → `EXTRA_GUEST_PRICING_INCOMPLETE`, never silent ₪0; per-stay extra-guest frequency refused for Channex rather than amortised | engine.ts:391-399, 458-461; ari-projection.ts:32-34, 176-178, 196-201 |

---

## 7. Bottom line

The pricing core is in unusually good shape for Stage 4: one engine, one seam, one write path (`writeRateCells`), one stay-validator, verbatim-shared chain resolution with the ARI projection, fail-closed refusal semantics, immutable snapshots, and disciplined date-only/tenant-TZ handling. The genuine risks are peripheral: five parallel implementations of the trivial base-price fallback (F-2), the missing tourist-VAT dimension (F-4), and unguarded currency on inbound imports (F-8). Stage 4 should declare to Channex: dual min-stay semantics (arrival + through fields both driven), VAT-inclusive ILS rates as 2-decimal strings, availability 0/1 per physical room.
