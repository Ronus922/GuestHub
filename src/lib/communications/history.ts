// ============================================================
// D204 — the send-history list: its query (URL ⇄ filters) and the outbound
// status catalog. Client-safe (no IO): the page parses the URL with it on the
// server, the filter bar builds URLs with it in the browser.
//
// The date filter is on outbound_messages.created_at — when the row was
// written (queued, decided, or skipped) — as an Asia/Jerusalem calendar date.
// ============================================================

/** Every value of outbound_messages_status_check, in the order the filter shows them. */
export const OUTBOUND_STATUSES = [
  "sent", "delivered", "read", "submitted", "queued", "submitting",
  "failed", "undelivered", "validation_failed", "provider_not_configured",
  "skipped", "cancelled", "draft",
] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/**
 * Terminal = the worker will never touch the row again; only these may ever be
 * purged. Kept (active): queued (incl. a retry waiting for its next attempt and
 * a future scheduled_at), submitting, draft.
 */
export const TERMINAL_STATUSES = [
  "validation_failed", "provider_not_configured", "submitted", "sent", "delivered",
  "read", "failed", "undelivered", "skipped", "cancelled",
] as const satisfies readonly OutboundStatus[];

export const HISTORY_PAGE_SIZE = 100;

export type HistoryQuery = {
  /** YYYY-MM-DD, Israel calendar date, inclusive */
  from: string | null;
  to: string | null;
  statuses: OutboundStatus[];
  page: number;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string | null | undefined): string | null => {
  if (!value || !DATE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? value : null;
};

/** URL search params → a validated query; anything unknown is dropped, never trusted. */
export function parseHistoryQuery(params: Record<string, string | string[] | undefined>): HistoryQuery {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const statuses = (one("status") ?? "").split(",")
    .filter((s): s is OutboundStatus => (OUTBOUND_STATUSES as readonly string[]).includes(s));
  const page = Number.parseInt(one("page") ?? "1", 10);
  return {
    from: validDate(one("from")),
    to: validDate(one("to")),
    statuses: [...new Set(statuses)],
    page: Number.isFinite(page) && page >= 1 ? page : 1,
  };
}

/** A query → the history URL. Page 1 and empty filters are omitted. */
export function historyHref(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.statuses.length) params.set("status", query.statuses.join(","));
  if (query.page > 1) params.set("page", String(query.page));
  const qs = params.toString();
  return `/communications/history${qs ? `?${qs}` : ""}`;
}

/** Today's calendar date in Israel, YYYY-MM-DD — whatever the process or browser timezone. */
export function israelToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The presets: היום · 7 ימים · 30 יום (both ends inclusive, ending today). */
export const HISTORY_PRESETS = [
  { key: "today", label: "היום", days: 1 },
  { key: "7d", label: "7 ימים", days: 7 },
  { key: "30d", label: "30 יום", days: 30 },
] as const;

export function presetRange(days: number, today: string): { from: string; to: string } {
  return { from: shiftDate(today, -(days - 1)), to: today };
}

/** A recipient cell: the skip row of an owner automation records every owner address as one "a, b" string. */
export function splitRecipients(toAddress: string): string[] {
  return toAddress.split(",").map((part) => part.trim()).filter(Boolean);
}
