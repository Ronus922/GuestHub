// ============================================================
// PURE per-night revenue expansion — no imports, no DB, so
// scripts/check-nightly-revenue.mjs can compile and assert it directly (the
// same pattern as inventory-rules.ts and channel/ranges.ts).
//
// WHY THIS EXISTS. Every money figure on the dashboard must come from ONE
// definition. The pre-existing revenueReport (reports/queries.ts) clips its
// NIGHT count to the window but not its revenue: it adds each stay's ENTIRE
// price_total to every month the stay touches, so a 23-night July→August stay
// contributes its full total to both months and twelve monthly calls do not
// sum to the year. Per-night expansion fixes that by construction — a night
// belongs to exactly one date, so no date can claim another's money.
//
// TWO PATHS, AND WHY THE CHOICE IS NOT "SNAPSHOT IF PRESENT":
//
//   · pricing_snapshot.nightly[] carries {date, nightTotal} per night and is
//     the real per-date breakdown. Preferred.
//   · price_total / nights, spread evenly, when there is no usable snapshot.
//
// A snapshot is only usable when its nights EXACTLY cover [check_in,
// check_out). Measured on production 2026-08-03: of 64 rows carrying a
// nightly[], 9 no longer matched the stay's dates and 10 summed to something
// other than price_total — a stay re-dated after it was priced keeps the old
// snapshot. Trusting those dates would attribute revenue to nights the guest
// is not staying, which is the same class of defect as the one above. So a
// stale snapshot falls back, and says so.
//
// The caller is handed BOTH the number and how it was made: per-day fallback
// amounts and per-row provenance. A blend of two definitions that cannot be
// told apart is exactly what this module exists to prevent — so the blend is
// always reportable.
//
// VAT: every stored price is VAT-INCLUSIVE (priceIncludesVat: true on the live
// snapshots, 18%). This module neither adds nor removes VAT; every figure it
// returns is gross, and the UI must say so.
// ============================================================

/** YYYY-MM-DD */
export type RevenueDate = string;

export type NightlyRevenueRow = {
  /** reservation_rooms.id — the provenance key */
  rrId: string;
  checkIn: RevenueDate;
  checkOut: RevenueDate; // exclusive, hotel-night semantics
  /** reservation_rooms.price_total, VAT-inclusive */
  priceTotal: number;
  /** pricing_snapshot.nightly[], or null/[] when absent */
  nightly: readonly { date: RevenueDate; nightTotal: number }[] | null;
};

export type RevenuePath = "snapshot" | "even_split";
/** why a row fell back — absent when the row used its snapshot */
export type FallbackReason = "no_snapshot" | "stale_snapshot";

export type RowProvenance = {
  rrId: string;
  path: RevenuePath;
  reason?: FallbackReason;
};

export type NightlyRevenueDay = {
  date: RevenueDate;
  /** VAT-inclusive revenue attributed to this night */
  revenue: number;
  /** how much of `revenue` came from the even-split fallback */
  fallbackRevenue: number;
};

export type NightlyRevenueBreakdown = {
  /** one entry per date in [from, to), ascending, zero-filled */
  days: NightlyRevenueDay[];
  total: number;
  fallbackTotal: number;
  rows: { total: number; snapshot: number; evenSplit: number };
  provenance: RowProvenance[];
};

// ---- tiny date helpers, deliberately local ---------------------------------
// This module stays import-free so the check script can compile it alone.
// These are date-ONLY (no timezone, no clock) and mirror lib/dates semantics.
const MS_DAY = 86_400_000;

function toUtc(d: RevenueDate): number {
  return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
}
function fromUtc(ms: number): RevenueDate {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDaysUtc(d: RevenueDate, n: number): RevenueDate {
  return fromUtc(toUtc(d) + n * MS_DAY);
}
export function nightsBetweenUtc(from: RevenueDate, to: RevenueDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_DAY);
}

/** agorot in, agorot out — money never accumulates in floats */
const toAgorot = (n: number) => Math.round(n * 100);
const toMajor = (a: number) => Math.round(a) / 100;

