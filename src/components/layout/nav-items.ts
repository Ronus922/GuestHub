import type { IconName } from "@/components/shared/Icon";

// Sidebar structure per ref/screens/sidebar.png. Definitions are kept complete;
// visibility is progressive: a section with `hidden: true` is dropped whole, and
// within visible sections items whose route is not built yet carry `hidden: true`.
// Both are filtered in Sidebar.tsx. Re-enable by deleting the relevant
// `hidden: true` — one line per section or per item. A visible section with no
// visible items is dropped entirely.
export type NavItem = {
  label: string;
  icon: IconName;
  href?: string;
  permission?: string;
  hidden?: boolean;
};

export type NavSection = {
  title: string;
  items: NavItem[];
  hidden?: boolean;
};

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "ניהול",
    items: [
      { label: "דשבורד", icon: "dashboard", href: "/dashboard", permission: "dashboard.view" },
      { label: "תפוסה", icon: "calendar", permission: "calendar.view", hidden: true },
      { label: "הזמנות", icon: "reservations", permission: "reservations.view", hidden: true },
      { label: "אורחים", icon: "guests", permission: "guests.view", hidden: true },
      { label: "חדרים", icon: "rooms", permission: "rooms.view", hidden: true },
      { label: "חסימות חדרים", icon: "room-blocks", permission: "rooms.view", hidden: true },
      { label: "עדכון קבוצתי", icon: "bulk-update", permission: "rates.bulk_update", hidden: true },
    ],
  },
  {
    title: "תפעול",
    hidden: true,
    items: [
      { label: "ניקיון", icon: "cleaning", permission: "housekeeping.view", hidden: true },
      { label: "תחזוקה", icon: "maintenance", permission: "housekeeping.view", hidden: true },
      { label: "נוכחות", icon: "attendance", permission: "users.view", hidden: true },
      { label: "הבקשות שלי", icon: "my-requests", hidden: true },
      { label: "אישור בקשות", icon: "approve-requests", permission: "users.edit", hidden: true },
    ],
  },
  {
    title: "ניהול עסקי",
    hidden: true,
    items: [
      { label: "מסמכים", icon: "documents", hidden: true },
      { label: "כספים", icon: "finance", permission: "payments.view", hidden: true },
      { label: "ספקים", icon: "suppliers", hidden: true },
      { label: "דוחות", icon: "reports", permission: "reports.view", hidden: true },
    ],
  },
  {
    title: "מערכת",
    items: [
      { label: "אוטומציות", icon: "automations", permission: "settings.edit", hidden: true },
      { label: "ערוצים", icon: "channels", permission: "settings.edit", hidden: true },
      { label: "הגדרות", icon: "settings", permission: "settings.edit", hidden: true },
      // "עובדים" moved here from תפעול (hidden section) and renamed — the users
      // screen pairs with הרשאות under מערכת while תפעול stays hidden.
      { label: "משתמשים", icon: "employees", href: "/staff", permission: "staff.view" },
      { label: "הרשאות", icon: "permissions", href: "/permissions", permission: "permissions.view" },
    ],
  },
];
