// The JS half of the breakpoint ladder. The CSS half is the Tailwind v4 default
// scale, documented at the top of app/styles/responsive.css.
//
// Why this file exists: `matchMedia("(max-width: 767px)")` was written out by
// hand twice inside Shell.tsx, and had to stay in lockstep with the `md:`
// utilities on Sidebar.tsx that actually move the nav off-canvas. Two hardcoded
// copies of a threshold that a third file depends on is a defect waiting to
// happen — the drawer would open while the sidebar was still in flow, or the
// other way round.
//
// 767.98 rather than 767: a viewport can be a fractional width (browser zoom,
// devicePixelRatio quirks), and `max-width: 767px` leaves 767.5px matching
// neither this query nor `md:`. The .98 convention closes that gap.

/** Tailwind's `md` — the width at which the app becomes a desktop layout. */
export const MD_BREAKPOINT_PX = 768;

/** True below `md`: the sidebar is an off-canvas drawer and dense tables show as cards. */
export const BELOW_MD_QUERY = `(max-width: ${MD_BREAKPOINT_PX - 0.02}px)`;

/** Matches BELOW_MD_QUERY. SSR-safe: returns false when there is no window. */
export function matchesBelowMd(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(BELOW_MD_QUERY).matches;
}
