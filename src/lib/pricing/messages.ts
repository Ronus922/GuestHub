// Hebrew user-facing messages for the pricing error codes — the translation
// layer the spec requires OUTSIDE the domain core (§15). Pure map; the engine
// attaches these at its boundary, business logic never parses them.

import type { PricingErrorCode } from "./types";

export const PRICING_ERROR_MESSAGES: Record<PricingErrorCode, string> = {
  ROOM_NOT_FOUND: "החדר לא נמצא",
  ROOM_INACTIVE: "החדר אינו פעיל",
  ROOM_OUT_OF_ORDER: "החדר מושבת (תקול)",
  ROOM_UNAVAILABLE: "החדר תפוס בתאריכים המבוקשים",
  ROOM_CLOSED: "החדר חסום בתאריכים המבוקשים",
  ROOM_DUPLICATED: "אותו חדר נבחר יותר מפעם אחת",
  RATE_PLAN_NOT_FOUND: "תוכנית התעריף לא נמצאה",
  RATE_PLAN_INACTIVE: "תוכנית התעריף אינה פעילה",
  RATE_PLAN_PARENT_INACTIVE: "תוכנית האב של תוכנית התעריף אינה זמינה",
  RATE_PLAN_NOT_ASSIGNED: "תוכנית התעריף אינה משויכת לחדר זה",
  RATE_PLAN_OUTSIDE_VALIDITY: "תוכנית התעריף אינה בתוקף בתאריכים המבוקשים",
  ARRIVAL_DAY_NOT_ALLOWED: "יום ההגעה אינו מותר בתוכנית תעריף זו",
  NO_PRICE_FOR_DATE: "אין מחיר זמין לתאריך המבוקש",
  MIN_STAY_NOT_MET: "השהות קצרה ממינימום הלילות הנדרש",
  MAX_STAY_EXCEEDED: "השהות חורגת ממקסימום הלילות המותר",
  CLOSED_ON_ARRIVAL: "התאריך סגור לצ׳ק-אין (CTA)",
  CLOSED_ON_DEPARTURE: "התאריך סגור לצ׳ק-אאוט (CTD)",
  ADVANCE_BOOKING_RULE_FAILED: "מועד ההזמנה אינו עומד בחלון ההזמנה של התוכנית",
  OCCUPANCY_BELOW_MINIMUM: "מספר האורחים נמוך מהתפוסה המינימלית",
  OCCUPANCY_EXCEEDED: "מספר האורחים חורג מהתפוסה המקסימלית",
  ADULT_LIMIT_EXCEEDED: "מספר המבוגרים חורג מהמותר",
  CHILD_LIMIT_EXCEEDED: "מספר הילדים חורג מהמותר",
  INFANT_LIMIT_EXCEEDED: "מספר התינוקות חורג מהמותר",
  EXTRA_GUEST_PRICING_INCOMPLETE: "תמחור אורח נוסף אינו מוגדר במלואו לחדר זה",
  CURRENCY_MISMATCH: "המטבע המבוקש אינו מטבע הנכס",
  INVALID_DATE_RANGE: "טווח התאריכים אינו תקין",
  QUOTE_WINDOW_EXCEEDED: "טווח התאריכים חורג מחלון התמחור המותר",
  RATE_PLAN_CYCLE: "נמצאה תלות מעגלית בין תוכניות תעריף",
  MIXED_TENANT_DATA: "נתונים של נכס אחר — הפעולה נדחתה",
};
