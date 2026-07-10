// ============================================================
// PURE Booking.com reporting eligibility (D77 §I) — no imports, no DB, no
// clock: the caller supplies nowMs, so the server computes eligibility and
// the check suite exercises the exact same rules deterministically.
//
// Documented provider rules (docs.channex.io, Bookings Collection):
//  · invalid card:  from booking creation until 00:00 (midnight) on the
//                   check-in day, property-local time
//  · cancel due invalid card: only after an invalid-card report, and only
//                   once the guest's update window passed — the GENERAL rule
//                   is 24 hours (the provider remains the final authority
//                   for the shorter last-minute windows)
//  · no-show:       from midnight on the check-in date through 48 hours after
// ============================================================

export type ReportEligibility = { eligible: boolean; reason: string | null };

export type OtaReportContext = {
  nowMs: number;
  /** UTC epoch ms of 00:00 on the check-in date, property-local */
  checkInMidnightMs: number;
  lifecycleStatus: string;
  invalidCardReportedAtMs: number | null;
  externalCancellationRequestedAtMs: number | null;
  noShowReportedAtMs: number | null;
};

const H = 3_600_000;
export const CANCEL_DUE_WAIT_MS = 24 * H;
export const NO_SHOW_WINDOW_MS = 48 * H;

// UTC epoch ms of `${dateOnly}T00:00:00` in the given IANA timezone.
// Two-pass offset resolution — exact for real-world offsets (DST-safe).
export function zonedMidnightMs(dateOnly: string, timeZone: string): number {
  const asUtc = Date.parse(`${dateOnly}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const wallMs = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
    return Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}Z`,
    );
  };
  let guess = asUtc - (wallMs(asUtc) - asUtc);
  guess = asUtc - (wallMs(guess) - asUtc); // second pass across a DST boundary
  return guess;
}

export function invalidCardEligibility(ctx: OtaReportContext): ReportEligibility {
  if (ctx.lifecycleStatus === "cancelled")
    return { eligible: false, reason: "ההזמנה כבר מבוטלת" };
  if (ctx.invalidCardReportedAtMs !== null)
    return { eligible: false, reason: "כבר דווח כרטיס לא תקין להזמנה זו" };
  if (ctx.nowMs >= ctx.checkInMidnightMs)
    return { eligible: false, reason: "חלון הדיווח נסגר בחצות שלפני יום הצ׳ק-אין" };
  return { eligible: true, reason: null };
}

export function cancelDueInvalidCardEligibility(ctx: OtaReportContext): ReportEligibility {
  if (ctx.lifecycleStatus === "cancelled")
    return { eligible: false, reason: "ההזמנה כבר מבוטלת" };
  if (ctx.externalCancellationRequestedAtMs !== null)
    return { eligible: false, reason: "בקשת ביטול כבר נשלחה — ממתין לאישור הערוץ" };
  if (ctx.invalidCardReportedAtMs === null)
    return { eligible: false, reason: "נדרש קודם דיווח על כרטיס לא תקין" };
  if (ctx.nowMs < ctx.invalidCardReportedAtMs + CANCEL_DUE_WAIT_MS)
    return {
      eligible: false,
      reason: "לאורח יש 24 שעות לעדכן כרטיס — ניתן לבטל רק לאחר מכן",
    };
  return { eligible: true, reason: null };
}

export function noShowEligibility(ctx: OtaReportContext): ReportEligibility {
  if (ctx.lifecycleStatus === "cancelled")
    return { eligible: false, reason: "ההזמנה כבר מבוטלת" };
  if (ctx.lifecycleStatus === "no_show" || ctx.noShowReportedAtMs !== null)
    return { eligible: false, reason: "כבר דווח No-show להזמנה זו" };
  if (ctx.lifecycleStatus === "checked_in" || ctx.lifecycleStatus === "checked_out")
    return { eligible: false, reason: "האורח נקלט — לא ניתן לדווח No-show" };
  if (ctx.nowMs < ctx.checkInMidnightMs)
    return { eligible: false, reason: "דיווח No-show נפתח בחצות של יום הצ׳ק-אין" };
  if (ctx.nowMs > ctx.checkInMidnightMs + NO_SHOW_WINDOW_MS)
    return { eligible: false, reason: "חלון הדיווח (48 שעות) נסגר" };
  return { eligible: true, reason: null };
}
