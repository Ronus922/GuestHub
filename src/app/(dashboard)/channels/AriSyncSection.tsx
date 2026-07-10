"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { getAriSyncStatusAction, requestFullSyncAction, type AriSyncStatus } from "@/lib/channel/admin";
import { PHASE_LABELS, formatDuration, type FullSyncProgress } from "@/lib/channel/ari-progress";

// ARI synchronisation status + THE Full Sync action (D68), with real persisted
// progress (D69). This is the same single control that replaced the disabled
// "סנכרון מלא / בקרוב" placeholder — it is not a second sync button.
//
// The progress it renders is READ from channel_sync_jobs.payload.progress, which
// the PM2 channel worker writes as it goes. Nothing here computes progress, and
// nothing here is timer-driven: closing the tab, refreshing or restarting the web
// process does not affect the run or lose its state.
//
// HYDRATION CONTRACT (D71). This component renders ONLY what the server put in the
// snapshot. It calls no date, locale, clock or browser API during render — every
// timestamp arrives pre-formatted as `initial.display.*`, formatted once on the
// server in the property timezone. The server ran in UTC and the operator's browser
// does not; formatting here made the two renders disagree and React threw #418,
// regenerating the tree (which is what made the confirmation buttons unreliable).
// The one clock read left, `Date.now()` in the elapsed ticker, lives inside a
// useEffect and therefore cannot run before hydration.
// Enforced by scripts/check-channels-hydration.mjs.
//
// DELIBERATELY NOT HERE (§12/§14): no daily price table, no preview grid, no
// simulator, no wizard, no editable pricing control, no per-room or per-plan
// action, no technical log viewer. Prices, restrictions and availability are
// managed ONLY in Bulk Update (/rates) and Rate Plans (/rate-plans).

type Msg = { tone: "ok" | "err" | "warn"; text: string } | null;

/** poll only while a run is live (§5) */
const POLL_MS = 2500;

/**
 * Live elapsed time for a run in flight. Returns `null` on the server and on the
 * first client render, so both produce the same markup; the caller falls back to
 * the persisted start time until this mounts.
 */
function useElapsed(startedAtMs: number | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (startedAtMs === null) return;
    const tick = () => setText(formatDuration(Date.now() - startedAtMs));
    tick(); // after hydration, not during it
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [startedAtMs]);
  return text;
}

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

// Determinate, RTL-aware, accessible. No endless animation: the value is always
// a real milestone percentage.
function ProgressBar({ percent, label, tone }: { percent: number; label: string; tone: "run" | "ok" | "err" }) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const fill = tone === "ok" ? "bg-status-success" : tone === "err" ? "bg-status-danger" : "bg-primary";
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      aria-valuetext={`${pct}% — ${label}`}
      className="h-2.5 w-full overflow-hidden rounded-full bg-hover"
      dir="rtl"
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function RunningPanel({ p, display }: { p: FullSyncProgress; display: AriSyncStatus["display"] }) {
  // Before hydration both renders show the persisted start time; the live clock
  // takes over only once the effect has run. The PERCENTAGE never comes from here
  // — it is whatever the worker last persisted.
  const live = useElapsed(display.startedAtMs);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-bold text-ink">סנכרון מלא מתבצע — {p.percent}%</span>
        <span className="text-xs text-muted">{live ?? display.startedAt}</span>
      </div>

      <ProgressBar percent={p.percent} label={PHASE_LABELS[p.phase]} tone="run" />

      <p className="text-sm font-semibold text-text2">{PHASE_LABELS[p.phase]}</p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
        {p.roomsTotal > 0 && (
          <>
            <dt>חדרים</dt>
            <dd className="text-end font-semibold text-text2">{p.roomsProjected}/{p.roomsTotal}</dd>
          </>
        )}
        {p.ratePlansTotal > 0 && (
          <>
            <dt>תוכניות תעריף</dt>
            <dd className="text-end font-semibold text-text2">{p.ratePlansProjected}/{p.ratePlansTotal}</dd>
          </>
        )}
        {p.days > 0 && (
          <>
            <dt>טווח</dt>
            <dd className="text-end font-semibold text-text2">{p.days} ימים</dd>
          </>
        )}
        <dt>התחיל</dt>
        <dd className="text-end font-semibold text-text2">{display.startedAt}</dd>
      </dl>

      <p className="text-xs text-faint">הסנכרון ממשיך ברקע גם אם תסגור את הדף.</p>
    </div>
  );
}

