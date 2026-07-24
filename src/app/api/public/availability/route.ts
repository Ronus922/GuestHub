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

// GET /api/public/availability?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD
// Server-to-server (sea-tower). Read-only; returns all room types, sold-out
// included (availableUnits: 0) — presentation decisions live in the site.
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

  try {
    const roomTypes = await publicAvailability(sql, checkIn, checkOut);
    return NextResponse.json({
      ok: true,
      checkIn,
      checkOut,
      nights: nightsBetween(checkIn, checkOut),
      currency: "ILS",
      /* units — הדירות הבודדות הפנויות (לתצוגת דירה-פר-כרטיס באתר) */
      roomTypes: roomTypes.map(({ units, ...pub }) => ({
        ...pub,
        units: units.map((u) => ({ suId: u.suId, code: u.code, totalPrice: u.totalPrice })),
      })),
    });
  } catch (e) {
    console.error("[public-booking] availability failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, code: "internal" }, { status: 500 });
  }
}
