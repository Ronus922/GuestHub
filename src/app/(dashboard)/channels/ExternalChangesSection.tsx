"use client";

import { useState, useTransition } from "react";
import {
  getExternalChangesAction,
  reconcileExternalChangeAction,
  retryExternalChangeEmailAction,
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
  sending: "מייל בשליחה…",
  sent: "מייל נשלח",
  failed: "שליחת מייל נכשלה — ניתן לנסות שוב",
  skipped: "מייל לא נשלח — חסרה הגדרה, ניתן לנסות שוב",
};

function ChangeCard({
  change,
  onReconcile,
  onRetryEmail,
  busy,
}: {
  change: ExternalChangeView;
  onReconcile?: (id: string) => void;
  onRetryEmail?: (id: string) => void;
  busy: boolean;
}) {
  const applied = change.applyStatus === "applied";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold text-ink">
          {change.otaName ?? "ערוץ"} · הזמנה {change.otaReservationCode ?? "—"}
          {change.reservationNumber ? ` · GuestHub ${change.reservationNumber}` : ""}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            applied ? "bg-status-success-050 text-status-success" : "bg-status-danger-050 text-status-danger"
          }`}
        >
          {applied ? "הוחל בלוח השנה" : "התנגשות — לא הוחל"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-text2">
        <span>חדר: {change.roomLabels.length > 0 ? change.roomLabels.join(", ") : "—"}</span>
        <span>
          תאריכים קודמים: {change.oldCheckIn} ← {change.oldCheckOut}
        </span>
        <span className="font-semibold text-ink">
          תאריכים חדשים: {change.newCheckIn} ← {change.newCheckOut}
        </span>
        <span>התקבל: {change.receivedAtDisplay}</span>
      </div>
      {!applied && change.conflictDetail && (
        <p className="text-sm font-semibold text-status-danger">{change.conflictDetail}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={`text-xs font-semibold ${
            change.emailStatus === "sent"
              ? "text-status-success"
              : change.emailStatus === "failed"
                ? "text-status-danger"
                : "text-muted"
          }`}
        >
          {EMAIL_LABEL[change.emailStatus]}
          {change.emailStatus === "sent" && change.emailSentAtDisplay
            ? ` · ${change.emailSentAtDisplay}`
            : ""}
          {change.emailDetail ? ` · ${change.emailDetail}` : ""}
        </span>
        {onRetryEmail && change.emailRetryable && (
          <button
            type="button"
            onClick={() => onRetryEmail(change.id)}
            disabled={busy}
            aria-disabled={busy}
            className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            נסה לשלוח שוב
          </button>
        )}
        {onReconcile && (
          <button
            type="button"
            onClick={() => onReconcile(change.id)}
            disabled={busy}
            aria-disabled={busy}
            className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            סמן כטופל
          </button>
        )}
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

  function retryEmail(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await retryExternalChangeEmailAction({ id });
      if (res.success && res.data) {
        setMsg(
          res.data.emailStatus === "sent"
            ? { tone: "ok", text: "המייל נשלח בהצלחה" }
            : { tone: "err", text: res.data.detail ?? "השליחה לא הצליחה" },
        );
      } else if (!res.success) {
        setMsg({ tone: "err", text: res.error });
      }
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
      <h2 className="text-lg font-bold text-ink">שינויים חיצוניים מהערוצים</h2>
      <p className="text-sm text-muted">
        שינויי תאריכים שהתקבלו מהערוץ להזמנות קיימות. הערוץ מחשיב את השינוי כמאושר — הסימון כאן
        הוא תיאום תפעולי בלבד ואינו מבטל את השינוי מול הערוץ.
      </p>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-4">
        <label htmlFor="ops-email" className="text-sm font-semibold text-ink">
          נמען מייל להתראות תפעוליות
        </label>
        <input
          id="ops-email"
          type="email"
          dir="ltr"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="ops@example.com"
          className="min-w-56 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink"
        />
        <button
          type="button"
          onClick={saveRecipient}
          disabled={pending}
          aria-disabled={pending}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          שמירת נמען
        </button>
      </div>

      {msg && (
        <p
          role="status"
          className={`px-4 py-2 text-sm font-semibold ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}
        >
          {msg.text}
        </p>
      )}

      {data.pending.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">
          אין שינויים חיצוניים ממתינים.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {data.pending.map((c) => (
            <ChangeCard key={c.id} change={c} onReconcile={reconcile} onRetryEmail={retryEmail} busy={pending} />
          ))}
        </div>
      )}

      {data.recentReconciled.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer text-sm font-semibold text-muted">
            טופלו לאחרונה ({data.recentReconciled.length})
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {data.recentReconciled.map((c) => (
              <ChangeCard key={c.id} change={c} onRetryEmail={retryEmail} busy={pending} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
