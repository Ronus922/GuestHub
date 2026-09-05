import "server-only";
import { sql } from "@/lib/db";
import { resolveEmailProvider } from "./providers";
import { loadChannelHealth } from "./channel-health-db";
import {
  ALERT_THRESHOLD,
  CHANNEL_LABEL,
  PROVIDER_LABEL,
  settingsHref,
  type ChannelHealthVerdict,
  type HealthChannel,
} from "./channel-health";

// ============================================================
// The owner is emailed ONCE when a channel reaches ALERT_THRESHOLD consecutive
// provider failures (D173) — not on every failure.
//
// "Once" is a database fact, not a process memory: messaging_channel_alerts is
// UNIQUE on (tenant, channel, streak_key), and streak_key is the id of the last
// successful send before the streak (or 'none'). The INSERT … ON CONFLICT DO
// NOTHING is the lock — whichever caller lands the row sends the mail; every
// later failure in the same streak finds the row and does nothing. A new
// success starts a new key, so the NEXT outage alerts again. Two processes
// (the PM2 worker and a Next.js server action) may both fail in the same
// second and neither can double-send.
//
// Called after a failure has been WRITTEN (service.ts applySendResult,
// delivery.ts markFailed). It re-reads the log through the same query the
// dashboard uses, so the mail and the card agree. It must never break the send
// that invoked it: every path returns an outcome, nothing throws out.
//
// Recipients: failure_notification.email (the communications-settings field
// for exactly this purpose) when set, else owner_notification_emails. The mail
// rides the tenant's own Gmail connection and is NOT an outbound_messages row —
// an alert about the pipe must not become a data point about the pipe.
// ============================================================

export type ChannelAlertOutcome =
  | "below_threshold"
  | "already_alerted"
  | "sent"
  | "partial"
  | "send_failed"
  | "no_recipients"
  | "email_not_configured"
  | "error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function notifyChannelFailureStreak(
  tenantId: string,
  channel: HealthChannel,
): Promise<ChannelAlertOutcome> {
  try {
    const health = await loadChannelHealth(tenantId, channel);
    if (health.tone !== "failed" || health.consecutiveFailures < ALERT_THRESHOLD) return "below_threshold";

    const inserted = await sql<{ id: string }[]>`
      INSERT INTO guesthub.messaging_channel_alerts
        (tenant_id, channel, streak_key, failures, error_code)
      VALUES (${tenantId}, ${channel}, ${health.streakKey}, ${health.consecutiveFailures}, ${health.errorCode})
      ON CONFLICT (tenant_id, channel, streak_key) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return "already_alerted";
    const alertId = inserted[0].id;

    const [settings] = await sql<{ emails: string[] | null; override: string | null }[]>`
      SELECT owner_notification_emails AS emails,
             failure_notification->>'email' AS override
        FROM guesthub.communication_settings
       WHERE tenant_id = ${tenantId}`;
    const recipients = [...new Set(
      [settings?.override ?? null, ...(settings?.emails ?? [])]
        .map((e) => (e ?? "").trim().toLowerCase())
        .filter((e) => EMAIL_RE.test(e)),
    )];
    if (recipients.length === 0) return finish(alertId, "no_recipients", [], null);

    const provider = await resolveEmailProvider(tenantId);
    if (!provider) return finish(alertId, "email_not_configured", [], null);

    const { subject, body, html } = composeAlert(health);
    const delivered: string[] = [];
    let lastError: string | null = null;
    for (const to of recipients) {
      const result = await provider.sendEmail({ to, subject, body, html });
      if (result.status === "failed") lastError = result.errorCode ?? "failed";
      else delivered.push(to);
    }
    const outcome: ChannelAlertOutcome =
      delivered.length === recipients.length ? "sent" : delivered.length > 0 ? "partial" : "send_failed";
    return finish(alertId, outcome, delivered, lastError);
  } catch (e) {
    // Never into the send path. No contact data, no body — the name only.
    console.error("[channel-alert]", e instanceof Error ? e.name : "error");
    return "error";
  }
}

async function finish(
  alertId: string,
  outcome: ChannelAlertOutcome,
  notifiedTo: string[],
  error: string | null,
): Promise<ChannelAlertOutcome> {
  await sql`
    UPDATE guesthub.messaging_channel_alerts
       SET email_status = ${outcome}, notified_to = ${notifiedTo}, email_error = ${error},
           notified_at = ${outcome === "sent" || outcome === "partial" ? sql`now()` : null}
     WHERE id = ${alertId}`;
  return outcome;
}

function composeAlert(h: ChannelHealthVerdict): { subject: string; body: string; html: string } {
  const channel = CHANNEL_LABEL[h.channel];
  const provider = h.provider ? PROVIDER_LABEL[h.provider] ?? h.provider : "—";
  const when = h.lastAtMs ? new Date(h.lastAtMs).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }) : "—";
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  const link = `${base}${settingsHref(h.channel)}`;
  const subject = `⚠️ GuestHub — ערוץ ה-${channel} נכשל ${h.consecutiveFailures} פעמים ברציפות`;
  const lines = [
    `ערוץ השליחה ${channel} (${provider}) נכשל ${h.consecutiveFailures} פעמים ברציפות מאז השליחה המוצלחת האחרונה.`,
    ``,
    `השגיאה האחרונה: ${h.errorLabel ?? "—"}${h.errorCode ? ` [${h.errorCode}]` : ""}`,
    `זמן הכישלון האחרון: ${when}`,
    ``,
    `הודעות לאורחים בערוץ הזה אינן יוצאות. לבדיקת החיבור: ${link}`,
    ``,
    `הודעה זו נשלחת פעם אחת לכל רצף כישלונות; רצף חדש אחרי שליחה מוצלחת ידווח שוב.`,
  ];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div dir="rtl" style="font-family:sans-serif;font-size:15px;line-height:1.6">${
    lines.map((l) => (l ? `<p style="margin:0 0 8px">${esc(l).replace(esc(link), `<a href="${esc(link)}">${esc(link)}</a>`)}</p>` : "")).join("")
  }</div>`;
  return { subject, body: lines.join("\n"), html };
}
