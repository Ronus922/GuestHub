// ============================================================
// GUIDELINES §3.1 — the EIGHT approved status triplets, declared once.
//
// The same triplet paints the calendar bar, the popover tag, the filter chip,
// the list badge and the report cell. No screen may invent a variant, and no
// screen may hand-write these hexes: it imports the triplet or, better, uses the
// canonical `.chip .chip-<key>` class from design-system.css.
//
// This file (with lib/colors.ts) is a TOKEN DECLARATION file — the only place in
// TypeScript allowed to hold raw colour literals.
// ============================================================

export type StatusTriplet = {
  /** surface */
  bg: string;
  /** border */
  bd: string;
  /** text */
  tx: string;
  /** the 8px dot */
  dot: string;
  /** the canonical chip class (design-system.css) */
  chip: string;
};

export const STATUS_COLORS = {
  unpaid: { bg: "#FDEBEC", bd: "#EFA3A9", tx: "#B4232D", dot: "#E5484D", chip: "chip-unpaid" },
  partial: { bg: "#EAF7EE", bd: "#93D3A5", tx: "#1F7A3D", dot: "#48B865", chip: "chip-partial" },
  paid: { bg: "#DFF2E7", bd: "#4FB47E", tx: "#0F6B3C", dot: "#16A34A", chip: "chip-paid" },
  transfer: { bg: "#F2ECFD", bd: "#BCA1F1", tx: "#6B27D6", dot: "#8B5CF6", chip: "chip-transfer" },
  approval: { bg: "#FDF2E1", bd: "#EBC078", tx: "#8A5207", dot: "#EA9314", chip: "chip-approval" },
  failed: { bg: "#FBE7EB", bd: "#E58BA0", tx: "#A3123B", dot: "#C81E3C", chip: "chip-failed" },
  refunded: { bg: "#EAEEF4", bd: "#AEBACB", tx: "#3C4A5E", dot: "#475569", chip: "chip-refunded" },
  cancelled: { bg: "#F1F3F6", bd: "#C9D0DA", tx: "#5B6478", dot: "#9AA1B4", chip: "chip-cancelled" },
} as const satisfies Record<string, StatusTriplet>;

export type StatusKey = keyof typeof STATUS_COLORS;

// ---- how the app's own states map onto the approved eight ----
// PRESENTATION ONLY: no payment state, meaning or derivation changes here — a
// state is only told which approved triplet to wear.
//
// `overpaid` (fully paid + a customer credit, D52) has no triplet of its own in
// §3.1; it takes the "ממתין להעברה" purple, the one approved family not used by
// any other payment state, so a credit still reads apart from an exactly-settled
// stay. Its LABEL is unchanged.
export const PAYMENT_STATUS: Record<string, StatusKey> = {
  unpaid: "unpaid",
  partial: "partial",
  paid: "paid",
  overpaid: "transfer",
  failed: "failed",
  refunded: "refunded",
  cancelled: "cancelled",
  pending: "approval",
};

/** the triplet a payment state wears (§3.1) */
export function paymentTriplet(state: string): StatusTriplet {
  return STATUS_COLORS[PAYMENT_STATUS[state] ?? "unpaid"];
}

/** a departed/neutral stay uses the approved "הוחזר" grey family */
export const NEUTRAL_STATUS: StatusTriplet = STATUS_COLORS.refunded;
