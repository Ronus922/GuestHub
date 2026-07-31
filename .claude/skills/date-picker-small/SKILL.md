---
name: date-picker-small
description: The compact GuestHub date-range picker window — trigger + in-flow two-month panel, Hebrew RTL. Use when building, restyling, debugging or porting a date-range control, when a Hebrew date string renders in the wrong visual order, or when a two-month calendar stacks instead of sitting side by side. Carries the measured bidi and container-width rules that are easy to get wrong and impossible to eyeball.
---

# Date-range picker — the compact window

One component behind every date range in the app:
`src/components/shared/DateRangeField.tsx` + `src/app/styles/date-picker.css`,
pure logic in `src/lib/date-range.ts`, guarded by `scripts/check-datepicker.mjs`.
No calendar library — `react-day-picker`, `date-fns` and friends are absent on
purpose, and adding one would fork the date model.

Consumers today: the booking wizard and the edit window (via `StayEditor`),
the reservations filter, and the rates Group Update panel. **It is shared** —
a change here reaches all four. There is no variant prop and no second picker.

## Anatomy

```
.dp-cell        trigger cell (grid-column: span 2 inside .bw-grid3)
  .dp-trigger     the canonical .field-input, as a button
  .dp-trigger-v   the range label            ← bidi rules below
.dp-after       a sibling cell pinned to the trigger's row (order: 1)
.dp-panel       in-flow panel (order: 2), container-type: inline-size
  .dp-hd          nights summary + from/to box
    .dp-sub         the range label again    ← same bidi rules
  .dp-months      relative; prev/next float at the top corners
    .dp-month       month 1 (earlier)
    .dp-sep         1px divider, side-by-side only
    .dp-m2          month 2 (later)
  .dp-ft          סגור / ביטול + status line
```

The panel is **in flow, not floating**: the drawers it lives in scroll, and an
absolutely-positioned popover gets clipped by `.dw-bd`.

## Two semantics, one component

- `mode="nights"` (default) — a stay. `to` is the check-**out**, exclusive. A
  same-day click re-anchors rather than producing a zero-night stay.
- `mode="days"` — a rates window. Every picked date is a night, `to` is
  **inclusive**, and a single day is a legal range.

`pickRange` in `src/lib/date-range.ts` owns this. Do not reimplement click
semantics in a screen.

## Write-through, no second commit

A completed range enters the form the moment it is picked (`pick` →
`onApply`). The footer only closes or restores. This is deliberate: when the
range sat as an internal draft until a "החל" button, operators picked dates,
hit the form's save, and saved the **old** ones. A picker inside a form must
never hold an invisible second commit step.

---

## RULE 1 — the Hebrew range label

**Never put `.ltr-num` on a composed Hebrew string.** `.ltr-num` is
`direction: ltr; unicode-bidi: isolate`. Applied to the whole label it makes one
LTR run over Hebrew text and bidi reorders the sentence — the check-in date ends
up on the wrong side.

Correct form — container RTL, each date its own isolated `<bdi>`:

```jsx
<span className="dp-trigger-v" dir="rtl">
  <bdi className="dp-date">{hebDay(from)}</bdi> –{" "}
  <bdi className="dp-date">{hebDay(to)}</bdi> {to.slice(0, 4)}
</span>
```

`.dp-date` is `font-variant-numeric: tabular-nums` and **nothing else**.

The trap: it is tempting to reach for `.ltr-num` on the `<bdi>` "to keep the
digit order". Don't. **Bidi never reorders digits inside a number** — `21` can
never become `12`, and `unicode-bidi: isolate` alone already guarantees it.
What `direction: ltr` adds is a base direction for the isolated run, which
pushes the day number to the LEFT of the month name: `9 באוגוסט` renders as
`באוגוסט 9`.

Measured in Chrome, same markup, only the class differing:

| token class | digit x | month x | result |
|---|---|---|---|
| `ltr-num` (isolate + **direction:ltr**) | 621.9 | 639.9 | digit LEFT — wrong |
| `dp-date` (tabular only) | 716.2 | 640.7 | digit RIGHT — correct |

Never reverse strings in JS to fix bidi. Fix it at the markup level.

## RULE 2 — two months side by side

The JSX already renders two months driven by one `view` state with a single
pair of arrows, so `shiftMonth(view, ±1)` moves the pair. Whether they sit side
by side is **purely a width question**, decided by a container query on
`.dp-panel`.

