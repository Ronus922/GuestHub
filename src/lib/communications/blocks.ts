import type { IconName } from "@/components/shared/Icon";
import type { BlockCondition, StructuredTemplateContent, TemplateBlock, TemplateBlockType } from "./types";

// The block catalog — ONE source of truth for the palette, the canvas tag, the
// property panel title and the seeded template. Adding a block type here is the
// only edit a new block needs on the UI side (the renderer owns its markup).

export type BlockGroup = "מבנה" | "תוכן" | "הזמנה" | "תשלום" | "נכס" | "פעולות";

export const BLOCK_GROUPS: BlockGroup[] = ["מבנה", "תוכן", "הזמנה", "תשלום", "נכס", "פעולות"];

export const BLOCK_LIBRARY: { type: TemplateBlockType; label: string; icon: IconName; group: BlockGroup }[] = [
  { type: "logo_header", label: "לוגו וכותרת", icon: "logo-header", group: "מבנה" },
  { type: "divider", label: "מפריד", icon: "divider", group: "מבנה" },
  { type: "heading", label: "כותרת", icon: "heading", group: "תוכן" },
  { type: "text", label: "טקסט", icon: "text", group: "תוכן" },
  { type: "cancellation_policy", label: "תנאי ביטול", icon: "policy", group: "תוכן" },
  { type: "signature", label: "חתימה", icon: "signature", group: "תוכן" },
  { type: "reservation_details", label: "פרטי הזמנה", icon: "receipt-long", group: "הזמנה" },
  { type: "room_details", label: "פרטי חדר", icon: "rooms", group: "הזמנה" },
  { type: "payment_summary", label: "סיכום תשלום", icon: "receipt", group: "תשלום" },
  { type: "balance", label: "יתרה לתשלום", icon: "payments", group: "תשלום" },
  { type: "property_address", label: "כתובת וניווט", icon: "location", group: "נכס" },
  { type: "contact", label: "פרטי יצירת קשר", icon: "phone", group: "נכס" },
  { type: "action_button", label: "כפתור פעולה", icon: "smart-button", group: "פעולות" },
];

export function blockMeta(type: TemplateBlockType) {
  return BLOCK_LIBRARY.find((block) => block.type === type);
}

/** "בשימוש" — a count, not the automation's name: the name overflows the column. */
export function usageLabel(count: number): string {
  if (count === 0) return "לא בשימוש";
  if (count === 1) return "אוטומציה אחת";
  return `${count} אוטומציות`;
}

/**
 * Blocks whose content is a free-text body the author writes.
 *
 * `cancellation_policy` is deliberately NOT one of them: it renders the
 * reservation's OWN policy ({{reservation.cancellation_policy}}), which is the
 * only text that is legally true for that booking. Offering a textarea there
 * would let staff author a policy, publish it, and have the guest never see a
 * word of it — the renderer ignores the authored text entirely.
 */
export const TEXT_BLOCKS: TemplateBlockType[] = ["heading", "text", "signature"];

export const BLOCK_TEXT_PLACEHOLDER: Partial<Record<TemplateBlockType, string>> = {
  heading: "טקסט הכותרת",
  text: "כתבו כאן טקסט…",
  signature: "נתראה בקרוב…",
};

export const CONDITION_LABELS: Record<BlockCondition, string> = {
  always: "מוצג תמיד",
  balance_positive: "רק כשהיתרה לתשלום גדולה מאפס",
  direct_reservation: "רק בהזמנה ממקור ישיר (אתר / ידני)",
  room_assigned: "רק כששויך חדר להזמנה",
  guest_email_exists: "רק כשקיים אימייל לאורח",
  cancellation_policy_exists: "רק כשקיימת מדיניות ביטול",
  manage_url_exists: "רק כשקיים קישור לניהול ההזמנה",
};

/** "שלב בחיי ההזמנה" — organisational only. What SENDS is an automation. */
export const STAGE_LABELS: Record<string, string> = {
  reservation: "הזמנה",
  pre_arrival: "לפני ההגעה",
  check_in: "צ׳ק-אין",
  in_stay: "במהלך השהייה",
  check_out: "צ׳ק-אאוט",
  post_stay: "לאחר השהייה",
  payment: "תשלום",
  cancellation: "ביטול",
  other: "אחר",
};

/** Labeled option lists for the block-style selects (§8) — the Hebrew UI face of
 *  the approved tokens in lib/communications/styles.ts. */
