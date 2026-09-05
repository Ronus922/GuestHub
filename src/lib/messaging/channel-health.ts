// ============================================================
// Outbound channel health — what the SENDS say, not what the connection test
// said (D173).
//
// PURE: no imports, no DB, no clock (the caller passes `nowMs`), so the guard
// (scripts/check-channel-health.mjs) compiles this file and asserts the verdict
// directly, then neutralises the core and watches the suite die (B2).
//
// WHY. messaging_provider_connections.status read "connected" from the test of
// 2026-07-30 while every WhatsApp send from 2026-09-02 on failed green_400
// ("Instance account is expired") — nine rows in three days, an automation
// stream and a manual send by the owner, and no surface went red. A connection
// test is a fact about the moment somebody pressed the button; the outbound log
// is a fact about every message since. This module reads the log.
//
// THE THREE TONES, in the owner's words:
//   green (ok)     — the last send succeeded;
//   red   (failed) — the last send failed at the PROVIDER: the code in Hebrew
//                    and how many failed in a row since the last success;
//   grey  (idle)   — nothing was sent for IDLE_DAYS, whatever the last row was.
//
// WHAT COUNTS AS A SEND. Only rows that reached the provider:
//   success = submitted | sent | delivered | read (the provider accepted it);
//   failure = status 'failed' whose cause is the provider — a `green_*` /
//             `gmail_*` / `twilio_*` code, a thrown adapter, or a channel that
//             is not connected / cannot be decrypted;
//   ignored = everything else. A bad guest phone (invalid_recipient,
//             validation_failed), a number with no WhatsApp (undelivered), an
//             unfinished render snapshot, an ambiguous restart, a cancelled or
//             skipped row — none of these says anything about the CHANNEL, and
//             letting them paint it red (or email the owner) would be a false
//             alarm about the recipient dressed up as a fact about the pipe.
//
// THE SEND MOMENT is COALESCE(submitted_at, updated_at): a worker row is
// CREATED when queued and may fail an hour of retries later, so created_at
// would order a 13:29 failure that landed at 14:30 before a 14:00 success.
// ============================================================

export type HealthChannel = "email" | "whatsapp";

/** One outbound_messages row, already loaded. This module issues no query. */
export type ChannelHealthRow = {
  id: string;
  status: string;
  errorCode: string | null;
  finalErrorCategory: string | null;
  provider: string | null;
  /** the send moment, epoch ms — COALESCE(submitted_at, updated_at) */
  atMs: number;
};

export type ChannelHealthTone = "ok" | "failed" | "idle";

export type ChannelHealthVerdict = {
  channel: HealthChannel;
  tone: ChannelHealthTone;
  /** epoch ms of the last COUNTED send (success or provider failure); null = none ever */
  lastAtMs: number | null;
  /** "לפני 3 שעות" for lastAtMs against nowMs; null when lastAtMs is null */
  lastAgo: string | null;
  /** provider failures since the last success — 0 unless tone is 'failed' */
  consecutiveFailures: number;
  /** the last failure's code (tone 'failed' only) */
  errorCode: string | null;
  /** the code in Hebrew (tone 'failed' only) */
  errorLabel: string | null;
  /** the provider of the last counted row: gmail | gmail_smtp | green_api | twilio */
  provider: string | null;
  /**
   * Identity of the CURRENT failure streak: the id of the last successful send
   * before it, or "none" when no success is in the window. The alert-once row
   * keys on it — a streak alerts once, and a new streak after a new success
   * alerts again.
   */
  streakKey: string;
};

/** grey after this many days without a counted send */
export const IDLE_DAYS = 7;
/** the owner is emailed when a streak reaches this many provider failures */
export const ALERT_THRESHOLD = 3;

export const CHANNEL_LABEL: Record<HealthChannel, string> = {
  email: "מייל",
  whatsapp: "WhatsApp",
};

export const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  gmail_smtp: "Gmail (SMTP)",
  green_api: "GREEN-API",
  twilio: "Twilio",
};

/** the settings card a red row opens — the anchors live on MessagingSection's two cards */
export function settingsHref(channel: HealthChannel): string {
  return `/settings?section=messaging#${channel === "email" ? "gmail" : "whatsapp"}`;
}

const SUCCESS_STATUSES: readonly string[] = ["submitted", "sent", "delivered", "read"];
/** failures the adapters name without a provider prefix that are still the channel's fault */
const CHANNEL_FAULT_CODES: readonly string[] = [
  "provider_exception",
  "provider_not_configured",
  "provider_configuration_invalid",
];
const PROVIDER_CODE = /^(green|gmail|twilio)_/;

export type RowClass = "success" | "failure" | "ignore";

