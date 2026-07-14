export const CHECK_IN_CHECK_OUT_TIMEZONE = "Asia/Jerusalem" as const;

export type CheckInCheckOutSettings = {
  timezone: typeof CHECK_IN_CHECK_OUT_TIMEZONE;
  regular: { weekdays: number[]; check_in_from: string; check_out_until: string };
  special: {
    saturday: boolean;
    holiday_eve: boolean;
    holiday: boolean;
    check_in_from: string;
    check_out_until: string;
  };
};

export type DateScheduleCategory = "holiday" | "holiday_eve" | "saturday" | "regular" | "regular_fallback";
export type ResolvedDateSchedule = {
  category: DateScheduleCategory;
  schedule: "regular" | "special";
  check_in_from: string;
  check_out_until: string;
};

export const DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS: Readonly<CheckInCheckOutSettings> = {
  timezone: CHECK_IN_CHECK_OUT_TIMEZONE,
  regular: { weekdays: [0, 1, 2, 3, 4, 5], check_in_from: "15:00", check_out_until: "11:00" },
  special: { saturday: true, holiday_eve: true, holiday: true, check_in_from: "14:00", check_out_until: "12:00" },
};

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isValidHourMinute(value: unknown): value is string {
  return typeof value === "string" && HH_MM.test(value);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function isWeekday(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}
function timeOr(value: unknown, fallback: string): string {
  return isValidHourMinute(value) ? value : fallback;
}
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseCheckInCheckOutSettings(value: unknown): CheckInCheckOutSettings {
  const root = recordOf(value);
  const regular = recordOf(root?.regular);
  const special = recordOf(root?.special);
  const weekdays = Array.isArray(regular?.weekdays)
    ? [...new Set(regular.weekdays.filter(isWeekday))].sort((a, b) => a - b)
    : [];
  return {
    timezone: CHECK_IN_CHECK_OUT_TIMEZONE,
    regular: {
      weekdays: weekdays.length ? weekdays : [...DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.regular.weekdays],
      check_in_from: timeOr(regular?.check_in_from, DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.regular.check_in_from),
      check_out_until: timeOr(regular?.check_out_until, DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.regular.check_out_until),
    },
    special: {
      saturday: booleanOr(special?.saturday, DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.special.saturday),
      holiday_eve: booleanOr(special?.holiday_eve, DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.special.holiday_eve),
      holiday: booleanOr(special?.holiday, DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.special.holiday),
      check_in_from: timeOr(special?.check_in_from, DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.special.check_in_from),
      check_out_until: timeOr(special?.check_out_until, DEFAULT_CHECK_IN_CHECK_OUT_SETTINGS.special.check_out_until),
    },
  };
}

export function validateCheckInCheckOutSettings(
  value: unknown,
): { success: true; data: CheckInCheckOutSettings } | { success: false; error: string } {
  const root = recordOf(value);
  const regular = recordOf(root?.regular);
  const special = recordOf(root?.special);
  if (!root || root.timezone !== CHECK_IN_CHECK_OUT_TIMEZONE || !regular || !special) {
    return { success: false, error: "מבנה הגדרות שעות ההגעה והעזיבה אינו תקין" };
  }
  if (!Array.isArray(regular.weekdays) || regular.weekdays.length === 0
      || regular.weekdays.some((weekday) => !isWeekday(weekday))
      || new Set(regular.weekdays).size !== regular.weekdays.length) {
    return { success: false, error: "יש לבחור לפחות יום חול אחד, ללא כפילויות" };
  }
  if ([regular.check_in_from, regular.check_out_until, special.check_in_from, special.check_out_until]
      .some((item) => !isValidHourMinute(item))) {
    return { success: false, error: "יש להזין שעה תקינה בפורמט HH:mm" };
  }
  if (typeof special.saturday !== "boolean" || typeof special.holiday_eve !== "boolean" || typeof special.holiday !== "boolean") {
    return { success: false, error: "בחירת הימים המיוחדים אינה תקינה" };
  }
  return {
    success: true,
    data: {
      timezone: CHECK_IN_CHECK_OUT_TIMEZONE,
      regular: {
        weekdays: [...regular.weekdays].sort((a, b) => a - b) as number[],
        check_in_from: regular.check_in_from as string,
        check_out_until: regular.check_out_until as string,
      },
      special: {
        saturday: special.saturday,
        holiday_eve: special.holiday_eve,
        holiday: special.holiday,
        check_in_from: special.check_in_from as string,
        check_out_until: special.check_out_until as string,
      },
    },
  };
}

export function resolveScheduleForCategory(
  category: DateScheduleCategory,
  rawSettings: unknown,
): ResolvedDateSchedule {
  const settings = parseCheckInCheckOutSettings(rawSettings);
  const useSpecial = (category === "holiday" && settings.special.holiday)
    || (category === "holiday_eve" && settings.special.holiday_eve)
    || (category === "saturday" && settings.special.saturday);
  const values = useSpecial ? settings.special : settings.regular;
  return {
    category,
    schedule: useSpecial ? "special" : "regular",
    check_in_from: values.check_in_from,
    check_out_until: values.check_out_until,
  };
}