export const STYLE_OPTIONS = {
  fontSize: [
    { value: "sm", label: "קטן" }, { value: "base", label: "רגיל" }, { value: "md", label: "בינוני" },
    { value: "lg", label: "גדול" }, { value: "xl", label: "כותרת" }, { value: "xxl", label: "כותרת גדולה" },
  ],
  fontWeight: [
    { value: "normal", label: "רגיל" }, { value: "medium", label: "בינוני" }, { value: "semibold", label: "מודגש-חלקי" },
    { value: "bold", label: "מודגש" }, { value: "black", label: "כבד" },
  ],
  lineHeight: [
    { value: "tight", label: "צפוף" }, { value: "snug", label: "רגיל" },
    { value: "normal", label: "מרווח" }, { value: "loose", label: "מרווח מאוד" },
  ],
  textColor: [
    { value: "ink", label: "כהה" }, { value: "muted", label: "אפור" }, { value: "brand", label: "מותג" },
    { value: "brandDark", label: "מותג כהה" }, { value: "ok", label: "ירוק" }, { value: "danger", label: "אדום" },
  ],
  background: [
    { value: "none", label: "ללא" }, { value: "subtle", label: "אפור עדין" },
    { value: "brandSoft", label: "תכלת מותג" }, { value: "brand", label: "מותג מלא" },
  ],
  padding: [
    { value: "none", label: "ללא" }, { value: "sm", label: "קטן" }, { value: "md", label: "בינוני" }, { value: "lg", label: "גדול" },
  ],
  buttonWidth: [
    { value: "auto", label: "לפי התוכן" }, { value: "full", label: "רוחב מלא" },
  ],
  buttonRadius: [
    { value: "md", label: "מעוגל" }, { value: "lg", label: "מעוגל יותר" }, { value: "pill", label: "כדורי" },
  ],
  buttonBg: [
    { value: "brand", label: "מותג" }, { value: "ink", label: "כהה" }, { value: "ok", label: "ירוק" },
  ],
  buttonText: [
    { value: "white", label: "לבן" }, { value: "ink", label: "כהה" },
  ],
} as const;

export const STAGE_KEYS = Object.keys(STAGE_LABELS);

export const ACTION_URL_OPTIONS: { value: string; label: string }[] = [
  { value: "reservation.manage_url", label: "ניהול ההזמנה" },
  { value: "payment.payment_url", label: "תשלום" },
  { value: "property.map_url", label: "ניווט לנכס" },
];

export function defaultBlockData(type: TemplateBlockType): TemplateBlock["data"] {
  switch (type) {
    case "heading":
      return { text: "כותרת חדשה", align: "center" };
    case "text":
      return { text: "כתבו כאן את תוכן ההודעה" };
    case "signature":
      return { text: "נתראה בקרוב,\n{{property.name}}" };
    case "action_button":
      return { label: "לצפייה וניהול ההזמנה", urlVariable: "reservation.manage_url" };
    default:
      return {};
  }
}

/** The condition a block is BORN with — a room block on a room-less reservation
 *  must not render an empty card, so it defaults to its own guard. */
function defaultCondition(type: TemplateBlockType): BlockCondition {
  if (type === "room_details") return "room_assigned";
  if (type === "balance") return "balance_positive";
  if (type === "cancellation_policy") return "cancellation_policy_exists";
  if (type === "action_button") return "manage_url_exists";
  return "always";
}

export function makeBlock(type: TemplateBlockType, id: string): TemplateBlock {
  return { id, type, enabled: true, condition: defaultCondition(type), data: defaultBlockData(type) };
}

/** The 13-block template a new draft is seeded with (reference order). */
export function defaultTemplateContent(): StructuredTemplateContent {
  const seed: [TemplateBlockType, TemplateBlock["data"]?][] = [
    ["logo_header"],
    ["heading", { text: "תודה שהזמנתם אצלנו", align: "center" }],
    ["text", { text: "שלום {{guest.first_name}},\nשמחנו לקבל את הזמנתכם ב{{property.name}} — ההזמנה אושרה וכל הפרטים שמורים אצלנו. ריכזנו כאן את כל מה שחשוב לדעת לקראת ההגעה." }],
    ["reservation_details"],
    ["room_details"],
    ["payment_summary"],
    ["balance"],
    ["action_button"],
    ["property_address"],
    ["divider"],
    ["cancellation_policy"],
    ["signature", { text: "נתראה בקרוב,\nצוות {{property.name}}" }],
    ["contact"],
  ];
  return {
    schemaVersion: 1,
    blocks: seed.map(([type, data], index) => ({
      ...makeBlock(type, `${type}-${index + 1}`),
      ...(data ? { data } : {}),
    })),
  };
}
