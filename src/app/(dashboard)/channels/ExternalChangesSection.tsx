"use client";

import { useState, useTransition } from "react";
import {
  getExternalChangesAction,
  reconcileExternalChangeAction,
  setOpsRecipientAction,
  type ExternalChangesData,
  type ExternalChangeView,
} from "@/lib/channel/external-changes-admin";

// External date changes from the OTA (D82) — one visible, reconcilable card
// per external revision that moved (or tried to move) an existing stay.
// Reconciling is an operational acknowledgement only: the OTA already regards
// the change as confirmed, and nothing here reverses it upstream.
//
// HYDRATION CONTRACT (D71): renders only server-formatted strings.

type Msg = { tone: "ok" | "err"; text: string } | null;

const EMAIL_LABEL: Record<ExternalChangeView["emailStatus"], string> = {
  pending: "מייל ממתין",
  sent: "מייל נשלח",
  failed: "שליחת מייל נכשלה",
  skipped: "מייל לא נשלח — לא הוגדר נמען",
};

function ChangeCard({
  change,
  onReconcile,
  busy,
}: {
  change: ExternalChangeView;
  onReconcile?: (id: string) => void;
  busy: boolean;
}) {
  const applied = change.applyStatus === "applied";
  return (
    <div className="card">
      <div className="card-bd flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="h4">
            {change.otaName ?? "ערוץ"} · הזמנה <bdi className="ltr-num">{change.otaReservationCode ?? "—"}</bdi>
            {change.reservationNumber ? (
              <>
                {" · GuestHub "}
                <bdi className="ltr-num">{change.reservationNumber}</bdi>
              </>
            ) : null}
          </span>
          <span className={`chip ${applied ? "chip-paid" : "chip-failed"}`}>
            <span className="dot" />
            {applied ? "הוחל בלוח השנה" : "התנגשות — לא הוחל"}
          </span>
        </div>
        <div className="t-secondary flex flex-wrap items-center gap-4 text-text2">
          <span>חדר: {change.roomLabels.length > 0 ? change.roomLabels.join(", ") : "—"}</span>
          <span>
            תאריכים קודמים: <bdi className="ltr-num">{change.oldCheckIn} ← {change.oldCheckOut}</bdi>
          </span>
          <span className="text-ink">
            תאריכים חדשים: <bdi className="ltr-num">{change.newCheckIn} ← {change.newCheckOut}</bdi>
          </span>
          <span>
            התקבל: <bdi className="ltr-num">{change.receivedAtDisplay}</bdi>
          </span>
        </div>
        {!applied && change.conflictDetail && (
          <p className="t-secondary text-status-danger">{change.conflictDetail}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={`t-label ${
              change.emailStatus === "sent"
                ? "text-status-success"
                : change.emailStatus === "failed"
                  ? "text-status-danger"
                  : "text-muted"
            }`}
          >
            {EMAIL_LABEL[change.emailStatus]}
            {change.emailDetail ? ` · ${change.emailDetail}` : ""}
          </span>
          {onReconcile && (
            <button
              type="button"
              onClick={() => onReconcile(change.id)}
              disabled={busy}
              aria-disabled={busy}
              className="btn btn-secondary"
            >
              סמן כטופל
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ExternalChangesSection({ initial }: { initial: ExternalChangesData }) {
  const [data, setData] = useState(initial);
  const [recipient, setRecipient] = useState(initial.opsRecipient ?? "");
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();

  const reload = async () => {
    const res = await getExternalChangesAction();
    if (res.success && res.data) setData(res.data);
  };

  function reconcile(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await reconcileExternalChangeAction({ id });
      setMsg(res.success ? { tone: "ok", text: "השינוי סומן כטופל" } : { tone: "err", text: res.error });
      await reload();
    });
  }

  function saveRecipient() {
    setMsg(null);
    startTransition(async () => {
      const res = await setOpsRecipientAction({ email: recipient });
      setMsg(
        res.success
          ? { tone: "ok", text: recipient.trim() ? "נמען ההתראות נשמר" : "נמען ההתראות נוקה" }
          : { tone: "err", text: res.error },
      );
      await reload();
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="h3">שינויים חיצוניים מהערוצים</h2>
      <p className="t-secondary">
        שינויי תאריכים שהתקבלו מהערוץ להזמנות קיימות. הערוץ מחשיב את השינוי כמאושר — הסימון כאן
        הוא תיאום תפעולי בלבד ואינו מבטל את השינוי מול הערוץ.
      </p>

      <div className="card">
        <div className="card-bd flex flex-wrap items-end gap-3">
          <div className="field">
            <label htmlFor="ops-email" className="field-label">
              נמען מייל להתראות תפעוליות
            </label>
            <input
              id="ops-email"
              type="email"
              dir="ltr"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="ops@example.com"
              className="field-input ltr-num min-w-56"
            />
          </div>
          <button
            type="button"
            onClick={saveRecipient}
            disabled={pending}
            aria-disabled={pending}
            className="btn btn-primary"
          >
            שמירת נמען
          </button>
        </div>
      </div>

      {msg && (
        <p
          role="status"
          className={`t-secondary px-4 py-2 ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}
        >
          {msg.text}
        </p>
      )}

      {data.pending.length === 0 ? (
        <div className="card">
          <p className="empty-state">אין שינויים חיצוניים ממתינים.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {data.pending.map((c) => (
            <ChangeCard key={c.id} change={c} onReconcile={reconcile} busy={pending} />
          ))}
        </div>
      )}

      {data.recentReconciled.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="t-secondary cursor-pointer">
            טופלו לאחרונה (<bdi className="ltr-num">{data.recentReconciled.length}</bdi>)
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {data.recentReconciled.map((c) => (
              <ChangeCard key={c.id} change={c} busy={pending} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
