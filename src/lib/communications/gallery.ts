import { makeBlock } from "./blocks";
import type {
  CommunicationChannel,
  StructuredTemplateContent,
  TemplateBlock,
  TemplateBlockType,
  TemplateContent,
} from "./types";

// The example gallery for "תבנית חדשה". A NEW template is ALWAYS truly blank —
// these are opt-in starting points, prefilled into the editor and fully
// editable. The booking-confirmation example is the seed that used to be
// forced on every new template (blocks.ts defaultTemplateContent, removed).

export type GalleryExample = {
  /** Stable key — used as the radio value, never displayed. */
  id: string;
  channel: CommunicationChannel;
  name: string;
  description: string;
  category: string;
  subject?: string;
  preheader?: string;
  content: TemplateContent;
};

function blockList(seed: [TemplateBlockType, TemplateBlock["data"]?][]): StructuredTemplateContent {
  return {
    schemaVersion: 1,
    blocks: seed.map(([type, data], index) => ({
      ...makeBlock(type, `${type}-${index + 1}`),
      ...(data ? { data } : {}),
    })),
  };
}

const bookingConfirmationExample: GalleryExample = {
  id: "email-booking-confirmation",
  channel: "email",
  name: "אישור הזמנה",
  description: "המבנה המלא: פרטי הזמנה, חדר, תשלום, יתרה, כתובת ותנאי ביטול",
  category: "reservation",
  subject: "ההזמנה שלכם אושרה – {{reservation.number}}",
  preheader: "ההזמנה אושרה — כל הפרטים החשובים לקראת האירוח",
  content: blockList([
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
  ]),
};

const preArrivalExample: GalleryExample = {
  id: "email-pre-arrival",
  channel: "email",
  name: "תזכורת לפני הגעה",
  description: "מייל קצר לקראת הצ׳ק-אין: מועדים, כתובת וניווט",
  category: "pre_arrival",
  subject: "מחכים לכם! פרטים אחרונים לקראת ההגעה ל{{property.name}}",
  preheader: "שעות צ׳ק-אין, כתובת וכל מה שצריך לדעת",
  content: blockList([
    ["logo_header"],
    ["heading", { text: "ההגעה שלכם מתקרבת", align: "center" }],
    ["text", { text: "שלום {{guest.first_name}},\nאנחנו כבר מתכוננים לקראתכם ב{{property.name}}. ריכזנו כאן את הפרטים החשובים ליום ההגעה." }],
    ["reservation_details"],
    ["property_address"],
    ["signature", { text: "נתראה בקרוב,\nצוות {{property.name}}" }],
    ["contact"],
  ]),
};

const paymentReminderExample: GalleryExample = {
  id: "email-payment-reminder",
  channel: "email",
  name: "תזכורת תשלום",
  description: "יתרה פתוחה להזמנה: סיכום תשלום וכפתור פעולה",
  category: "payment",
  subject: "תזכורת: יתרה לתשלום עבור הזמנה {{reservation.number}}",
  preheader: "סיכום התשלום להזמנתכם ב{{property.name}}",
  content: blockList([
    ["logo_header"],
    ["heading", { text: "יתרה לתשלום להזמנתכם", align: "center" }],
    ["text", { text: "שלום {{guest.first_name}},\nלהזמנתכם ב{{property.name}} נותרה יתרה פתוחה. ריכזנו כאן את סיכום התשלום." }],
    ["payment_summary"],
    ["balance"],
    ["signature", { text: "בברכה,\nצוות {{property.name}}" }],
    ["contact"],
  ]),
};

const whatsappConfirmationExample: GalleryExample = {
  id: "whatsapp-booking-confirmation",
  channel: "whatsapp",
  name: "אישור הזמנה",
  description: "הודעת אישור קצרה עם פרטי השהייה",
  category: "reservation",
  content: {
    schemaVersion: 1,
    kind: "whatsapp_text",
    text: "שלום {{guest.first_name}} 👋\nההזמנה שלכם ב{{property.name}} אושרה!\n\n📋 מספר הזמנה: {{reservation.number}}\n📅 הגעה: {{stay.arrival_date}}\n📅 עזיבה: {{stay.departure_date}}\n🌙 לילות: {{stay.nights}}\n\nנשמח לעמוד לרשותכם בכל שאלה.\nצוות {{property.name}}",
  },
};

const whatsappCheckInExample: GalleryExample = {
  id: "whatsapp-check-in-details",
  channel: "whatsapp",
  name: "פרטי צ׳ק-אין",
  description: "תזכורת ליום ההגעה: שעות וכתובת",
  category: "pre_arrival",
  content: {
    schemaVersion: 1,
    kind: "whatsapp_text",
    text: "שלום {{guest.first_name}},\nמחכים לכם היום ב{{property.name}}! 🏠\n\n🕒 צ׳ק-אין החל מ: {{stay.check_in_time}}\n📍 כתובת: {{property.address}}\n\nנסיעה טובה, נתראה בקרוב!",
  },
};

export const TEMPLATE_GALLERY: GalleryExample[] = [
  bookingConfirmationExample,
  preArrivalExample,
  paymentReminderExample,
  whatsappConfirmationExample,
  whatsappCheckInExample,
];

/** Truly blank content for a fresh template — zero blocks, zero text. */
export function emptyContentFor(
  channel: CommunicationChannel,
  emailMode: "blocks" | "html" = "blocks",
): TemplateContent {
  if (channel === "whatsapp") return { schemaVersion: 1, kind: "whatsapp_text", text: "" };
  if (emailMode === "html") return { schemaVersion: 1, kind: "html", html: "" };
  return { schemaVersion: 1, blocks: [] };
}
