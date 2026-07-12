// The booking DOCUMENTS (the react-pdf confirmation and the /print sheet) render
// OUTSIDE the app stylesheet: @react-pdf cannot read CSS custom properties, and
// the print page ships its own self-contained <style>. They therefore cannot say
// `var(--ink)`.
//
// They still may not re-type a colour. This module hands them the SAME approved
// values, read from the two canonical token modules (GUIDELINES §1 / §3.1) —
// there is no literal below, so a token change propagates into the PDF and the
// print sheet automatically.
import { STATUS_PALETTE } from "@/lib/colors";
import { STATUS_COLORS } from "@/lib/status-colors";

// STATUS_PALETTE is the §1 base palette in declaration order:
// brand · ok · warn · danger · info · vip · muted · faint · ink · refunded-dot
const [, OK, , , , , MUTED, , INK] = STATUS_PALETTE;

// The §3.1 "בוטל" family is the approved NEUTRAL triplet (surface / border /
// text) — the documents use it for their rules, hairlines and the status pill.
const NEUTRAL = STATUS_COLORS.cancelled;

export const DOC_COLORS = {
  /** primary text (= --ink) */
  ink: INK,
  /** secondary text (= --muted) */
  muted: MUTED,
  /** every rule, border and hairline (§3.1 neutral border) */
  line: NEUTRAL.bd,
  /** soft surface behind the status pill (§3.1 neutral surface) */
  soft: NEUTRAL.bg,
  /** a customer credit reads in the "paid" green (= --ok) */
  credit: OK,
} as const;
