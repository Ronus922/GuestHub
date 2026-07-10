"use client";

import { useState, useTransition } from "react";
import {
  getInboundStatusAction,
  requestInboundPullAction,
  reregisterWebhookAction,
  setInboundEnabledAction,
  type InboundStatusView,
} from "@/lib/channel/inbound-admin";

// Inbound OTA bookings — status + THE manual pull control (D76). Compact by
// design: this card shows whether inbound import is on, what the worker last
// did, and what is parked (unacknowledged / quarantined). It edits nothing
// about the bookings themselves — imported reservations live on the calendar
// like any other reservation.
//
// HYDRATION CONTRACT (D71): renders only server-formatted strings; no date,
// locale or clock API in this file.

type Msg = { tone: "ok" | "err" | "warn"; text: string } | null;

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "err" }) {
  const color =
    tone === "ok" ? "text-status-success" : tone === "err" ? "text-status-danger" : tone === "warn" ? "text-status-warning" : "text-text2";
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-muted">{label}</span>
      <span className={`text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}

export function InboundBookingsSection({ initial }: { initial: InboundStatusView }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();

  const reload = async () => {
    const res = await getInboundStatusAction();
    if (res.success && res.data) setView(res.data);
  };

  function toggleEnabled() {
    setMsg(null);
    startTransition(async () => {
      const res = await setInboundEnabledAction({ enabled: !view.enabled });
      if (!res.success) setMsg({ tone: "err", text: res.error });
      else if (res.data?.webhookWarning) setMsg({ tone: "warn", text: res.data.webhookWarning });
      else setMsg({ tone: "ok", text: view.enabled ? "ייבוא ההזמנות הושבת" : "ייבוא ההזמנות הופעל" });
      await reload();
    });
  }

  function pullNow() {
    setMsg(null);
    startTransition(async () => {
      const res = await requestInboundPullAction();
      if (!res.success) setMsg({ tone: "err", text: res.error });
      else if (res.data?.alreadyPending) setMsg({ tone: "warn", text: "משיכה כבר ממתינה לעובד הרקע" });
      else setMsg({ tone: "ok", text: "המשיכה נוספה לתור ותתבצע ברקע" });
      await reload();
    });
  }

  function testWebhook() {
    setMsg(null);
    startTransition(async () => {
      const res = await reregisterWebhookAction();
      if (!res.success) {
        setMsg({ tone: "err", text: res.error });
      } else if (res.data) {
        const r = res.data;
        const parts = [
          r.created ? "webhook חדש נרשם ב-Channex" : "webhook קיים אומת ב-Channex",
          r.selfTestHttpStatus === 200 && r.eventRecorded && r.jobEnqueued
            ? "בדיקה עצמית עברה: כתובת ציבורית → אימות → אירוע → משימת משיכה"
            : (r.warning ?? "הבדיקה העצמית לא הושלמה"),
          r.staleUpstream > 0
            ? `${r.staleUpstream} רישומים ישנים נותרו ב-Channex — מומלץ למחוק אותם בממשק Channex`
            : null,
        ].filter(Boolean);
        setMsg({
          tone: r.warning ? "warn" : "ok",
          text: parts.join(" · "),
        });
      }
      await reload();
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold text-ink">הזמנות נכנסות מהערוצים</h2>

      <div className="rounded-xl border border-line bg-surface">
        <div className="divide-y divide-line">
          <Row
            label="ייבוא הזמנות"
            value={view.enabled ? "פעיל" : "כבוי"}
            tone={view.enabled ? "ok" : "warn"}
          />
          <Row
            label="Webhook (אות התעוררות)"
            value={view.webhookRegistered ? "רשום" : "לא רשום — משיכה תקופתית בלבד"}
            tone={view.webhookRegistered ? "ok" : undefined}
          />
          {view.callbackDisplay && (
            <Row label="כתובת Callback" value={view.callbackDisplay} />
          )}
          <Row
            label="אירועי Webhook שהתקבלו"
            value={String(view.webhookEventsTotal)}
            tone={view.webhookRegistered && view.webhookEventsTotal === 0 ? "warn" : undefined}
          />
          <Row
            label="אירוע Webhook אחרון"
            value={
              view.display.lastWebhookAt === "—"
                ? "—"
                : `${view.display.lastWebhookAt} (${view.display.lastWebhookType})`
            }
          />
          <Row label="רוויזיה אחרונה שנמשכה" value={view.display.lastRevisionAt} />
          <Row label="ייבוא מוצלח אחרון" value={view.display.lastImportAt} />
          <Row label="אישור (ACK) אחרון" value={view.display.lastAckAt} />
          <Row label="משיכה אחרונה" value={view.display.lastPullAt} />
          <Row label="שידור זמינות אחרון" value={view.display.lastDrainAt} />
          <Row
            label="משיכה ממתינה"
            value={view.pendingPull ? "כן" : "לא"}
            tone={view.pendingPull ? "warn" : undefined}
          />
          {view.inboundLagSeconds > 0 && (
            <Row
              label="עיכוב ייבוא נוכחי"
              value={`${view.inboundLagSeconds} שניות`}
              tone={view.inboundLagSeconds > 60 ? "warn" : undefined}
            />
          )}
          {view.outboundLagSeconds > 0 && (
            <Row
              label="עיכוב שידור זמינות"
              value={`${view.outboundLagSeconds} שניות`}
              tone={view.outboundLagSeconds > 300 ? "err" : "warn"}
            />
          )}
          <Row label="הזמנות שיובאו" value={String(view.importedTotal)} />
          <Row
            label="משימות בתור / בהמתנה לניסיון חוזר / כשל סופי"
            value={`${view.jobs.pending} / ${view.jobs.retryWait} / ${view.jobs.deadLetter}`}
            tone={view.jobs.deadLetter > 0 ? "err" : view.jobs.retryWait > 0 ? "warn" : undefined}
          />
          {view.unacked > 0 && (
            <Row label="רוויזיות ללא אישור" value={String(view.unacked)} tone="warn" />
          )}
          {view.quarantined > 0 && (
            <Row label="רוויזיות בהסגר" value={String(view.quarantined)} tone="err" />
          )}
          {view.failedRevisions > 0 && (
            <Row label="רוויזיות שנכשלו" value={String(view.failedRevisions)} tone="err" />
          )}
          <Row
            label="עובד הרקע"
            value={view.workerOnline ? "פעיל" : "אינו פועל"}
            tone={view.workerOnline ? "ok" : "err"}
          />
          {view.lastError && <Row label="שגיאה אחרונה" value={view.lastError} tone="err" />}
        </div>
      </div>

      {view.alerts.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl border border-status-warning bg-status-warning-050 p-4">
          {view.alerts.map((a, i) => (
            <li key={i} className="text-sm font-semibold text-ink">
              ⚠ {a}
            </li>
          ))}
        </ul>
      )}

      {msg && (
        <p
          role="status"
          className={`px-4 py-2 text-sm font-semibold ${
            msg.tone === "ok" ? "text-status-success" : msg.tone === "warn" ? "text-status-warning" : "text-status-danger"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={pullNow}
          disabled={pending || !view.enabled}
          aria-disabled={pending || !view.enabled}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          משיכת הזמנות עכשיו
        </button>
        <button
          type="button"
          onClick={testWebhook}
          disabled={pending || !view.enabled}
          aria-disabled={pending || !view.enabled}
          className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          רישום ובדיקת Webhook
        </button>
        <button
          type="button"
          onClick={toggleEnabled}
          disabled={pending || (!view.enabled && !view.connectionActive)}
          aria-disabled={pending || (!view.enabled && !view.connectionActive)}
          className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {view.enabled ? "השבת ייבוא הזמנות" : "הפעל ייבוא הזמנות"}
        </button>
      </div>
    </section>
  );
}
