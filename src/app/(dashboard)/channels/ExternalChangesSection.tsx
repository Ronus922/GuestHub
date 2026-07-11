"use client";

import { useState, useTransition } from "react";
import {
  approveExternalChangeAction,
  getExternalChangesAction,
  reconcileExternalChangeAction,
  rejectExternalChangeAction,
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

const APPLY_PILL: Record<
  ExternalChangeView["applyStatus"],
  { label: string; cls: string }
> = {
  pending_approval: { label: "ממתין לאישור", cls: "bg-status-warning-050 text-status-warning" },
  applied: { label: "אושר והוחל בלוח השנה", cls: "bg-status-success-050 text-status-success" },
  rejected: { label: "נדחה — נשמרו התאריכים הקיימים", cls: "bg-status-danger-050 text-status-danger" },
  conflict: { label: "התנגשות — לא הוחל", cls: "bg-status-danger-050 text-status-danger" },
  superseded: { label: "הוחלף ברוויזיה חדשה יותר", cls: "bg-hover text-muted" },
};

function ChangeCard({
  change,
  onApprove,
  onReject,
  onReconcile,
  onRetryEmail,
  busy,
}: {
  change: ExternalChangeView;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onReconcile?: (id: string) => void;
  onRetryEmail?: (id: string) => void;
  busy: boolean;
}) {
  const pill = APPLY_PILL[change.applyStatus];
  const awaiting = change.applyStatus === "pending_approval";
  const nightsLabel =
    change.nightsDiff === 0
      ? "ללא שינוי במספר הלילות"
      : `הפרש לילות: ${change.nightsDiff > 0 ? "+" : ""}${change.nightsDiff}`;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold text-ink">
          {change.otaName ?? "ערוץ"} · הזמנה {change.otaReservationCode ?? "—"}
          {change.reservationNumber ? ` · GuestHub ${change.reservationNumber}` : ""}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${pill.cls}`}>
          {pill.label}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm text-text2">
        <span>חדר: {change.roomLabels.length > 0 ? change.roomLabels.join(", ") : "—"}</span>
        <span>
          תאריכים נוכחיים: {change.oldCheckIn} ← {change.oldCheckOut}
        </span>
        <span className="font-semibold text-ink">
          תאריכים מוצעים: {change.newCheckIn} ← {change.newCheckOut}
        </span>
        <span>{nightsLabel}</span>
        <span>התקבל: {change.receivedAtDisplay}</span>
      </div>
      {change.applyStatus === "conflict" && change.conflictDetail && (
        <p className="text-sm font-semibold text-status-danger">{change.conflictDetail}</p>
      )}
      {awaiting && onApprove && onReject && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onApprove(change.id)}
            disabled={busy}
            aria-disabled={busy}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            אישור השינוי
          </button>
          <button
            type="button"
            onClick={() => onReject(change.id)}
            disabled={busy}
            aria-disabled={busy}
            className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-status-danger transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            דחייה — שמירת התאריכים הקיימים
          </button>
          <span className="text-xs text-muted">
            הלוח ממשיך להציג את התאריכים הנוכחיים עד להחלטה. דחייה אינה מבטלת את השינוי מול הערוץ.
          </span>
        </div>
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
        {onReconcile && !awaiting && (
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

  function approve(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await approveExternalChangeAction({ id });
      setMsg(
        res.success
          ? { tone: "ok", text: "השינוי אושר — התאריכים החדשים הוחלו בלוח השנה" }
          : { tone: "err", text: res.error },
      );
      await reload();
    });
  }

  function reject(id: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await rejectExternalChangeAction({ id });
      setMsg(
        res.success
          ? { tone: "ok", text: "השינוי נדחה — התאריכים הקיימים נשמרו" }
          : { tone: "err", text: res.error },
      );
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
        שינויי תאריכים שהתקבלו מהערוץ להזמנות קיימות ממתינים לאישורכם — הלוח ממשיך להציג את
        התאריכים הנוכחיים עד להחלטה. שימו לב: הערוץ מחשיב את השינוי כמאושר מצדו; דחייה היא
        החלטה מקומית בלבד ואינה מבטלת את השינוי מול הערוץ.
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
            <ChangeCard
              key={c.id}
              change={c}
              onApprove={approve}
              onReject={reject}
              onReconcile={reconcile}
              onRetryEmail={retryEmail}
              busy={pending}
            />
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