export function classifyRow(row: ChannelHealthRow): RowClass {
  if (SUCCESS_STATUSES.includes(row.status)) return "success";
  if (row.status !== "failed") return "ignore";
  const code = (row.errorCode ?? "").toLowerCase();
  if (PROVIDER_CODE.test(code) || CHANNEL_FAULT_CODES.includes(code)) return "failure";
  // the worker's classifier (delivery.ts) files provider causes under provider_*
  if ((row.finalErrorCategory ?? "").startsWith("provider_")) return "failure";
  return "ignore";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "לפני 3 שעות" — coarse on purpose; the card is a glance, not a log */
export function relativeHebrew(deltaMs: number): string {
  const d = Math.max(0, deltaMs);
  if (d < MINUTE_MS) return "לפני רגע";
  if (d < HOUR_MS) {
    const m = Math.floor(d / MINUTE_MS);
    return m === 1 ? "לפני דקה" : `לפני ${m} דקות`;
  }
  if (d < DAY_MS) {
    const h = Math.floor(d / HOUR_MS);
    return h === 1 ? "לפני שעה" : h === 2 ? "לפני שעתיים" : `לפני ${h} שעות`;
  }
  const days = Math.floor(d / DAY_MS);
  return days === 1 ? "אתמול" : days === 2 ? "לפני יומיים" : `לפני ${days} ימים`;
}

const EXACT_LABELS: Record<string, string> = {
  // GREEN-API answers 400 with a body for an expired subscription — the case
  // measured in production 2–5/09/2026 ("Instance account is expired").
  green_400: "GREEN-API דחה את הבקשה (400) — בדרך כלל מנוי שפג תוקפו",
  green_466: "GREEN-API — מכסת ההודעות החודשית נוצלה (466)",
  twilio_20003: "אימות מול Twilio נכשל (20003) — Account SID או Auth Token שגויים",
  twilio_20005: "חשבון ה-Twilio אינו פעיל (20005)",
  twilio_20429: "Twilio — חריגה מקצב השליחה (20429)",
  gmail_oauth_incomplete: "חיבור Gmail לא הושלם — חסרים פרטי OAuth",
  gmail_token_invalid_grant: "הרשאת Gmail בוטלה — יש לחבר את החשבון מחדש",
  provider_exception: "שירות הספק לא הגיב",
  provider_not_configured: "הערוץ אינו מחובר",
  provider_configuration_invalid: "הגדרת הערוץ אינה תקינה — לא ניתן לקרוא את פרטי החיבור",
};

const PROVIDER_OF_PREFIX: Record<string, string> = {
  green: "GREEN-API",
  gmail: "Gmail",
  twilio: "Twilio",
};

/** error_code → Hebrew. Never returns the empty string; an unknown code is shown as itself. */
export function errorCodeLabel(code: string | null): string {
  if (!code) return "שגיאה לא מזוהה";
  const c = code.toLowerCase();
  const exact = EXACT_LABELS[c];
  if (exact) return exact;
  const http = /^(green|gmail|twilio)_(\d{3})$/.exec(c);
  if (http) {
    const name = PROVIDER_OF_PREFIX[http[1]];
    const n = Number(http[2]);
    if (n === 401 || n === 403) return `אימות מול ${name} נכשל (${n}) — יש לבדוק את פרטי החיבור`;
    if (n === 429) return `${name} — חריגה מקצב השליחה (${n})`;
    if (n >= 500) return `תקלה בשרתי ${name} (${n})`;
    if (n >= 400) return `${name} דחה את הבקשה (${n})`;
  }
  if (c.startsWith("gmail_token_")) return "קבלת אסימון גישה מ-Gmail נכשלה — יש לחבר את החשבון מחדש";
  const net = /^(green|gmail|twilio)_network$/.exec(c);
  if (net) return `שגיאת רשת מול ${PROVIDER_OF_PREFIX[net[1]]}`;
  return `שגיאת ספק (${code})`;
}

/**
 * The verdict for one channel. `rows` may arrive in any order — they are
 * sorted here by send moment, newest first, so a caller cannot get this wrong.
 */
export function channelHealth(
  channel: HealthChannel,
  rows: readonly ChannelHealthRow[],
  nowMs: number,
): ChannelHealthVerdict {
  const ordered = [...rows].sort((a, b) => b.atMs - a.atMs);

  let last: ChannelHealthRow | null = null;
  let failures = 0;
  let streakKey = "none";
  for (const row of ordered) {
    const cls = classifyRow(row);
    if (cls === "ignore") continue;
    if (!last) last = row;
    if (cls === "success") {
      streakKey = row.id;
      break;
    }
    failures += 1;
  }

  const idle = (v: Omit<ChannelHealthVerdict, "channel" | "tone" | "consecutiveFailures" | "errorCode" | "errorLabel">): ChannelHealthVerdict =>
    ({ channel, tone: "idle", consecutiveFailures: 0, errorCode: null, errorLabel: null, ...v });

  if (!last) {
    return idle({ lastAtMs: null, lastAgo: null, provider: null, streakKey });
  }
  const lastAgo = relativeHebrew(nowMs - last.atMs);
  if (nowMs - last.atMs > IDLE_DAYS * DAY_MS) {
    return idle({ lastAtMs: last.atMs, lastAgo, provider: last.provider, streakKey });
  }
  if (classifyRow(last) === "success") {
    return {
      channel, tone: "ok", lastAtMs: last.atMs, lastAgo, consecutiveFailures: 0,
      errorCode: null, errorLabel: null, provider: last.provider, streakKey,
    };
  }
  return {
    channel, tone: "failed", lastAtMs: last.atMs, lastAgo, consecutiveFailures: failures,
    errorCode: last.errorCode, errorLabel: errorCodeLabel(last.errorCode), provider: last.provider, streakKey,
  };
}
