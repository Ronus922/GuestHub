import type { IconName } from "@/components/shared/Icon";

// Shared permission-category ordering + Hebrew labels. Used by the permissions
// matrix and by the staff edit panel's effective-permissions tab — one source.
export const CATEGORY_ORDER = [
  "dashboard", "calendar", "reservations", "guests", "rooms", "rates",
  "payments", "housekeeping", "staff", "users", "roles", "permissions",
  "settings", "reports", "system",
];

export const CATEGORY_LABEL: Record<string, string> = {
  dashboard: "דשבורד",
  calendar: "יומן",
  reservations: "הזמנות",
  guests: "אורחים",
  rooms: "חדרים",
  rates: "תמחור",
  payments: "תשלומים",
  housekeeping: "ניקיון",
  staff: "עובדים",
  users: "משתמשים",
  roles: "תפקידים",
  permissions: "הרשאות",
  settings: "הגדרות",
  reports: "דוחות",
  system: "מערכת",
};

export const categoryIndex = (cat: string) => {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? 99 : i;
};

// Module icon per category — same glyph vocabulary as the sidebar (nav-items.ts).
export const CATEGORY_ICON: Record<string, IconName> = {
  dashboard: "dashboard",
  calendar: "calendar",
  reservations: "reservations",
  guests: "guests",
  rooms: "rooms",
  rates: "bulk-update",
  payments: "finance",
  housekeeping: "cleaning",
  staff: "employees",
  users: "user",
  roles: "shield-check",
  permissions: "permissions",
  settings: "settings",
  reports: "reports",
  system: "info",
};
