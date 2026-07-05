// Hebrew labels for the commercial-settings enums. Single source so the editors,
// summaries and dropdowns never drift.

export const CANCEL_TRIGGER: Record<string, string> = {
  before_checkin: "לפני צ׳ק-אין",
  no_show: "אי-הגעה",
  after_checkin: "אחרי צ׳ק-אין",
  early_departure: "עזיבה מוקדמת",
  partial_cancellation: "ביטול חלקי",
};

export const CANCEL_FEE: Record<string, string> = {
  free: "ללא חיוב",
  fixed: "סכום קבוע",
  percentage: "אחוז",
  first_night: "לילה ראשון",
  nights: "מספר לילות",
  full: "מלוא ההזמנה",
  percentage_remaining: "אחוז מהלילות שלא נוצלו",
  higher_of: "הגבוה מבין סכום/אחוז",
  lower_of: "הנמוך מבין סכום/אחוז",
};

export const CALC_BASE: Record<string, string> = {
  accommodation: "לינה בלבד",
  accommodation_plus_mandatory: "לינה + שירותי חובה",
  total_incl_tax: "סה״כ כולל מס",
  unpaid_balance: "יתרה לתשלום",
  remaining_nights: "לילות שלא נוצלו",
};

export const DISTRIBUTION: Record<string, string> = {
  direct_only: "ישיר בלבד",
  direct_and_channels: "ישיר וערוצים",
  internal_only: "פנימי בלבד",
};

export const TIME_UNIT: Record<string, string> = { hours: "שעות", days: "ימים" };

export const PAY_TRIGGER: Record<string, string> = {
  booking: "בעת ההזמנה",
  before_checkin: "לפני צ׳ק-אין",
  checkin: "בצ׳ק-אין",
  checkout: "בצ׳ק-אאוט",
};

export const PAY_AMOUNT: Record<string, string> = {
  fixed: "סכום קבוע",
  percentage: "אחוז",
  remaining_balance: "יתרה נותרת",
  full_balance: "יתרה מלאה",
};

export const RETRY: Record<string, string> = {
  manual: "טיפול ידני",
  retry_then_cancel: "ניסיון חוזר ואז ביטול",
  retry_then_notify: "ניסיון חוזר ואז התראה",
};

// generic dropdown options builder from a label map
export function opts(map: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(map).map(([value, label]) => ({ value, label }));
}
