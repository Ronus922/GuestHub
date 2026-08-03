"use client";

import { useMemo, useState } from "react";
import {
  CHART_PAD_BOTTOM,
  CHART_VIEW_H,
  CHART_VIEW_W,
  chartPoints,
  nearestIndex,
  smoothAreaPath,
  smoothLinePath,
} from "@/components/shared/area-path";
import type { MonthlyRevenuePoint } from "@/lib/reports/monthly-revenue";

// ============================================================
// rev — הכנסות 12 החודשים (DeshbordMain.md §4.2).
//
// Every figure comes from monthlyRevenue(), which is the per-night attribution
// the KPI and the sources breakdown also use. There is no second revenue
// definition on this screen.
//
// NUMBERS ARE LTR VIA AN INNER SPAN, never .ltr-num on a block: on a block it
// carries `direction: ltr` and flips the whole line's start edge, which is the
// bug PR #151 fixed on the KPI value. Every digit below is wrapped inline.
//
// The current month renders and is LABELLED חלקי rather than hidden or
// extrapolated. Recognition is by stay-night, so "partial" means one precise
// thing: the month still has nights ahead of it.
// ============================================================

const MONTHS_HE = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];

const shortMonth = (m: string) => MONTHS_HE[Number(m.slice(5, 7)) - 1].slice(0, 3);
const fullMonth = (m: string) => `${MONTHS_HE[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const ils = (n: number) => `₪${Math.round(n).toLocaleString("he-IL")}`;

export function RevenueWindow({
  series,
  chartMonths = 12,
}: {
  series: MonthlyRevenuePoint[];
  /** design §4.2: range 6–12 */
  chartMonths?: number;
}) {
  const months = Math.max(6, Math.min(12, Math.round(chartMonths)));
  const points = useMemo(() => series.slice(-months), [series, months]);
  const [hover, setHover] = useState<number | null>(null);

  const max = useMemo(() => Math.max(0, ...points.map((p) => p.revenue)), [points]);
  const geo = useMemo(() => chartPoints(points.map((p) => p.revenue), max), [points, max]);

  if (points.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין נתוני הכנסה להצגה</span>
      </div>
    );
  }

  const active = hover === null ? null : points[hover];
  const activePt = hover === null ? null : geo[hover];
  const total = points.reduce((a, p) => a + p.revenue, 0);
  // a figure blended from two definitions must say so — the share of this
  // window's revenue that came from the even-split fallback rather than a
  // stay's own per-night snapshot
  const fallbackAgorot = points.reduce(
    (a, p) => a + Math.round((p.revenue * p.fallbackSharePct) / 100 * 100),
    0,
  );
  const fallbackPct = total > 0 ? Math.round((fallbackAgorot / (total * 100)) * 1000) / 10 : 0;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    // RTL: the SVG's own x axis runs left→right regardless of direction, and
    // getBoundingClientRect is in viewport space — so the ratio is computed
    // from the box's left edge in both writing directions
    const ratio = (e.clientX - box.left) / box.width;
    setHover(nearestIndex(points.length, Math.min(1, Math.max(0, ratio))));
  };

  return (
    <div className="rev">
      <div className="rev-head">
        <span className="rev-total">
          <span className="ltr-num">{ils(total)}</span>
        </span>
        <span className="rev-total-lbl">
          סה״כ {points.length} החודשים האחרונים
        </span>
      </div>

      <div className="rev-chart">
        {/* ds-allow: a chart IS its SVG — <Icon> renders ligatures, not curves */}
        <svg
          viewBox={`0 0 ${CHART_VIEW_W} ${CHART_VIEW_H}`}
          className="rev-svg"
          preserveAspectRatio="none"
          role="img"
          aria-label={`הכנסות ${points.length} החודשים האחרונים`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="rev-fill-top" />
              <stop offset="100%" className="rev-fill-bottom" />
            </linearGradient>
          </defs>
          <line
            className="rev-baseline"
            x1="0"
            x2={CHART_VIEW_W}
            y1={CHART_VIEW_H - CHART_PAD_BOTTOM}
            y2={CHART_VIEW_H - CHART_PAD_BOTTOM}
          />
          <path className="rev-area" d={smoothAreaPath(geo)} fill="url(#revFill)" />
          <path className="rev-line" d={smoothLinePath(geo)} />
          {activePt && (
            <>
              <line
                className="rev-cursor"
                x1={activePt.x}
                x2={activePt.x}
                y1={0}
                y2={CHART_VIEW_H - CHART_PAD_BOTTOM}
              />
              <circle className="rev-dot" cx={activePt.x} cy={activePt.y} r={7} />
            </>
          )}
        </svg>

        {active && (
          <div
            className="rev-tip"
            style={{ insetInlineStart: `${(geo[hover!].x / CHART_VIEW_W) * 100}%` }}
          >
            <span className="rev-tip-m">
              {fullMonth(active.month)}
              {active.partial && " · חלקי"}
            </span>
            <span className="rev-tip-r">
              <span className="ltr-num">{ils(active.revenue)}</span>
            </span>
            <span className="rev-tip-o">
              תפוסה <span className="ltr-num">{active.occupancyPct}%</span>
            </span>
          </div>
        )}
      </div>

      <div className="rev-axis">
        {points.map((p, i) => (
          <span key={p.month} className={`rev-axis-m${i === hover ? " on" : ""}`}>
            {shortMonth(p.month)}
            {p.partial && <span className="rev-partial">חלקי</span>}
          </span>
        ))}
      </div>

      <p className="rev-foot">
        כולל מע״מ
        {fallbackPct > 0 && (
          <>
            {" · "}
            <span className="ltr-num">{fallbackPct}%</span> מהסכום חושב בפריסה שווה
          </>
        )}
      </p>
    </div>
  );
}
