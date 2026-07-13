// The ONE icon component. GUIDELINES §10: Material Symbols Outlined only,
// weight 400, direction ltr, and ONLY the sizes {24, 20, 17, 13.5}.
//
// The public API (name / size / className) is unchanged, so every existing call
// site keeps working; what changed is what it renders. `size` is SNAPPED to the
// nearest allowed size here — a screen physically cannot render a 12px or 18px
// icon any more, which is what let stray sizes spread before.

const ALLOWED_SIZES = [13.5, 17, 20, 24] as const;

/** nearest allowed icon size (§10) — never an arbitrary px value */
export function snapIconSize(px: number): number {
  return ALLOWED_SIZES.reduce((best, s) =>
    Math.abs(s - px) < Math.abs(best - px) ? s : best,
  );
}

// name → Material Symbols Outlined ligature
const ICONS = {
  dashboard: "space_dashboard",
  calendar: "calendar_month",
  reservations: "content_paste",
  guests: "group",
  rooms: "bed",
  "room-blocks": "block",
  "bulk-update": "swap_horiz",
  cleaning: "cleaning_services",
  maintenance: "build",
  employees: "badge",
  attendance: "schedule",
  "my-requests": "description",
  "approve-requests": "fact_check",
  documents: "description",
  finance: "account_balance_wallet",
  "credit-card": "credit_card",
  suppliers: "local_shipping",
  reports: "bar_chart",
  automations: "bolt",
  channels: "share",
  settings: "settings",
  permissions: "shield",
  plus: "add",
  search: "search",
  bell: "notifications",
  moon: "dark_mode",
  languages: "translate",
  logout: "logout",
  login: "login",
  chevron: "expand_more",
  "unfold-less": "unfold_less",
  "unfold-more": "unfold_more",
  eye: "visibility",
  "eye-off": "visibility_off",
  lock: "lock",
  user: "person",
  building: "apartment",
  close: "close",
  edit: "edit",
  check: "check",
  power: "power_settings_new",
  mail: "mail",
  phone: "call",
  filter: "tune",
  "user-plus": "person_add",
  key: "key",
  more: "more_vert",
  warning: "warning",
  crown: "workspace_premium",
  "shield-check": "verified_user",
  concierge: "room_service",
  brush: "brush",
  "arrow-up": "arrow_upward",
  "arrow-down": "arrow_downward",
  info: "info",
  refresh: "refresh",
  star: "star",
  "chevron-left": "chevron_left",
  "chevron-right": "chevron_right",
  minus: "remove",
  trash: "delete",
  "circle-slash": "do_not_disturb_on",
  "users-round": "groups",
  "calendar-plus": "event",
  link: "link",
  baby: "child_care",
  "trending-up": "trending_up",
  "trending-down": "trending_down",
  copy: "content_copy",
  layers: "layers",
  grid: "grid_view",
  hotel: "hotel",
  "check-circle": "check_circle",
  circle: "circle",
  droplets: "water_drop",
  wifi: "wifi",
  accessibility: "accessible",
  coffee: "coffee",
  armchair: "chair",
  dumbbell: "fitness_center",
  waves: "pool",
  parking: "local_parking",
  package: "inventory_2",
  elevator: "elevator",
  corridor: "meeting_room",
  sort: "sort",
  globe: "language",
  "list-checks": "checklist",
  bold: "format_bold",
  italic: "format_italic",
  underline: "format_underlined",
  list: "format_list_bulleted",
  "list-ordered": "format_list_numbered",
  image: "image",
  tags: "sell",
  percent: "percent",
  calculator: "calculate",
  printer: "print",
  download: "download",
  whatsapp: "chat",
  send: "send",
  save: "save",
  "list-alt": "list_alt",
  "door-open": "door_open",
  "person-off": "person_off",
  "money-off": "money_off",
  hourglass: "hourglass_top",
  cancel: "cancel",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  className,
  size = 20,
  label,
}: {
  name: IconName;
  className?: string;
  /** snapped to the nearest allowed size: 13.5 · 17 · 20 · 24 (§10) */
  size?: number;
  /** accessible name for icon-only controls; without it the icon is decorative */
  label?: string;
}) {
  const px = snapIconSize(size);
  return (
    <span
      className={`ms-icon${className ? ` ${className}` : ""}`}
      style={{ fontSize: `${px}px`, width: `${px}px`, height: `${px}px` }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      translate="no"
    >
      {ICONS[name]}
    </span>
  );
}
