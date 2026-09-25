import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { addDays, isDateOnly, nightsBetween, todayInTz } from "@/lib/dates";
import { publicAvailability } from "@/lib/public-booking/availability";
import {
  MAX_HORIZON_DAYS,
  MAX_PUBLIC_NIGHTS,
  PUBLIC_TIMEZONE,
  requireBookingSecret,
} from "@/lib/public-booking/config";
import { formatGuestsParam, parseGuestsParam } from "@/lib/public-booking/guests";

// GET /api/public/availability?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD[&guests=2-0,3-1]
// Server-to-server (sea-tower). Read-only; returns all room types, sold-out
// included (availableUnits: 0) — presentation decisions live in the site.
//
// guests (D195) — the search party in the site's own format, one room per
// comma, adults-children per room. With it, every unit's totalPrice is THE
// engine's price for the first party (extra-guest money included), units
// that cannot host that party are left out, and each unit also carries
// partyPrices (aligned with the guests list; null = cannot host that room's
// party). Without it the response is exactly what it was before D195.
export async function GET(req: Request): Promise<NextResponse> {
  if (!requireBookingSecret(req)) {
    return NextResponse.json({ ok: false, code: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const checkIn = url.searchParams.get("check_in") ?? "";
  const checkOut = url.searchParams.get("check_out") ?? "";
  const today = todayInTz(PUBLIC_TIMEZONE);

  if (
    !isDateOnly(checkIn) || !isDateOnly(checkOut) ||
    checkIn < today || checkOut <= checkIn ||
    nightsBetween(checkIn, checkOut) > MAX_PUBLIC_NIGHTS ||
    checkIn > addDays(today, MAX_HORIZON_DAYS)
  ) {
    return NextResponse.json(
      { ok: false, code: "validation", message: "טווח תאריכים לא תקין" },
      { status: 400 },
    );
  }

  const guestsRaw = url.searchParams.get("guests");
  const parties = guestsRaw == null ? null : parseGuestsParam(guestsRaw);
  if (guestsRaw != null && !parties) {
    return NextResponse.json(
      { ok: false, code: "validation", message: "הרכב אורחים לא תקין" },
      { status: 400 },
    );
  }

  try {
    const roomTypes = await publicAvailability(
      sql,
      checkIn,
      checkOut,
      parties ? { parties } : undefined,
    );
    return NextResponse.json({
      ok: true,
      checkIn,
      checkOut,
      nights: nightsBetween(checkIn, checkOut),
      currency: "ILS",
      guests: parties ? formatGuestsParam(parties) : null,
      /* units — הדירות הבודדות הפנויות (לתצוגת דירה-פר-כרטיס באתר).
         roomId הוא מזהה החדר הפיזי ב-guesthub.rooms, והוא המפתח היחיד שבו
         מותר לחבר זמינות לתוכן מ-/api/public/rooms. מספר חדר, שם או מיקום
         במערך אינם מזהים יציבים. */
      roomTypes: roomTypes.map(({ units, ...pub }) => ({
        ...pub,
        units: units.map((u) => ({
          suId: u.suId,
          roomId: u.roomId,
          code: u.code,
          totalPrice: u.totalPrice,
          ...(u.partyPrices ? { partyPrices: u.partyPrices } : {}),
        })),
      })),
    });
  } catch (e) {
    console.error("[public-booking] availability failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, code: "internal" }, { status: 500 });
  }
}
