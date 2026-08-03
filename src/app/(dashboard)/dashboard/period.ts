import type { RevenueDate } from "@/lib/reports/nightly-revenue-rules";

// The drawer's three periods, as half-open [from, to) spans — the same window
// convention every date range in this codebase uses. Pure and import-light so
// both the server action and the check script can use it.
//
// Anchored on the property's `today`, never on the server's clock: the caller
// passes the date it already derived from todayInTz(tenants.timezone).

export type SourcesPeriod = "month" | "quarter" | "year";

const pad = (n: number) => String(n).padStart(2, "0");

export function periodSpan(today: RevenueDate, period: SourcesPeriod): { from: RevenueDate; to: RevenueDate } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)); // 1–12
  if (period === "year") return { from: `${y}-01-01`, to: `${y + 1}-01-01` };
  if (period === "quarter") {
    const q = Math.floor((m - 1) / 3); // 0–3
    const startMonth = q * 3 + 1;
    const endMonth = startMonth + 3;
    return endMonth > 12
      ? { from: `${y}-${pad(startMonth)}-01`, to: `${y + 1}-01-01` }
      : { from: `${y}-${pad(startMonth)}-01`, to: `${y}-${pad(endMonth)}-01` };
  }
  return m === 12
    ? { from: `${y}-12-01`, to: `${y + 1}-01-01` }
    : { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m + 1)}-01` };
}

export const PERIOD_LABEL: Record<SourcesPeriod, string> = {
  month: "חודש",
  quarter: "רבעון",
  year: "שנה",
};
