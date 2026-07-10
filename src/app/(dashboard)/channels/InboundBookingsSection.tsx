"use client";

import { useState, useTransition } from "react";
import {
  getInboundStatusAction,
  requestInboundPullAction,
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
          <Row label="ייבוא מוצלח אחרון" value={view.display.lastImportAt} />
          <Row label="משיכה אחרונה" value={view.display.lastPullAt} />
          <Row
            label="משיכה ממתינה"
            value={view.pendingPull ? "כן" : "לא"}
            tone={view.pendingPull ? "warn" : undefined}
          />
          <Row label="הזמנות שיובאו" value={String(view.importedTotal)} />
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
