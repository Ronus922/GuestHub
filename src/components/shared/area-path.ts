// ============================================================
// PURE chart geometry — no imports, no React, so the guard can compile and
// assert it directly (the donut-arcs.ts pattern).
//
// Catmull-Rom → cubic Bézier. A polyline through monthly revenue reads as
// twelve decisions; the design (§4.2) asks for a smooth area, and Catmull-Rom
// is the spline that PASSES THROUGH every point rather than near it — which
// matters when a point is a number the operator can also read in a tooltip.
//
// The viewBox is fixed (1000×300) and the SVG scales with `width: 100%`, so the
// path never has to be recomputed on resize and the chart cannot disagree with
// itself between server render and client hydration.
// ============================================================

export const CHART_VIEW_W = 1000;
export const CHART_VIEW_H = 300;
/** room for the month labels under the plot */
export const CHART_PAD_BOTTOM = 34;
/** so the peak's stroke is not clipped by the top edge */
export const CHART_PAD_TOP = 14;

export type ChartPoint = { x: number; y: number };

/**
 * Map values to points across the full width. A single value sits in the
 * middle; N values are spread edge to edge so the first and last months are not
 * floating in whitespace.
 *
 * `max` is passed in rather than derived so several series can share a scale.
 * A zero or negative max flattens everything to the baseline instead of
 * dividing by zero — twelve empty months are a real state, not an error.
 */
export function chartPoints(values: readonly number[], max: number): ChartPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const plotH = CHART_VIEW_H - CHART_PAD_BOTTOM - CHART_PAD_TOP;
  const baseline = CHART_VIEW_H - CHART_PAD_BOTTOM;
  if (n === 1) return [{ x: CHART_VIEW_W / 2, y: max > 0 ? baseline - (values[0] / max) * plotH : baseline }];
  return values.map((v, i) => ({
    x: (i / (n - 1)) * CHART_VIEW_W,
    y: max > 0 ? baseline - (Math.max(0, v) / max) * plotH : baseline,
  }));
}

/**
 * A smooth open curve through every point.
 *
 * The control points are the Catmull-Rom tangents scaled by 1/6 — the standard
 * conversion to cubic Bézier. Endpoints duplicate their neighbour so the curve
 * starts and ends without a phantom overshoot, which is what makes a spline dip
 * below zero on a series that begins at zero.
 */
export function smoothLinePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const p = points;
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(p2.x)} ${round(p2.y)}`;
  }
  return d;
}

/** The same curve, closed down to the baseline — the filled area. */
export function smoothAreaPath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  const baseline = CHART_VIEW_H - CHART_PAD_BOTTOM;
  const line = smoothLinePath(points);
  const last = points[points.length - 1];
  const first = points[0];
  return `${line} L ${round(last.x)} ${baseline} L ${round(first.x)} ${baseline} Z`;
}

/** Which point a pointer at `xRatio` (0–1 of the width) is nearest. */
export function nearestIndex(count: number, xRatio: number): number {
  if (count <= 1) return 0;
  const i = Math.round(xRatio * (count - 1));
  return Math.min(count - 1, Math.max(0, i));
}

// two decimals is well under a device pixel at any render width, and keeps the
// path string short enough to read in devtools
const round = (n: number) => Math.round(n * 100) / 100;
