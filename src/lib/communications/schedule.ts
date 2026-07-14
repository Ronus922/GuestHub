import "server-only";
import { sql } from "@/lib/db";
import {
  parseCheckInCheckOutSettings,
  resolveScheduleForCategory,
  type CheckInCheckOutSettings,
  type DateScheduleCategory,
} from "@/lib/check-in-check-out-policy";

type HebcalModule = typeof import("@hebcal/core");
// TypeScript rewrites import() to require() under the worker's CommonJS target.
// Native import must remain native because @hebcal/core publishes ESM only.
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<HebcalModule>;

async function classifyDate(date: string, settings: CheckInCheckOutSettings): Promise<DateScheduleCategory> {
  const { HDate, flags, getHolidaysOnDate } = await nativeImport("@hebcal/core");
  const holidays = getHolidaysOnDate(new HDate(new Date(`${date}T12:00:00Z`)), true) ?? [];
  const isHoliday = holidays.some((event) => (event.getFlags() & flags.CHAG) !== 0);
  const isEve = holidays.some((event) => (event.getFlags() & flags.EREV) !== 0);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (isHoliday) return "holiday";
  if (isEve) return "holiday_eve";
  if (weekday === 6) return "saturday";
  return settings.regular.weekdays.includes(weekday) ? "regular" : "regular_fallback";
}

/** Worker-safe adapter for the canonical Israel-date check-in/out rules. */
export async function resolveCommunicationStaySchedule(
  tenantId: string,
  arrivalDate: string,
  departureDate: string,
): Promise<{ checkIn: string; checkOut: string }> {
  const [row] = await sql<{ value: unknown }[]>`
    SELECT settings->'check_in_check_out' AS value
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  const settings = parseCheckInCheckOutSettings(row?.value);
  const [arrivalCategory, departureCategory] = await Promise.all([
    classifyDate(arrivalDate, settings),
    classifyDate(departureDate, settings),
  ]);
  const arrival = resolveScheduleForCategory(arrivalCategory, settings);
  const departure = resolveScheduleForCategory(departureCategory, settings);
  return { checkIn: arrival.check_in_from, checkOut: departure.check_out_until };
}
