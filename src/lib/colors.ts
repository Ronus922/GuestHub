// TOKEN DECLARATION file (with lib/status-colors.ts): one of the only two
// TypeScript files allowed to hold raw colour literals — every value below is an
// approved token from GUIDELINES §1/§3.1.
//
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

// The palette offered by the status colour picker — ONLY approved tokens
// (GUIDELINES §1). A tenant cannot pick a colour the design system does not own.
export const STATUS_PALETTE = [
  "#2540C8", // --brand
  "#16A34A", // --ok
  "#EA9314", // --warn
  "#E5484D", // --danger
  "#8B5CF6", // --info
  "#F5B04C", // --vip
  "#6B7385", // --muted
  "#9AA1B4", // --faint
  "#1B2233", // --ink
  "#475569", // §3.1 "הוחזר" dot
] as const;

// ---- status tint family (D77.1) ----
// A tenant-configured status color drives a WHOLE pill: soft tinted
// background, the color itself as border, and a text shade darkened until it
// reads on the tint — matching the reference pill families
// (ref/screens/GuesthubCalandr.png) for ANY hex the tenant picks.

// ---- email palette ----
// An HTML email cannot read a CSS variable: every colour must be an inline
// literal in the sent bytes. These are the SAME §1 tokens as design-system.css,
// declared here (a token file) so the renderer consumes them instead of
// inventing hexes of its own.
export const EMAIL_PALETTE = {
  brand: "#2540C8",
  brandDark: "#1C2E9A",
  brandSoft: "#EEF1FD",
  brandLine: "#DFE5FB",
  ink: "#1B2233",
  muted: "#6B7385",
  faint: "#9AA1B4",
  line: "#E7EAF1",
  surface: "#FFFFFF",
  fieldBg: "#F7F8FB",
  bg: "#F1F3F8",
  ok: "#16A34A",
  danger: "#E5484D",
} as const;

// ---- reservation channel identity ----
// The ONE channel map (calendar pill badge, reservation popover, legend): key,
// glyph, brand colors, display name. Declared HERE because this is a token
// file — the brand hexes may not appear anywhere else. The badge itself is
// <ChannelBadge>; nobody re-types a glyph or a color at a call site.
// The four EXTERNAL channels shown in the legend. A reservation created by hand
// inside GuestHub (phone/walk_in/unknown/NULL source) is "manual" — it wears the
// pencil badge on its pill but is NOT a legend channel.
export type VisibleChannel = "booking" | "airbnb" | "expedia" | "site";
/** every reservation resolves to one of these for its pill badge (never null) */
export type BadgeChannel = VisibleChannel | "manual";

export const CHANNEL_ORDER: readonly VisibleChannel[] = [
  "booking",
  "airbnb",
  "expedia",
  "site",
] as const;

// glyph = single letter; icon = Material Symbol (rendered by <Icon>) — a channel
// uses one or the other. site/manual are pictograms per the calendar reference.
export const CHANNEL_CONFIG: Record<
  BadgeChannel,
  { glyph?: string; icon?: "globe" | "edit"; bg: string; tx: string; name: string }
> = {
  booking: { glyph: "B", bg: "#003580", tx: "#FFFFFF", name: "Booking.com" },
  airbnb: { glyph: "A", bg: "#FF5A5F", tx: "#FFFFFF", name: "Airbnb" },
  expedia: { glyph: "E", bg: "#FFC400", tx: "#1B2233", name: "Expedia" },
  site: { icon: "globe", bg: "#2540C8", tx: "#FFFFFF", name: "אתר המלון" },
  manual: { icon: "edit", bg: "#E6E9F0", tx: "#5B6478", name: "הזמנה ידנית" },
};

// lookup_items(booking_sources).key → visible channel, or null. The canonical
// source field is reservations.source_id; imported bookings get
// booking_com/airbnb/expedia via otaSourceKey (booking-normalize.ts),
// operator-entered ones carry the tenant's keys (direct/phone/walk_in).
// Internal, unknown, or NULL sources return null — the caller renders nothing,
// never a placeholder and never a guessed brand.
// 'system' (מהמערכת, seeded by migration 056) is deliberately absent below: it
// is an INTERNAL source, so it falls through to null → the 'manual' badge, and
// EditReservationPanel's `externalReservation` stays false, keeping the
// reservation's fields editable. Adding it to a case would silently lock them.
export function normalizeVisibleChannel(
  sourceKey: string | null | undefined,
): VisibleChannel | null {
  switch (sourceKey) {
    case "booking_com":
    case "booking":
      return "booking";
    case "airbnb":
      return "airbnb";
    case "expedia":
      return "expedia";
    case "direct":
    case "site":
    case "website":
      return "site";
    default:
      return null;
  }
}

// EVERY reservation gets a pill badge: its external channel, or the "manual"
// pencil for internal/unknown sources. Use this for the badge; keep
// normalizeVisibleChannel for the "is this an OTA booking?" semantic check.
export function resolveChannelBadge(
  sourceKey: string | null | undefined,
): BadgeChannel {
  return normalizeVisibleChannel(sourceKey) ?? "manual";
}

export type TintPalette = { bg: string; bd: string; tx: string };

// the approved neutral family (§3.1 "בוטל")
const NEUTRAL_TINT: TintPalette = { bg: "#F1F3F6", bd: "#C9D0DA", tx: "#5B6478" };

export function statusTintPalette(hex: string | null | undefined): TintPalette {
  if (!hex || !HEX_COLOR_RE.test(hex)) return NEUTRAL_TINT;
  const ch = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const toHex = (r: number, g: number, b: number) =>
    "#" +
    [r, g, b]
      .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  const srgb = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const luminance = (r: number, g: number, b: number) =>
    0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);

  const [r0, g0, b0] = [ch(1), ch(3), ch(5)];
  // background: 90% toward white — the reference tint depth
  const bg = toHex(r0 + (255 - r0) * 0.9, g0 + (255 - g0) * 0.9, b0 + (255 - b0) * 0.9);
  // text: darken multiplicatively until deep enough to read on the tint
  let [r, g, b] = [r0, g0, b0];
  for (let i = 0; i < 6 && luminance(r, g, b) > 0.18; i++) {
    r *= 0.82;
    g *= 0.82;
    b *= 0.82;
  }
  return { bg, bd: hex.toUpperCase(), tx: toHex(r, g, b) };
}
