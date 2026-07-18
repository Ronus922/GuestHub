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
      { label: "תפוסה", icon: "calendar", href: "/calendar", permission: "calendar.view" },
      { label: "עדכון קבוצתי", icon: "bulk-update", href: "/rates", permission: "rates.view" },
      { label: "תוכניות תעריף", icon: "tags", href: "/rate-plans", permission: "rate_plans.view" },
      { label: "הזמנות", icon: "reservations", href: "/reservations", permission: "reservations.view" },
      // אורחים — hidden from the nav by owner request; /guests itself still works
      // (the route and its permission are untouched, it is only unlisted).
      { label: "אורחים", icon: "guests", href: "/guests", permission: "guests.view", hidden: true },
      { label: "חדרים", icon: "rooms", href: "/rooms", permission: "rooms.view" },
      { label: "חסימות חדרים", icon: "room-blocks", permission: "rooms.view", hidden: true },
    ],
  },
  {
    title: "תפעול",
    items: [
      // ניקיון = the cleaning queue (/housekeeping); משימות = every operational
      // task (/tasks). Both read the one housekeeping_tasks store and are gated by
      // housekeeping.view. The cleaner's own screen (/housekeeping/my-tasks) stays
      // outside the sidebar.
      //
      // FROZEN (owner decision, focus shifted to Channex certification): ניקיון +
      // משימות are hidden from the nav until the owner delivers a UI spec. Nothing
      // is deleted — the routes, the housekeeping_tasks store and the automatic
      // background task creation are all untouched; this only unlists the two
      // screens. Re-enable by deleting the two `hidden: true` below. With every
      // item hidden the whole תפעול section drops out of the sidebar (Sidebar.tsx).
      { label: "ניקיון", icon: "cleaning", href: "/housekeeping", permission: "housekeeping.view", hidden: true },
      { label: "משימות", icon: "my-requests", href: "/tasks", permission: "housekeeping.view", hidden: true },
      { label: "תחזוקה", icon: "maintenance", permission: "housekeeping.view", hidden: true },
      { label: "נוכחות", icon: "attendance", permission: "users.view", hidden: true },
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
      { label: "תקשורת אורחים", icon: "automations", href: "/communications/templates", permission: "communications.templates.view" },
      // ערוצים (Channel Manager diagnostics) — DISPLAY-only, super_admin only. The
      // nav gate here is coarse (usePermission grants admin a bypass); the real
      // super_admin-only boundary is enforced server-side on /channels (redirect via
      // canManageChannels) and in every channel Server Action — UI hiding is not security.
      { label: "ערוצים", icon: "channels", href: "/channels", permission: "settings.edit" },
      { label: "הגדרות", icon: "settings", href: "/settings", permission: "settings.edit" },
      // "עובדים" moved here from תפעול (hidden section) and renamed — the users
      // screen pairs with הרשאות under מערכת while תפעול stays hidden.
      { label: "משתמשים", icon: "employees", href: "/staff", permission: "staff.view" },
      { label: "הרשאות", icon: "permissions", href: "/permissions", permission: "permissions.view" },
    ],
  },
];
