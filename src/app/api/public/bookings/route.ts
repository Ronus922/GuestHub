import { NextResponse } from "next/server";
import { addDays, isDateOnly, nightsBetween, todayInTz } from "@/lib/dates";
import { cardVaultConfigured } from "@/lib/card-vault";
import { cvvValid, expiryInPast, normalizePan, panValid } from "@/lib/card-rules";
import {
  createPublicBooking,
  PublicBookingError,
  StayPricingError,
  type PublicBookingInput,
} from "@/lib/public-booking/create-booking";
import {
  MAX_HORIZON_DAYS,
  MAX_PUBLIC_NIGHTS,
  PUBLIC_TIMEZONE,
  requireBookingSecret,
} from "@/lib/public-booking/config";

// POST /api/public/bookings — website checkout (sea-tower, server-to-server).
// SECURITY: the body carries a full PAN+CVV. It must never be logged, echoed
// into a response, or spread into an error object — encrypt-and-store only.

const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ ok: false, code, message, ...extra }, { status });

// Runaway-loop safety net; real per-visitor limiting lives in sea-tower.
let windowStart = 0;
let windowCount = 0;

export async function POST(req: Request): Promise<NextResponse> {
  if (!requireBookingSecret(req)) return fail(401, "unauthorized", "לא מורשה");
  if (!cardVaultConfigured()) {
    // fail closed: card-as-guarantee is the deal — no vault key ⇒ no booking
    return fail(503, "card_vault_unavailable", "שירות ההזמנות אינו זמין כרגע");
  }

  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; windowCount = 0; }
  if (++windowCount > 60) return fail(429, "rate_limited", "יותר מדי בקשות");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "validation", "בקשה לא תקינה");
  }

  const input = validate(body);
  if (typeof input === "string") return fail(400, "validation", input);
  if (input instanceof NextResponse) return input;

  try {
    const result = await createPublicBooking(input);
    return NextResponse.json(
      {
        ok: true,
        reservationId: result.reservationId,
        reservationNumber: result.reservationNumber,
        total: result.total,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        nights: nightsBetween(input.checkIn, input.checkOut),
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof PublicBookingError) {
      return fail(409, e.code, e.message, e.newTotal != null ? { newTotal: e.newTotal } : undefined);
    }
    if (e instanceof StayPricingError) {
      return fail(409, "no_availability", e.message);
    }
    // 23P01 = rr_no_double_booking exclusion constraint — the concurrent-race
    // last line of defense; a friendly 409, never a 500.
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23P01") {
      return fail(409, "no_availability", "הדירה כבר אינה זמינה בתאריכים שנבחרו");
    }
    console.error("[public-booking] create failed", e instanceof Error ? e.message : "unknown");
    return fail(500, "internal", "אירעה שגיאה, נסו שוב מאוחר יותר");
  }
}

// Returns a validated PublicBookingInput, a Hebrew error string, or a ready
// 422 response for card problems (distinct code for the UI).
function validate(b: Record<string, unknown>): PublicBookingInput | string | NextResponse {
  const checkIn = String(b.checkIn ?? "");
  const checkOut = String(b.checkOut ?? "");
  const today = todayInTz(PUBLIC_TIMEZONE);
  if (
    !isDateOnly(checkIn) || !isDateOnly(checkOut) ||
    checkIn < today || checkOut <= checkIn ||
    nightsBetween(checkIn, checkOut) > MAX_PUBLIC_NIGHTS ||
    checkIn > addDays(today, MAX_HORIZON_DAYS)
  ) return "טווח תאריכים לא תקין";

  const roomTypeId = String(b.roomTypeId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(roomTypeId)) return "סוג חדר לא תקין";
  const preferredRaw = String(b.preferredUnitId ?? "");
  if (preferredRaw && !/^[0-9a-f-]{36}$/i.test(preferredRaw)) return "דירה לא תקינה";

  const roomsRaw = Array.isArray(b.rooms) ? (b.rooms as Array<Record<string, unknown>>) : [];
  if (roomsRaw.length < 1 || roomsRaw.length > 5) return "מספר חדרים לא תקין";
  const rooms = roomsRaw.map((r) => ({ adults: Number(r.adults), children: Number(r.children ?? 0) }));
  for (const r of rooms) {
    if (!Number.isInteger(r.adults) || r.adults < 1 || r.adults > 6) return "מספר מבוגרים לא תקין";
    if (!Number.isInteger(r.children) || r.children < 0 || r.children > 4) return "מספר ילדים לא תקין";
  }

  const expectedTotal = Number(b.expectedTotal);
  if (!Number.isFinite(expectedTotal) || expectedTotal <= 0) return "סכום לא תקין";

  const g = (b.guest ?? {}) as Record<string, unknown>;
  const firstName = String(g.firstName ?? "").trim();
  const lastName = String(g.lastName ?? "").trim();
  const phone = String(g.phone ?? "").replace(/[\s-]/g, "");
  const email = String(g.email ?? "").trim();
  if (firstName.length < 2 || firstName.length > 60) return "שם פרטי אינו תקין";
  if (lastName.length < 2 || lastName.length > 60) return "שם משפחה אינו תקין";
  if (!/^\+?\d{8,15}$/.test(phone)) return "מספר טלפון אינו תקין";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return "כתובת אימייל אינה תקינה";

  const consents = (b.consents ?? {}) as Record<string, unknown>;
  if (consents.terms !== true || consents.privacy !== true) return "יש לאשר את תנאי ההזמנה";

  const c = (b.card ?? {}) as Record<string, unknown>;
  const cardFail = (msg: string) =>
    NextResponse.json({ ok: false, code: "invalid_card", message: msg }, { status: 422 });
  const pan = normalizePan(String(c.pan ?? ""));
  if (!panValid(pan)) return cardFail("מספר הכרטיס אינו תקין");
  const cvv = String(c.cvv ?? "").trim();
  if (!cvvValid(cvv)) return cardFail("קוד האבטחה (CVV) אינו תקין");
  const holderName = String(c.holderName ?? "").trim();
  if (holderName.length < 2 || holderName.length > 120) return cardFail("שם בעל הכרטיס אינו תקין");
  const holderId = String(c.holderIdNumber ?? "").trim();
  if (holderId && !/^\d{5,9}$/.test(holderId)) return cardFail("תעודת הזהות אינה תקינה");
  const expMonth = Number(c.expMonth);
  const expYear = Number(c.expYear);
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) return cardFail("חודש התוקף אינו תקין");
  if (!Number.isInteger(expYear) || expYear < 2000 || expYear > 2099) return cardFail("שנת התוקף אינה תקינה");
  if (expiryInPast(expMonth, expYear, new Date())) return cardFail("תוקף הכרטיס פג");

  const meta = (b.meta ?? {}) as Record<string, unknown>;
  return {
    checkIn,
    checkOut,
    roomTypeId,
    preferredUnitId: preferredRaw || null,
    rooms,
    expectedTotal,
    guest: { firstName, lastName, phone, email },
    card: {
      pan,
      cvv,
      holderName,
      holderIdNumber: holderId || null,
      expMonth,
      expYear,
    },
    marketingConsent: consents.marketing === true,
    meta: {
      ip: typeof meta.ip === "string" ? meta.ip.slice(0, 60) : null,
      userAgent: typeof meta.userAgent === "string" ? meta.userAgent.slice(0, 300) : null,
    },
  };
}
