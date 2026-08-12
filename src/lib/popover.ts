// §8's popover geometry, in one place.
//
// The 316px width and the 12px viewport margin were written out by hand in three
// places that all had to agree: the `.popover` rule in design-system.css, POP_W
// in ReservationTooltip.tsx, and a `window.innerWidth - 328` literal in
// RoomsScreen.tsx (316 + 12, folded together so the relationship was invisible).
// A comment in each said it "MUST mirror" the others, which is what you write
// when the language cannot enforce it.
//
// It matters more now: `.popover` gained `max-width: calc(100vw - 24px)`, so on a
// narrow screen the rendered width is NOT 316 any more. Clamp math that assumes
// 316 would push the box further from the trigger than it needs to be — hence
// popoverWidth(), which reports what the popover will actually measure.

/** §8 nominal width — mirrors `.popover { width: 316px }` in design-system.css. */
export const POPOVER_WIDTH = 316;

/** §8 viewport margin, applied on both sides. */
export const POPOVER_MARGIN = 12;

/** What `.popover` will actually render at, given its max-width cap. */
export function popoverWidth(viewportWidth: number): number {
  return Math.min(POPOVER_WIDTH, viewportWidth - POPOVER_MARGIN * 2);
}

/**
 * Clamp a desired inline-start (physical `left`) so the popover stays fully on
 * screen with §8's margin on both sides. Returns the margin itself when the
 * viewport is too narrow for any other answer.
 */
export function clampPopoverLeft(desiredLeft: number, viewportWidth: number): number {
  const maxLeft = viewportWidth - popoverWidth(viewportWidth) - POPOVER_MARGIN;
  return Math.max(POPOVER_MARGIN, Math.min(desiredLeft, maxLeft));
}
