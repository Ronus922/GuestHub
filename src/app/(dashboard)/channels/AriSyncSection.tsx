"use client";

import { useEffect, useState, useTransition } from "react";
import { getAriSyncStatusAction, requestFullSyncAction, type AriSyncStatus } from "@/lib/channel/admin";

// ARI synchronisation status + THE Full Sync action (D68). This replaces the
// disabled "סנכרון מלא / בקרוב" placeholder that stood here — it is the same
// single control, now wired to the existing requestFullSyncAction.
//
// DELIBERATELY NOT HERE (§12/§14): no daily price table, no preview grid, no
// simulator, no wizard, no editable pricing control, no per-room or per-plan
// action, and no second sync button. Prices, restrictions and availability are
// managed ONLY in Bulk Update (/rates) and Rate Plans (/rate-plans). This card
// is diagnostics: state, counts, safe references, safe last error.

type Msg = { tone: "ok" | "err"; text: string } | null;

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "—";

const JOB_LABEL: Record<string, string> = {
  queued: "ממתין לעובד",
  processing: "מסתנכרן…",
  succeeded: "הושלם",
  retry_wait: "ממתין לניסיון חוזר",
  failed: "נכשל",
  dead_letter: "נכשל סופית",
  suppressed: "מושהה",
  cancelled: "בוטל",
};

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

export function AriSyncSection({ connectionId, initial }: { connectionId: string; initial: AriSyncStatus }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const job = view.fullSyncJob;
  const running = job?.status === "queued" || job?.status === "processing";
  const busy = pending || running;

  async function reload() {
    const res = await getAriSyncStatusAction(connectionId);
    if (res.success && res.data) setView(res.data);
  }

  // while a sync is in flight the worker owns it — poll until it settles
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, connectionId]);

  function confirmFullSync() {
    setConfirming(false);
    setMsg(null);
    startTransition(async () => {
      const res = await requestFullSyncAction(connectionId);
      if (!res.success) setMsg({ tone: "err", text: res.error });
      else setMsg({ tone: "ok", text: "הסנכרון המלא נשלח לעובד הרקע ויתבצע ברקע" });
      await reload();
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold text-ink">סנכרון ARI</h2>

      <div className="rounded-xl border border-line bg-surface">
        <div className="divide-y divide-line">
          <Row
            label="מצב"
            value={view.active ? "פעיל — סנכרון מצטבר רץ" : view.fullSyncRequired ? "נדרש סנכרון מלא" : "לא פעיל"}
            tone={view.active ? "ok" : "warn"}
          />
          <Row label="סנכרון מוצלח אחרון" value={fmt(view.lastSuccessfulSyncAt)} />
          <Row label="טווחים ממתינים לשליחה" value={String(view.pendingRanges)} />
          {view.failedRanges > 0 && (
            <Row label="טווחים שנכשלו" value={String(view.failedRanges)} tone="err" />
          )}
          {job && (
            <>
              <Row label="סנכרון מלא אחרון" value={JOB_LABEL[job.status] ?? job.status} tone={job.status === "succeeded" ? "ok" : job.status === "queued" || job.status === "processing" ? "warn" : "err"} />
              {job.dateFrom && job.dateTo && <Row label="טווח שנשלח" value={`${job.dateFrom} – ${job.dateTo}`} />}
              {job.taskIds.length > 0 && (
                <Row label="מזהי משימה ב-Channex" value={job.taskIds.map((t) => t.slice(0, 8)).join(", ")} />
              )}
            </>
          )}
          <Row
            label="עובד הרקע"
            value={view.worker?.online ? `פעיל (${fmt(view.worker.beatAt)})` : "אינו פועל"}
            tone={view.worker?.online ? "ok" : "err"}
          />
          {view.lastError && <Row label="שגיאה אחרונה" value={view.lastError} tone="err" />}
        </div>
      </div>

      {msg && (
        <p className={`px-4 py-2 text-sm font-semibold ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}>
          {msg.text}
        </p>
      )}

      {/* THE single Full Sync control (§12: no second sync button anywhere) */}
      <div className="flex flex-wrap items-center gap-2">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? "סנכרון מלא רץ…" : "סנכרון מלא"}
          </button>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
            <p className="text-sm text-text2">
              יישלחו לערוץ המחירים, ההגבלות והזמינות הקנוניים של 500 הימים הקרובים, כפי שהוגדרו ב&quot;עדכון קבוצתי&quot; וב&quot;תוכניות תעריף&quot;.
              הפעולה אינה משנה מחיר, חדר, תוכנית או הזמנה.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={confirmFullSync}
                disabled={busy}
                className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                אישור ושליחה
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-text2 transition hover:bg-hover"
              >
                ביטול
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
