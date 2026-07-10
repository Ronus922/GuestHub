"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { RATES_SYNC_TEXT, type RatesSyncStatus } from "@/lib/channel/sync-state";
import { getRatesSyncStatusAction, syncChannelsNowAction } from "./sync-actions";

// The /rates channel-sync control (D75): a persisted status chip + the manual
// "סנכרן ערוצים" button. Replaces the dead pre-4B placeholder span.
//
// HYDRATION CONTRACT (D71, as /channels): the first render uses the server
// snapshot verbatim. No date, locale, clock, storage or browser API in any
// render path — every timestamp arrives pre-formatted in `initial.lastSyncAt`.
// Polling starts only after mount, only while work is pending, and stops on
// synced/failed/unmount. Enforced by scripts/check-rates-sync.mjs.
//
// THE BUTTON NEVER RUNS A FULL SYNC. It calls syncChannelsNowAction, which
// re-queues existing failed ranges once, clears backoff on pending ranges and
// enqueues the same deduplicated incremental drain job every save enqueues.
// With nothing to send it answers "כל השינויים כבר מסונכרנים" and creates
// nothing. It is disabled only while its own request is in flight.

type Note = { tone: "ok" | "warn" | "err"; text: string } | null;

/** poll only while pending work exists */
const POLL_MS = 5000;

const CHIP_CLS: Record<RatesSyncStatus["state"], string> = {
  synced: "bg-[var(--color-status-success-050)] text-[var(--color-status-success)]",
  syncing: "bg-[#eef1fd] text-[var(--color-primary)]",
  failed: "bg-[#fbe9ee] text-[#a23b52]",
  not_connected: "bg-[#f2f4f8] text-[var(--color-faint)]",
};

export function ChannelSyncControl({
  initial,
  savePulse,
}: {
  initial: RatesSyncStatus;
  /** increments on every successful canonical save on this screen */
  savePulse: number;
}) {
  // the ONE serialized server snapshot, used verbatim for the first render
  const [status, setStatus] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const mounted = useRef(true);
  // a save was just made here — translate the next status changes into the
  // save-feedback wording until the cycle settles (synced/failed)
  const saveWatch = useRef(false);

  // router.refresh() after a save re-renders the server page → fresh snapshot
  useEffect(() => {
    setStatus(initial);
  }, [initial]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const res = await getRatesSyncStatusAction();
    if (mounted.current && res.success && res.data) setStatus(res.data);
  }, []);

  // poll only while work is pending; stop on synced/failed/not-connected
  const syncing = status.state === "syncing";
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [syncing, reload]);

  // Phase 5 — save feedback, decoupled from save success (which the save UIs
  // already report): refetch immediately, then narrate the REAL persisted state.
  useEffect(() => {
    if (savePulse === 0) return;
    saveWatch.current = true;
    void reload();
  }, [savePulse, reload]);

  useEffect(() => {
    if (!saveWatch.current) return;
    if (status.state === "syncing") {
      setNote({ tone: "ok", text: "השינוי נשמר וממתין לסנכרון" });
    } else if (status.state === "synced") {
      setNote({ tone: "ok", text: "השינוי נשמר וסונכרן" });
      saveWatch.current = false;
    } else if (status.state === "failed") {
      setNote({ tone: "err", text: "השינוי נשמר, אך הסנכרון נכשל" });
      saveWatch.current = false;
    } else {
      setNote({ tone: "ok", text: "השינוי נשמר" });
      saveWatch.current = false;
    }
  }, [status]);

  async function syncNow() {
    setSubmitting(true);
    setNote(null);
    saveWatch.current = false;
    const res = await syncChannelsNowAction();
    if (!mounted.current) return;
    setSubmitting(false);
    if (!res.success) {
      setNote({ tone: "err", text: res.error });
      return;
    }
    const d = res.data!;
    setStatus(d.status);
    if (d.nothingToSync) {
      setNote({ tone: "ok", text: "כל השינויים כבר מסונכרנים" });
    } else {
      setNote({
        tone: "ok",
        text:
          d.retriedFailed > 0
            ? `מסנכרן… ${d.pendingRanges} טווחים נשלחים לערוץ (כולל ${d.retriedFailed} בניסיון חוזר)`
            : `מסנכרן… ${d.pendingRanges} טווחים נשלחים לערוץ`,
      });
    }
  }

  // pending work with a dead worker will not drain — say so, honestly
  const workerDown = status.connected && !status.workerOnline && status.pendingRanges > 0;
  const chipText = workerDown
    ? "ממתין לעובד הרקע"
    : status.pendingRanges > 0
      ? `${RATES_SYNC_TEXT[status.state]} · ${status.pendingRanges} ממתינים`
      : RATES_SYNC_TEXT[status.state];
  const chipTitle =
    `סנכרון מוצלח אחרון: ${status.lastSyncAt}` +
    (status.failedRanges > 0 ? ` · טווחים שנכשלו: ${status.failedRanges}` : "") +
    (status.connected && !status.workerOnline ? " · עובד הרקע אינו פועל" : "");

  return (
    <>
      <span
        data-testid="rates-sync-status"
        title={chipTitle}
        className={`inline-flex items-center gap-2 h-9 px-3.5 rounded-xl text-[12.5px] font-bold select-none ${
          workerDown ? "bg-[#fbeecd] text-[#8a6d1f]" : CHIP_CLS[status.state]
        }`}
      >
        <Icon name="channels" size={15} />
        {chipText}
      </span>
      <button
        type="button"
        data-testid="rates-sync-now"
        onClick={syncNow}
        disabled={submitting}
        aria-disabled={submitting}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-xl border-[1.5px] border-[var(--color-line)] text-[12.5px] font-bold text-[var(--color-ink)] hover:bg-[#f5f7fb] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Icon name="refresh" size={15} />
        {submitting ? "שולח…" : "סנכרן ערוצים"}
      </button>
      {note && (
        <span
          role="status"
          className={`text-[12.5px] font-bold ${
            note.tone === "ok"
              ? "text-[var(--color-status-success)]"
              : note.tone === "warn"
                ? "text-[#8a6d1f]"
                : "text-[#a23b52]"
          }`}
        >
          {note.text}
        </span>
      )}
    </>
  );
}