```css
@container (min-width: 626px) { .dp-month, .dp-m2 { flex: 1 1 0 } .dp-sep { display: block } }
```

`container-type: inline-size` queries the **content box**, not the border box.
Getting this wrong is the classic mistake — the booking panel's border box is
680px but the number that matters is 637px:

```
768  SidePanel w-[60%] at a 1280px viewport
−48  .dw-bd padding
−40  .bw-roomcard padding
−43  .dp-panel border (1.5×2) + padding (20×2)
=637 the width the container query actually sees
```

**Why 626 and not a rounder number.** Measured sweep on the shipped CSS:

| content width | cell width | layout |
|---|---|---|
| 621px | 87.57px | stacked |
| 625px | 88.14px | stacked |
| **626px** | **44.07px** | side by side |
| 634px | 44.64px | side by side |
| 638px | 44.93px | side by side |

626 is the lowest width where the pair engages **while the cell stays ≥44px**.
At 620 it engages at 43.71px, which means the act of going side-by-side would
itself shrink a touch target below iron rule #6. Re-measure before moving it.

**The cell never gives.** Fitting the pair came from trimming `.dp-month`
padding `8px → 4px` (16px recovered), not from shrinking cells or fonts. Day
cell height stays 44px everywhere. Below the breakpoint both months still
render, stacked — the month count is never what gets hidden.

RTL: the earlier month lands on the RIGHT, `dp-nav-next` (‹) on the left edge.
Both come free from `dir="rtl"` plus `inset-inline-*`; do not hardcode
left/right.

The range bar (`.dp-in` / `.dp-edge`) compares date strings, so it spans a month
boundary with no special case. `.dp-grid` has no gap so the tint is continuous.

---

## Measure it, don't look at it

Both rules above are invisible to the eye and unprovable from a screenshot. Use
headless Chrome and read geometry back as text:

```bash
google-chrome --headless --disable-gpu --no-sandbox --virtual-time-budget=3000 \
  --window-size=780,1500 --dump-dom "file://$PWD/harness.html"
```

Build a harness that inlines the real `date-picker.css` (strip the
`@layer components {` wrapper), renders the markup, and writes its measurements
into a `<pre>` the dump can read. What to assert:

- token order — `getBoundingClientRect().left` of the check-in `<bdi>` must be
  **greater** than the check-out one
- order inside a token — a `Range` over char 0 vs chars 2..end; the digit's
  `left` must be greater than the month name's
- side by side — both `.dp-grid` elements share a `top`
- RTL order — month 1's `left` greater than month 2's
- cell width `grid.width / 7 >= 44`, cell height `>= 44`
- range continuity — the marked set includes both sides of the boundary
  (`2026-08-31` and `2026-09-01`)

Test a same-month range **and** a cross-month one (28/08 – 03/09). Same-month
alone hides the boundary bugs.

## Do not break

- `scripts/check-datepicker.mjs` must pass — it pins click semantics for both
  modes, the month grid, and the StayEditor / Group Update wiring.
- Never name a physical direction (`left:` / `right:`); use `inset-inline-*`,
  `margin-inline-*`, `text-align: start`. `check:design` fails on physical
  direction and it is not a value rule, so `ds-allow:` will not silence it.
- Design tokens only. Radii `{16,12,10,8,7}`, type scale
  `{12,13.5,14,15,17,19,21,32}`, four shadows, no raw hex.

## Check the tree before trusting this document

Both rules shipped (merge `6c46fb4`). Rather than trust a date, verify the tree
you are actually in — this costs a second and catches an old checkout, a
worktree branched before the fix, or a regression:

```bash
grep -c 'bdi className="dp-date"' src/components/shared/DateRangeField.tsx  # expect 4
grep -n '@container (min-width: 626px)' src/app/styles/date-picker.css      # expect 1
grep -n 'ltr-num' src/components/shared/DateRangeField.tsx  # .dp-box-v ×2, day cell ×1
```

If the first two come back empty you are on code that predates RULE 1 / RULE 2:
the label will read in the wrong order and the months will stack in the booking
panel. Fix it there rather than working around it here.

Three uses of `.ltr-num` legitimately remain, and they are the counter-example
worth understanding: `.dp-box-v` renders `formatFullDate` output (`21/08/2026`)
and the day cell renders a bare number. Both are **pure numeric tokens with no
Hebrew in them**, so forcing an LTR run is correct. RULE 1 is about *composed*
strings that mix Hebrew words with numbers — not about every number in the
panel. Ask "does this string contain Hebrew?" before reaching for either class.
