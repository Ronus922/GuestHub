// ============================================================
// Donut arc geometry — PURE. No React, no DOM, no colour.
//
// This module exists so the three traps InvitationSources.md §10 records can be
// SOLVED ONCE and then TESTED, instead of being re-derived (and re-broken) at
// every call site. The renderer (./Donut.tsx) does nothing but map these
// numbers onto <circle> attributes.
//
//  1. `stroke-dashoffset` ACCUMULATES NEGATIVELY. Each slice starts where the
//     previous one ended, and SVG walks the dash pattern backwards, so the
//     offset of slice n is −(sum of the lengths before it). Writing a positive
//     offset, or resetting it per slice, stacks every arc on 12 o'clock.
//  2. The −90° rotation belongs on the <svg>, not on each <circle>. Rotating
//     each circle rotates each around its own centre and the ring comes apart.
//     That is the renderer's job; this module simply reports lengths measured
//     from 12 o'clock, so the caller has nothing left to decide.
//  3. `dash` is "len rest", never "len circumference" — the remainder must be
//     the UNPAINTED part or the arc wraps past its own end.
// ============================================================

export type DonutSlice = {
  /** stable key — never the array index (slices reorder when filtered) */
  id: string;
  label: string;
  /** any non-negative number; the caller does not pre-compute percentages */
  value: number;
  /** stroke colour, supplied by the caller (this module declares none) */
  color: string;
};

export type DonutArc = {
  id: string;
  label: string;
  value: number;
  color: string;
  /** share of the total, 0..1 */
  fraction: number;
  /** `stroke-dasharray` — "<painted> <unpainted>" */
  dash: string;
  /** `stroke-dashoffset` — zero or NEGATIVE, accumulating (trap 1) */
  offset: number;
};

export type DonutGeometry = {
  /** viewBox is always 0 0 200 200; `size` only scales the rendered box */
  viewBox: string;
  center: number;
  radius: number;
  strokeWidth: number;
  circumference: number;
  arcs: DonutArc[];
  total: number;
};

/** the reference's ring: r=70 with a 34px stroke inside a 200×200 box */
const VIEW = 200;
const CENTER = VIEW / 2;
const RADIUS = 70;
const STROKE = 34;

/**
 * Lay out one donut. Zero-valued and negative slices are dropped (a 0-length
 * arc still paints a round line-cap dot at its start angle, which reads as a
 * real slice); a total of 0 yields no arcs at all, and the caller renders the
 * track ring alone.
 */
export function donutArcs(
  slices: readonly DonutSlice[],
  opts?: { radius?: number; strokeWidth?: number },
): DonutGeometry {
  const radius = opts?.radius ?? RADIUS;
  const strokeWidth = opts?.strokeWidth ?? STROKE;
  const circumference = 2 * Math.PI * radius;

  const usable = slices.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = usable.reduce((sum, s) => sum + s.value, 0);

  const arcs: DonutArc[] = [];
  let consumed = 0; // painted length so far, measured from 12 o'clock
  for (const s of usable) {
    const fraction = total > 0 ? s.value / total : 0;
    const len = circumference * fraction;
    const before = round(consumed);
    arcs.push({
      id: s.id,
      label: s.label,
      value: s.value,
      color: s.color,
      fraction,
      // trap 3 — the second number is the UNPAINTED remainder
      dash: `${round(len)} ${round(circumference - len)}`,
      // trap 1 — negative and accumulating. The first arc is 0, never -0:
      // negative zero serialises as "-0" in the DOM attribute and in every
      // snapshot that ever compares two of these.
      offset: before === 0 ? 0 : -before,
    });
    consumed += len;
  }

  return {
    viewBox: `0 0 ${VIEW} ${VIEW}`,
    center: CENTER,
    radius,
    strokeWidth,
    circumference: round(circumference),
    arcs,
    total,
  };
}

/** three decimals is well below one device pixel at any size we render */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
