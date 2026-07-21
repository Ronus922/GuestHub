import "server-only";
import { timingSafeEqual } from "node:crypto";

// ============================================================
// Public booking API (sea-tower) — shared configuration + auth.
// Server-to-server only: sea-tower (:3005) calls these endpoints over
// loopback with the x-booking-secret header. Env unset ⇒ the API is OFF.
// ============================================================

// The single production tenant ("מגדל הים"). The public API is tenant-fixed —
// a browser-supplied tenant id never reaches these endpoints.
export const PUBLIC_TENANT_ID =
  process.env.PUBLIC_BOOKING_TENANT_ID ?? "68139d06-58c4-4043-b256-4691f83e1556";

// ponytail: hardcoded exclusion list — move to a DB flag if the set ever grows.
export const EXCLUDED_SU_CODES: readonly string[] = ["1000"]; // "חניה זמנית"

export const MAX_PUBLIC_NIGHTS = 30;
export const MAX_HORIZON_DAYS = 365;
export const PRICE_TOLERANCE_ILS = 1;
export const PUBLIC_TIMEZONE = "Asia/Jerusalem";

export function requireBookingSecret(req: Request): boolean {
  const secret = process.env.PUBLIC_BOOKING_API_SECRET;
  const sent = req.headers.get("x-booking-secret");
  if (!secret || !sent) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b);
}
