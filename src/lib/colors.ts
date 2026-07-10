// PURE color helpers — no imports. Workflow-status tags carry an arbitrary
// tenant-chosen background; the text color is DERIVED (WCAG), never stored.

export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

// WCAG relative luminance (sRGB) → readable text color for a solid background.
// Threshold 0.42 keeps mid-saturation brand colors (#EA9314, #16A34A) on white
// text while light pastels flip to dark text.
export function readableTextColor(hex: string): "#0B1220" | "#FFFFFF" {
  if (!HEX_COLOR_RE.test(hex)) return "#0B1220";
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.42 ? "#0B1220" : "#FFFFFF";
}

// The design-system palette offered by the status color picker — the hex
// values already used by the seeded lookup lists (Settings reference).
export const STATUS_PALETTE = [
  "#2540C8", // primary blue
  "#16A34A", // success green
  "#EA9314", // warning amber
  "#DC2626", // danger red
  "#E11D48", // rose
  "#0B6E7A", // teal
  "#7C3AED", // purple
  "#64748B", // slate
  "#475569", // dark slate
  "#6B7385", // gray
] as const;