/**
 * Split a total into `nights` parts whose sum is EXACTLY the total.
 * Naive `total/nights` rounded per night drifts: ₪1000 over 3 nights becomes
 * 333.33×3 = 999.99 and the year stops summing to the year. Cumulative
 * rounding makes every part exact and the remainder land on one night.
 */
export function evenSplitAgorot(totalAgorot: number, nights: number): number[] {
  if (nights <= 0) return [];
  const out: number[] = [];
  let prev = 0;
  for (let i = 1; i <= nights; i++) {
    const cum = Math.round((totalAgorot * i) / nights);
    out.push(cum - prev);
    prev = cum;
  }
  return out;
}

/**
 * Is this snapshot safe to attribute per-date? Only when its nights are
 * exactly the stay's nights — same count, same dates, no gaps, no strays.
 */
export function snapshotCoversStay(row: NightlyRevenueRow): boolean {
  const nights = nightsBetweenUtc(row.checkIn, row.checkOut);
  if (nights <= 0) return false;
  const nightly = row.nightly;
  if (!nightly || nightly.length !== nights) return false;
  const want = new Set<string>();
  for (let i = 0; i < nights; i++) want.add(addDaysUtc(row.checkIn, i));
  for (const n of nightly) {
    if (!want.delete(n.date)) return false; // stray or duplicate date
  }
  return want.size === 0;
}

/**
 * Expand stays into per-DATE revenue over [from, to) — `from` inclusive,
 * `to` EXCLUSIVE, the same half-open window every other date range in this
 * codebase uses. Nights outside the window are dropped, never redistributed:
 * a night belongs to its own date or to nothing.
 */
export function expandNightlyRevenue(
  rows: readonly NightlyRevenueRow[],
  from: RevenueDate,
  to: RevenueDate,
): NightlyRevenueBreakdown {
  const span = nightsBetweenUtc(from, to);
  const byDate = new Map<RevenueDate, { revenue: number; fallback: number }>();
  for (let i = 0; i < Math.max(0, span); i++) {
    byDate.set(addDaysUtc(from, i), { revenue: 0, fallback: 0 });
  }

  const provenance: RowProvenance[] = [];
  let snapshotRows = 0;
  let evenSplitRows = 0;

  const add = (date: RevenueDate, agorot: number, isFallback: boolean) => {
    const cell = byDate.get(date);
    if (!cell) return; // outside the window
    cell.revenue += agorot;
    if (isFallback) cell.fallback += agorot;
  };

  for (const row of rows) {
    const nights = nightsBetweenUtc(row.checkIn, row.checkOut);
    if (nights <= 0) continue; // a zero/negative stay owns no night

    if (snapshotCoversStay(row)) {
      snapshotRows++;
      provenance.push({ rrId: row.rrId, path: "snapshot" });
      for (const n of row.nightly!) add(n.date, toAgorot(n.nightTotal), false);
      continue;
    }

    evenSplitRows++;
    provenance.push({
      rrId: row.rrId,
      path: "even_split",
      reason: row.nightly && row.nightly.length > 0 ? "stale_snapshot" : "no_snapshot",
    });
    const parts = evenSplitAgorot(toAgorot(row.priceTotal), nights);
    for (let i = 0; i < nights; i++) add(addDaysUtc(row.checkIn, i), parts[i], true);
  }

  const days: NightlyRevenueDay[] = [];
  let total = 0;
  let fallbackTotal = 0;
  for (const [date, cell] of byDate) {
    days.push({ date, revenue: toMajor(cell.revenue), fallbackRevenue: toMajor(cell.fallback) });
    total += cell.revenue;
    fallbackTotal += cell.fallback;
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    days,
    total: toMajor(total),
    fallbackTotal: toMajor(fallbackTotal),
    rows: { total: rows.length, snapshot: snapshotRows, evenSplit: evenSplitRows },
    provenance,
  };
}
