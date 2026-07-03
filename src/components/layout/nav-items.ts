import type { IconName } from "@/components/shared/Icon";

// Sidebar structure per ref/screens/sidebar.png. Phase 1 builds no business screens,
// so only items with an `href` navigate (see DECISIONS.md D9); the rest render inert.
export type NavItem = {
  label: string;
  icon: IconName;
  href?: string;
  permission?: string;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "ניהול",
    items: [
      { label: "דשבורד", icon: "dashboard", href: "/dashboard", permission: "dashboard.view" },
      { label: "תפוסה", icon: "calendar", permission: "calendar.view" },
      { label: "הזמנות", icon: "reservations", permission: "reservations.view" },
      { label: "אורחים", icon: "guests", permission: "guests.view" },
      { label: "חדרים", icon: "rooms", permission: "rooms.view" },
      { label: "חסימות חדרים", icon: "room-blocks", permission: "rooms.view" },
      { label: "עדכון קבוצתי", icon: "bulk-update", permission: "rates.bulk_update" },
    ],
  },
  {
    title: "תפעול",
    items: [
      { label: "ניקיון", icon: "cleaning", permission: "housekeeping.view" },
      { label: "תחזוקה", icon: "maintenance", permission: "housekeeping.view" },
      { label: "עובדים", icon: "employees", permission: "users.view" },
      { label: "נוכחות", icon: "attendance", permission: "users.view" },
      { label: "הבקשות שלי", icon: "my-requests" },
      { label: "אישור בקשות", icon: "approve-requests", permission: "users.edit" },
    ],
  },
  {
    title: "ניהול עסקי",
    items: [
      { label: "מסמכים", icon: "documents" },
      { label: "כספים", icon: "finance", permission: "payments.view" },
      { label: "ספקים", icon: "suppliers" },
      { label: "דוחות", icon: "reports", permission: "reports.view" },
    ],
  },
  {
    title: "מערכת",
    items: [
      { label: "אוטומציות", icon: "automations", permission: "settings.edit" },
      { label: "ערוצים", icon: "channels", permission: "settings.edit" },
      { label: "הגדרות", icon: "settings", permission: "settings.edit" },
      { label: "הרשאות", icon: "permissions", permission: "roles.view" },
    ],
  },
];
