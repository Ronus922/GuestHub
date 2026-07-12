"use client";

import { useState, useTransition } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  getChannexRatePlanSyncContextAction,
  startChannexRatePlanSyncAction,
  startChannexRatePlanTitleSyncAction,
  type RatePlanSyncContext,
} from "@/lib/channel/rate-plan-admin";

// (Local Rate Plan × mapped physical room) → Channex Rate Plan sync (D65/D67).
// super_admin only (the page gates on canManageChannels; the actions re-check
// server-side). ONE compact card — creation button + (only when a local plan
// was renamed and external titles drifted) a title-update button, each with a
// short confirmation dialog. The local plans are read from the canonical
// pricing_plans table and every count is calculated, never hardcoded.
//
// Nothing here writes to Channex on load. Only the explicit, confirmed actions
// issue POST /rate_plans (creation — stop-sold, zero placeholder rates) or
// PUT /rate_plans/:id (title rename of an existing mapped plan — full-payload
// echo, title is the only change, the external UUID is preserved).

type Msg = { tone: "ok" | "err"; text: string } | null;

// A bounded run creates as much as fits in its server budget and reports the
// remainder; we keep resuming until done. Only missing combinations are ever
// created — the resume never re-creates a mapped one.
const MAX_RESUME_ROUNDS = 12;