function FinishedPanel({
  p,
  outcome,
  display,
}: {
  p: FullSyncProgress;
  outcome: AriSyncStatus["outcome"];
  display: AriSyncStatus["display"];
}) {
  const success = outcome === "success";
  const partial = outcome === "partial_failure";
  const warned = outcome === "warnings";

  const title = success
    ? `סנכרון מלא הושלם — 100%`
    : warned
      ? `הסנכרון הסתיים עם אזהרות — ${p.percent}%`
      : partial
        ? `זמינות נשלחה, מחירים והגבלות נכשלו — ${p.percent}%`
        : `הסנכרון נכשל — ${p.percent}%`;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <span className={`text-sm font-bold ${success ? "text-status-success" : warned ? "text-status-warning" : "text-status-danger"}`}>
        {title}
      </span>

      <ProgressBar percent={p.percent} label={PHASE_LABELS[p.phase]} tone={success ? "ok" : "err"} />

      <ul className="flex flex-col gap-1 text-xs text-text2">
        <li>{p.availabilitySubmitted ? "✓" : "✗"} זמינות נשלחה</li>
        <li>{p.restrictionsSubmitted ? "✓" : "✗"} מחירים והגבלות נשלחו</li>
        <li>אזהרות: {p.warnings}</li>
        <li>סנכרון אוטומטי: {success ? "פעיל" : "לא הופעל"}</li>
        {p.blocked > 0 && <li className="text-status-warning">שילובים ללא מחיר (נשלחו כסגורים למכירה): {p.blocked}</li>}
        <li>זמן סיום: {display.finishedAt}</li>
        {display.duration && <li>משך: {display.duration}</li>}
        {p.taskIds.length > 0 && (
          <li className="font-mono text-[11px] text-muted">
            מזהי משימה: {p.taskIds.map((t) => t.slice(0, 8)).join(", ")}
          </li>
        )}
      </ul>

      {!success && p.message && (
        <p role="alert" className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
          {p.message}
        </p>
      )}
    </div>
  );
}

export function AriSyncSection({ connectionId, initial }: { connectionId: string; initial: AriSyncStatus }) {
  // §3 — the ONE serialized server snapshot, used verbatim for the first render.
  // Nothing is re-derived from the browser clock, browser storage or a second fetch.
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const mounted = useRef(true);

  const running = view.running;
  const busy = pending || running;
  const progress = view.progress;
  const display = view.display;

  const reload = useCallback(async () => {
    const res = await getAriSyncStatusAction(connectionId);
    if (mounted.current && res.success && res.data) setView(res.data);
  }, [connectionId]);

  // §5 — polling begins only after hydration, only while a run is live, and stops
  // on completed/failed/no run/unmount. It never touches the first render.
  useEffect(() => {
    mounted.current = true;
    if (!running) return () => { mounted.current = false; };
    const t = setInterval(reload, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [running, reload]);

  function confirmFullSync() {
    setConfirming(false);
    setMsg(null);
    startTransition(async () => {
      const res = await requestFullSyncAction(connectionId);
      if (!res.success) setMsg({ tone: "err", text: res.error });
      // §6 — the server refuses to create a second run and reports the live one
      else if (res.data?.alreadyRunning) setMsg({ tone: "warn", text: "סנכרון מלא כבר מתבצע" });
      else setMsg({ tone: "ok", text: "הסנכרון המלא נשלח לעובד הרקע ויתבצע ברקע" });
      await reload();
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold text-ink">סנכרון ARI</h2>

      {/* A run exists but the worker has not claimed it yet: honest 0%, no fake
          motion, and the same "keeps running if you close the page" promise. */}
      {running && !progress && (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <span className="text-sm font-bold text-ink">סנכרון מלא מתבצע — 0%</span>
          <ProgressBar percent={0} label="ממתין לעובד הרקע" tone="run" />
          <p className="text-sm font-semibold text-text2">ממתין לעובד הרקע</p>
          <p className="text-xs text-faint">הסנכרון ממשיך ברקע גם אם תסגור את הדף.</p>
        </div>
      )}
      {running && progress && <RunningPanel p={progress} display={display} />}
      {!running && progress && <FinishedPanel p={progress} outcome={view.outcome} display={display} />}

      <div className="rounded-xl border border-line bg-surface">
        <div className="divide-y divide-line">
          <Row
            label="מצב"
            value={view.active ? "פעיל — סנכרון מצטבר רץ" : view.fullSyncRequired ? "נדרש סנכרון מלא" : "לא פעיל"}
            tone={view.active ? "ok" : "warn"}
          />
          <Row label="סנכרון מוצלח אחרון" value={display.lastSuccessfulSyncAt} />
          <Row label="טווחים ממתינים לשליחה" value={String(view.pendingRanges)} />
          {view.failedRanges > 0 && <Row label="טווחים שנכשלו" value={String(view.failedRanges)} tone="err" />}
          <Row
            label="עובד הרקע"
            value={view.worker?.online ? `פעיל (${display.workerBeatAt})` : "אינו פועל"}
            tone={view.worker?.online ? "ok" : "err"}
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

      {/* THE single Full Sync control (§12: no second sync button anywhere).
          Plain buttons in a div — no <form>, no nested form, no interactive
          element inside another, so the markup is identical on both renders. */}
      <div className="flex flex-wrap items-center gap-2">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            aria-disabled={busy}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running ? "סנכרון מלא כבר מתבצע" : "סנכרון מלא"}
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
                aria-disabled={busy}
                className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                בצע סנכרון מלא
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-text2 transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
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
