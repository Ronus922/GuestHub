import { HDate, flags, getHolidaysOnDate } from "@hebcal/core";
import { dayOfWeek, isDateOnly, type DateOnly } from "./dates";
import {
  parseCheckInCheckOutSettings,
  resolveScheduleForCategory,
  type CheckInCheckOutSettings,
  type DateScheduleCategory,
  type ResolvedDateSchedule,
} from "./check-in-check-out-policy";
export {
  CHECK_IN_CHECK_OUT_TIMEZONE,
  DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS,
  isValidHourMinute,
  parseCheckInCheckOutSettings,
  resolveScheduleForCategory,
  validateCheckInCheckOutSettings,
} from "./check-in-check-out-policy";
export type { CheckInCheckOutSettings, DateScheduleCategory, ResolvedDateSchedule } from "./check-in-check-out-policy";

export function classifyIsraelDate(
  date: DateOnly,
  settings: CheckInCheckOutSettings,
): DateScheduleCategory {
  if (!isDateOnly(date)) return "regular_fallback";
  const holidayEvents = getHolidaysOnDate(new HDate(new Date(`${date}T12:00:00Z`)), true) ?? [];
  if (holidayEvents.some((event) => (event.getFlags() & flags.CHAG) !== 0)) return "holiday";
  if (holidayEvents.some((event) => (event.getFlags() & flags.EREV) !== 0)) return "holiday_eve";
  const weekday = dayOfWeek(date);
  if (weekday === 6) return "saturday";
  return settings.regular.weekdays.includes(weekday) ? "regular" : "regular_fallback";
}

export function resolveScheduleForDate(
  date: DateOnly,
  rawSettings: unknown,
): ResolvedDateSchedule {
  const category = classifyIsraelDate(date, parseCheckInCheckOutSettings(rawSettings));
  return resolveScheduleForCategory(category, rawSettings);
}

export function resolveStaySchedule(
  arrivalDate: DateOnly,
  departureDate: DateOnly,
  settings: unknown,
): { arrival: ResolvedDateSchedule; departure: ResolvedDateSchedule } {
  return {
    arrival: resolveScheduleForDate(arrivalDate, settings),
    departure: resolveScheduleForDate(departureDate, settings),
  };
}

export type SameDayCutoffResult = {
  allowed: boolean;
  code?: "SAME_DAY_CHECKIN_CUTOFF_PASSED";
  cutoff: string;
  local_date: DateOnly;
};

// Reusable integration boundary for the future direct-booking engine. Callers must
// supply the authoritative server clock immediately before any booking side effect.
export function evaluateSameDayCheckInCutoff(
  arrivalDate: DateOnly,
  rawSettings: unknown,
  now: Date,
): SameDayCutoffResult {
  const settings = parseCheckInCheckOutSettings(rawSettings);
  const local = localDateTime(now, settings.timezone);
  const cutoff = resolveScheduleForDate(arrivalDate, settings).check_in_from;
  if (arrivalDate !== local.date || local.time < cutoff) {
    return { allowed: true, cutoff, local_date: local.date };
  }
  return {
    allowed: false,
    code: "SAME_DAY_CHECKIN_CUTOFF_PASSED",
    cutoff,
    local_date: local.date,
  };
}

function localDateTime(date: Date, timeZone: string): { date: DateOnly; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}
