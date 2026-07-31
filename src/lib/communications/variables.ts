import type { CommunicationRenderContext, RenderIssue } from "./types";

export type VariableDefinition = {
  key: string;
  label: string;
  group: "guest" | "reservation" | "stay" | "room" | "payment" | "property";
  kind: "text" | "email" | "phone" | "date" | "time" | "number" | "money" | "url";
};

export const COMMUNICATION_VARIABLES = [
  { key: "guest.first_name", label: "שם פרטי", group: "guest", kind: "text" },
  { key: "guest.last_name", label: "שם משפחה", group: "guest", kind: "text" },
  { key: "guest.full_name", label: "שם מלא", group: "guest", kind: "text" },
  { key: "guest.email", label: "אימייל", group: "guest", kind: "email" },
  { key: "guest.phone", label: "טלפון", group: "guest", kind: "phone" },
  { key: "reservation.number", label: "מספר הזמנה", group: "reservation", kind: "text" },
  { key: "reservation.source", label: "מקור הזמנה", group: "reservation", kind: "text" },
  { key: "reservation.status", label: "סטטוס הזמנה", group: "reservation", kind: "text" },
  { key: "reservation.created_at", label: "תאריך יצירה", group: "reservation", kind: "date" },
  { key: "reservation.manage_url", label: "קישור לניהול הזמנה", group: "reservation", kind: "url" },
  { key: "reservation.cancellation_policy", label: "מדיניות ביטול", group: "reservation", kind: "text" },
  { key: "stay.arrival_date", label: "תאריך הגעה", group: "stay", kind: "date" },
  { key: "stay.departure_date", label: "תאריך עזיבה", group: "stay", kind: "date" },
  { key: "stay.nights", label: "מספר לילות", group: "stay", kind: "number" },
  { key: "stay.check_in_time", label: "שעת צ׳ק־אין", group: "stay", kind: "time" },
  { key: "stay.check_out_time", label: "שעת צ׳ק־אאוט", group: "stay", kind: "time" },
  { key: "stay.guests", label: "הרכב אורחים", group: "stay", kind: "text" },
  { key: "room.number", label: "מספר חדר", group: "room", kind: "text" },
  { key: "room.type", label: "סוג חדר", group: "room", kind: "text" },
  { key: "room.floor", label: "קומה", group: "room", kind: "text" },
  { key: "payment.total", label: "סה״כ", group: "payment", kind: "money" },
  { key: "payment.paid", label: "שולם", group: "payment", kind: "money" },
  { key: "payment.balance", label: "יתרה", group: "payment", kind: "money" },
  { key: "payment.currency", label: "מטבע", group: "payment", kind: "text" },
  { key: "payment.payment_url", label: "קישור לתשלום", group: "payment", kind: "url" },
  { key: "property.name", label: "שם הנכס", group: "property", kind: "text" },
  { key: "property.address", label: "כתובת", group: "property", kind: "text" },
  { key: "property.phone", label: "טלפון הנכס", group: "property", kind: "phone" },
  { key: "property.email", label: "אימייל הנכס", group: "property", kind: "email" },
  { key: "property.map_url", label: "קישור ניווט", group: "property", kind: "url" },
  { key: "property.logo_url", label: "לוגו הנכס", group: "property", kind: "url" },
] as const satisfies readonly VariableDefinition[];

export type CommunicationVariableKey = (typeof COMMUNICATION_VARIABLES)[number]["key"];

const definitions = new Map<string, VariableDefinition>(
  COMMUNICATION_VARIABLES.map((definition) => [definition.key, definition]),
);

/**
 * Token grammar (D115): `{{key}}` · `{{key!}}` · `{{key|fallback}}`.
 *  - Default: a missing value renders EMPTY and the send proceeds. No variable
 *    is required by registry fiat — required-ness is the TEMPLATE's statement
 *    that the message is meaningless without the value.
 *  - `!` after the key marks it required: a reservation without a value skips
 *    the send, and the skip names the variable (D112).
 *  - `|fallback` renders the literal fallback when the value is missing. A
 *    fallback always satisfies `!` — with a declared substitute nothing is
 *    missing, so nothing blocks. The fallback cannot contain `}`.
 */
const tokenPattern = /{{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*(!)?\s*(?:\|([^}]*))?}}/gi;

export type TokenOptions = { required?: boolean; fallback?: string };

/** The ONE place the token grammar is parsed — every interpolation path
 *  (plain text, block text, html-kind documents) walks through here. */
export function replaceVariableTokens(
  input: string,
  replace: (key: string, opts: TokenOptions) => string,
): string {
  return input.replace(
    tokenPattern,
    (_token, key: string, bang: string | undefined, fallback: string | undefined) =>
      replace(key, { required: Boolean(bang), fallback: fallback?.trim() }),
  );
}

/** Literal segments and tokens, in document order — for renderers that must
 *  escape literals and values SEPARATELY (a fallback typed by the operator is
 *  data, not markup, and must be escaped exactly once). */
export function splitVariableTokens(
  input: string,
): Array<string | { key: string; opts: TokenOptions }> {
  const parts: Array<string | { key: string; opts: TokenOptions }> = [];
  let cursor = 0;
  for (const match of input.matchAll(tokenPattern)) {
    if (match.index > cursor) parts.push(input.slice(cursor, match.index));
    parts.push({
      key: match[1],
      opts: { required: Boolean(match[2]), fallback: match[3]?.trim() },
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < input.length) parts.push(input.slice(cursor));
  return parts;
}

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
  opts: TokenOptions = {},
): { value: string; issue?: RenderIssue } {
  const definition = definitions.get(key);
  // Unknown = a token that will never resolve for ANY reservation (typo or
  // registry drift) — a broken template, not a missing value. Always blocks.
  if (!definition) return { value: "", issue: { key, kind: "unknown_variable" } };

  const raw = context.values[key];
  if (!hasValue(raw)) {
    if (opts.fallback !== undefined) return { value: opts.fallback };
    return {
      value: "",
      issue: { key, kind: opts.required ? "missing_required" : "missing_optional" },
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
  const value = replaceVariableTokens(input, (key, opts) => {
    const resolved = resolveVariable(key, context, opts);
    if (resolved.issue) issues.push(resolved.issue);
    return resolved.value;
  });
  return { value, issues };
}

/** The issue kinds that stop a send (D115): an explicit `!` unmet, a token that
 *  can never resolve, or a link that must not be emitted. Everything else renders. */
export function isBlockingIssue(issue: RenderIssue): boolean {
  return issue.kind === "missing_required" || issue.kind === "unknown_variable" || issue.kind === "invalid_url";
}

const BLOCKING_ISSUE_LABELS: Record<string, string> = {
  missing_required: "משתנה חובה חסר",
  unknown_variable: "משתנה לא מוכר",
  invalid_url: "קישור לא תקין",
};

/** The Hebrew evidence line a render_failed skip row carries — names WHICH
 *  variable blocked the send (D112: the failure carries its own evidence). */
export function describeRenderIssues(issues: RenderIssue[]): string | null {
  const parts = issues
    .filter(isBlockingIssue)
    .map((issue) =>
      `${BLOCKING_ISSUE_LABELS[issue.kind]}: ${issue.key}${issue.detail ? ` (${issue.detail})` : ""}`);
  return parts.length > 0 ? [...new Set(parts)].join(" · ") : null;
}
