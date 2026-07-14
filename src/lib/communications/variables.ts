import type { CommunicationRenderContext, RenderIssue } from "./types";

export type VariableDefinition = {
  key: string;
  label: string;
  group: "guest" | "reservation" | "stay" | "room" | "payment" | "property";
  required: boolean;
  kind: "text" | "email" | "phone" | "date" | "time" | "number" | "money" | "url";
};

export const COMMUNICATION_VARIABLES = [
  { key: "guest.first_name", label: "שם פרטי", group: "guest", required: true, kind: "text" },
  { key: "guest.last_name", label: "שם משפחה", group: "guest", required: false, kind: "text" },
  { key: "guest.full_name", label: "שם מלא", group: "guest", required: false, kind: "text" },
  { key: "guest.email", label: "אימייל", group: "guest", required: true, kind: "email" },
  { key: "guest.phone", label: "טלפון", group: "guest", required: false, kind: "phone" },
  { key: "reservation.number", label: "מספר הזמנה", group: "reservation", required: true, kind: "text" },
  { key: "reservation.source", label: "מקור הזמנה", group: "reservation", required: true, kind: "text" },
  { key: "reservation.status", label: "סטטוס הזמנה", group: "reservation", required: true, kind: "text" },
  { key: "reservation.created_at", label: "תאריך יצירה", group: "reservation", required: true, kind: "date" },
  { key: "reservation.manage_url", label: "קישור לניהול הזמנה", group: "reservation", required: false, kind: "url" },
  { key: "reservation.cancellation_policy", label: "מדיניות ביטול", group: "reservation", required: false, kind: "text" },
  { key: "stay.arrival_date", label: "תאריך הגעה", group: "stay", required: true, kind: "date" },
  { key: "stay.departure_date", label: "תאריך עזיבה", group: "stay", required: true, kind: "date" },
  { key: "stay.nights", label: "מספר לילות", group: "stay", required: true, kind: "number" },
  { key: "stay.check_in_time", label: "שעת צ׳ק־אין", group: "stay", required: true, kind: "time" },
  { key: "stay.check_out_time", label: "שעת צ׳ק־אאוט", group: "stay", required: true, kind: "time" },
  { key: "stay.guests", label: "הרכב אורחים", group: "stay", required: true, kind: "text" },
  { key: "room.number", label: "מספר חדר", group: "room", required: false, kind: "text" },
  { key: "room.type", label: "סוג חדר", group: "room", required: false, kind: "text" },
  { key: "room.floor", label: "קומה", group: "room", required: false, kind: "text" },
  { key: "payment.total", label: "סה״כ", group: "payment", required: true, kind: "money" },
  { key: "payment.paid", label: "שולם", group: "payment", required: true, kind: "money" },
  { key: "payment.balance", label: "יתרה", group: "payment", required: true, kind: "money" },
  { key: "payment.currency", label: "מטבע", group: "payment", required: true, kind: "text" },
  { key: "payment.payment_url", label: "קישור לתשלום", group: "payment", required: false, kind: "url" },
  { key: "property.name", label: "שם הנכס", group: "property", required: true, kind: "text" },
  { key: "property.address", label: "כתובת", group: "property", required: false, kind: "text" },
  { key: "property.phone", label: "טלפון הנכס", group: "property", required: false, kind: "phone" },
  { key: "property.email", label: "אימייל הנכס", group: "property", required: false, kind: "email" },
  { key: "property.map_url", label: "קישור ניווט", group: "property", required: false, kind: "url" },
  { key: "property.logo_url", label: "לוגו הנכס", group: "property", required: false, kind: "url" },
] as const satisfies readonly VariableDefinition[];

export type CommunicationVariableKey = (typeof COMMUNICATION_VARIABLES)[number]["key"];

const definitions = new Map<string, VariableDefinition>(
  COMMUNICATION_VARIABLES.map((definition) => [definition.key, definition]),
);
const tokenPattern = /{{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*}}/gi;

export function getVariableDefinition(key: string): VariableDefinition | undefined {
  return definitions.get(key);
}

export function extractVariableKeys(input: string): string[] {
  return [...input.matchAll(tokenPattern)].map((match) => match[1]);
}

export function hasValue(value: unknown): value is string | number {
  return typeof value === "number" || (typeof value === "string" && value.trim().length > 0);
}

export function resolveVariable(
  key: string,
  context: CommunicationRenderContext,
): { value: string; issue?: RenderIssue } {
  const definition = definitions.get(key);
  if (!definition) return { value: "", issue: { key, kind: "unknown_variable" } };

  const raw = context.values[key];
  if (!hasValue(raw)) {
    return {
      value: "",
      issue: { key, kind: definition.required ? "missing_required" : "missing_optional" },
    };
  }

  if (definition.kind === "money" && typeof raw === "number") {
    const currency = String(context.values["payment.currency"] || "ILS");
    try {
      return {
        value: new Intl.NumberFormat("he-IL", { style: "currency", currency }).format(raw),
      };
    } catch {
      return { value: `${raw} ${currency}` };
    }
  }

  return { value: String(raw) };
}

export function interpolateVariables(
  input: string,
  context: CommunicationRenderContext,
): { value: string; issues: RenderIssue[] } {
  const issues: RenderIssue[] = [];
  const value = input.replace(tokenPattern, (_token, key: string) => {
    const resolved = resolveVariable(key, context);
    if (resolved.issue) issues.push(resolved.issue);
    return resolved.value;
  });
  return { value, issues };
}