export function ChannexRatePlansSection({ initial }: { initial: RatePlanSyncContext }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [confirmingTitles, setConfirmingTitles] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const busy = pending || submitting;
  const canAct = view.connected && view.configured && view.creatable > 0 && !view.running;
  const canRename = view.connected && view.configured && view.titleMismatches > 0 && !view.running;
  const matchingTitles = view.mappedCombinations - view.titleMismatches;

  async function reload() {
    const res = await getChannexRatePlanSyncContextAction();
    if (res.success && res.data) setView(res.data);
  }

  // Guarded against double submission: the `submitting` flag, the disabled
  // button, and the server-side durable run mutex.
  function runSync() {
    if (submitting) return;
    setSubmitting(true);
    setConfirming(false);
    setMsg(null);
    startTransition(async () => {
      try {
        let created = 0;
        let failed = 0;
        for (let round = 0; round < MAX_RESUME_ROUNDS; round++) {
          const res = await startChannexRatePlanSyncAction();
          if (!res.success) {
            setMsg({
              tone: created > 0 ? "ok" : "err",
              text: created > 0 ? `נוצרו ${created} תוכניות תעריף; ${res.error}` : res.error,
            });
            return;
          }
          created += res.data!.created;
          failed += res.data!.failed;
          if (res.data!.stopped !== "budget") {
            setMsg(
              failed > 0 || res.data!.partial
                ? {
                    tone: "err",
                    text: `נוצרו ${created} תוכניות תעריף; ${failed} נכשלו, ${res.data!.remaining} נותרו — ניתן ללחוץ שוב להמשך`,
                  }
                : { tone: "ok", text: `נוצרו ${created} תוכניות תעריף ב-Channex — סגורות למכירה עד סנכרון ARI` },
            );
            return;
          }
        }
        setMsg({ tone: "err", text: `נוצרו ${created} תוכניות תעריף — נותרו עוד, ניתן ללחוץ שוב להמשך` });
      } finally {
        await reload();
        setSubmitting(false);
      }
    });
  }

  // Title rename of EXISTING mapped plans after a local plan rename — only the
  // still-mismatched set is ever sent; a re-click retries failed items only.
  function runTitleSync() {
    if (submitting) return;
    setSubmitting(true);
    setConfirmingTitles(false);
    setMsg(null);
    startTransition(async () => {
      try {
        let updated = 0;
        let failed = 0;
        for (let round = 0; round < MAX_RESUME_ROUNDS; round++) {
          const res = await startChannexRatePlanTitleSyncAction();
          if (!res.success) {
            setMsg({
              tone: updated > 0 ? "ok" : "err",
              text: updated > 0 ? `עודכנו ${updated} שמות; ${res.error}` : res.error,
            });
            return;
          }
          updated += res.data!.updated + res.data!.skipped;
          failed += res.data!.failed;
          if (res.data!.stopped !== "budget") {
            setMsg(
              failed > 0 || res.data!.remaining > 0
                ? {
                    tone: "err",
                    text: `עודכנו ${updated} שמות; ${failed} נכשלו — ניתן ללחוץ שוב לניסיון חוזר של הפריטים שנכשלו בלבד`,
                  }
                : { tone: "ok", text: `עודכנו ${updated} שמות ב־Channex — כל השמות תואמים` },
            );
            return;
          }
        }
        setMsg({ tone: "err", text: `עודכנו ${updated} שמות — נותרו עוד, ניתן ללחוץ שוב להמשך` });
      } finally {
        await reload();
        setSubmitting(false);
      }
    });
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="h3">תוכניות תעריף ב־Channex</h2>
      <div className="card">
        <div className="card-bd flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <div>
              <dt className="t-label text-faint">תוכניות פעילות ב־GuestHub</dt>
              <dd className="h3">
                <bdi className="ltr-num">{view.planNames.length}</bdi>
              </dd>
            </div>
            <div>
              <dt className="t-label text-faint">חדרים ממופים</dt>
              <dd className="h3">
                <bdi className="ltr-num">
                  {view.mappedRooms}
                  <span className="text-faint"> / {view.activeRooms}</span>
                </bdi>
              </dd>
            </div>
            <div>
              <dt className="t-label text-faint">שילובים נדרשים</dt>
              <dd className="h3">
                <bdi className="ltr-num">{view.requiredCombinations}</bdi>
              </dd>
            </div>
            <div>
              <dt className="t-label text-faint">תוכניות ממופות ב־Channex</dt>
              <dd className="h3">
                <bdi className="ltr-num">
                  {view.mappedCombinations}
                  <span className="text-faint"> / {view.requiredCombinations}</span>
                </bdi>
              </dd>
            </div>
            {view.mappedCombinations > 0 && (
              <div>
                <dt className="t-label text-faint">שמות תואמים</dt>
                <dd className="h3">
                  <bdi className="ltr-num">
                    {matchingTitles}
                    <span className="text-faint"> / {view.mappedCombinations}</span>
                  </bdi>
                </dd>
              </div>
            )}
          </dl>

          {view.titleMismatches > 0 && (
            <p className="t-secondary rounded-lg bg-status-warning-050 px-3 py-2 text-status-warning">
              <bdi className="ltr-num">{view.titleMismatches}</bdi> שמות דורשים עדכון
            </p>
          )}

          {view.planNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="t-label">תוכניות מקומיות:</span>
              {view.planNames.map((name) => (
                <span key={name} className="chip chip-neutral">
                  {name}
                </span>
              ))}
            </div>
          )}

          {view.problems.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg bg-status-danger-050 px-3 py-2">
              <p className="t-label text-status-danger">
                שגיאות (<bdi className="ltr-num">{view.problems.length}</bdi>)
              </p>
              {view.problems.slice(0, 5).map((p) => (
                <p key={`${p.roomNumber}:${p.planName}`} className="t-label text-status-danger">
                  חדר <bdi className="ltr-num">{p.roomNumber}</bdi> · {p.planName} — {p.message}
                </p>
              ))}
              {view.problems.length > 5 && (
                <p className="t-label text-status-danger">
                  ועוד <bdi className="ltr-num">{view.problems.length - 5}</bdi>…
                </p>
              )}
            </div>
          )}

          {msg && (
            <p
              className={`t-secondary rounded-lg px-3 py-2 ${
                msg.tone === "ok"
                  ? "bg-status-success-050 text-status-success"
                  : "bg-status-danger-050 text-status-danger"
              }`}
            >
              {msg.text}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canAct || busy}
              onClick={() => setConfirming(true)}
              className="btn btn-primary"
            >
              {busy ? "מסנכרן…" : "יצירת תוכניות התעריף ב־Channex Staging"}
            </button>
            {view.titleMismatches > 0 && (
              <button
                type="button"
                disabled={!canRename || busy}
                onClick={() => setConfirmingTitles(true)}
                className="btn btn-secondary"
              >
                {busy ? "מעדכן…" : "עדכון שמות ב־Channex"}
              </button>
            )}
          </div>
        </div>
      </div>

      {confirmingTitles && (
        <ConfirmDialog
          title="עדכון שמות ב־Channex"
          onClose={() => setConfirmingTitles(false)}
          footer={
            <>
              <button type="button" disabled={busy} onClick={runTitleSync} className="btn btn-primary">
                עדכן שמות
              </button>
              <button type="button" onClick={() => setConfirmingTitles(false)} className="btn btn-secondary">
                ביטול
              </button>
            </>
          }
        >
          <p className="h4">
            לעדכן את שמות <bdi className="ltr-num">{view.titleMismatches}</bdi> תוכניות התעריף הקיימות ב־Channex?
          </p>
          <p className="t-secondary">
            יעודכנו רק שמות (title) של תוכניות קיימות — ללא יצירה, מחיקה, מחירים או זמינות.
          </p>
        </ConfirmDialog>
      )}

      {confirming && (
        <ConfirmDialog
          title="יצירת תוכניות תעריף ב־Channex Staging"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" disabled={busy} onClick={runSync} className="btn btn-primary">
                צור תוכניות תעריף
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="btn btn-secondary">
                ביטול
              </button>
            </>
          }
        >
          <p className="h4">
            ליצור <bdi className="ltr-num">{view.creatable}</bdi> תוכניות תעריף ב־Channex מתוך{" "}
            <bdi className="ltr-num">{view.planNames.length}</bdi> התוכניות הקיימות ו־
            <bdi className="ltr-num">{view.mappedRooms}</bdi> החדרים הממופים?
          </p>
          <p className="t-secondary">
            התוכניות ייווצרו סגורות למכירה (Stop Sell) וללא מחירים אמיתיים — עד סנכרון ה-ARI הראשון.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
