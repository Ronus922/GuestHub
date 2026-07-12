"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/shared/Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  getChannexRoomSyncContextAction,
  previewChannexRoomTypeSyncAction,
  startChannexRoomTypeSyncAction,
  refreshChannexRoomTypesAction,
  adoptChannexRoomTypeAction,
  type RoomSyncContext,
  type SyncPreview,
} from "@/lib/channel/room-type-admin";
import type { PreviewRow, RowStatus } from "@/lib/channel/room-type-sync";

// Physical room → Channex Room Type synchronization (D64). super_admin only (the
// page gates on canManageChannels; every action re-checks server-side).
//
// The inventory unit is the PHYSICAL ROOM: one room → one Channex Room Type →
// count_of_rooms = 1. The 3 GuestHub room categories are descriptive metadata and
// are never mapped as Channex inventory.
//
// Nothing on this screen creates an external Room Type. Opening the page, testing
// the connection and refreshing all perform zero writes upstream; only the
// explicit, confirmed action below issues POST /room_types.

const dtFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Jerusalem" });
const fmtDt = (v: string | null) => (v ? dtFmt.format(new Date(v)) : "—");

type Msg = { tone: "ok" | "err"; text: string } | null;

// §3 — one chip anatomy; the tone is always one of the eight §3.1 triplets.
const STATUS_META: Record<RowStatus, { label: string; cls: string }> = {
  ready: { label: "מוכן", cls: "chip-transfer" },
  validation_required: { label: "נדרש תיקון נתונים", cls: "chip-approval" },
  excluded_inactive: { label: "לא פעיל — לא יסונכרן", cls: "chip-neutral" },
  creating: { label: "ביצירה", cls: "chip-approval" },
  mapped: { label: "ממופה", cls: "chip-paid" },
  adopted: { label: "אומץ", cls: "chip-paid" },
  inaccessible: { label: "לא נגיש", cls: "chip-failed" },
  failed: { label: "נכשל", cls: "chip-failed" },
  reconciliation_required: { label: "נדרשת התאמה מחדש", cls: "chip-failed" },
};

export function ChannexRoomTypesSection({ initial }: { initial: RoomSyncContext }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [adoptTarget, setAdoptTarget] = useState<{ externalId: string; title: string | null } | null>(null);
  const [adoptRoomId, setAdoptRoomId] = useState("");

  const { plan, propertyId } = view;
  const s = plan.summary;
  const canAct = view.connected && view.secretsKeyConfigured && view.apiKeyConfigured && !!propertyId;
  const busy = pending || submitting;

  async function reload() {
    const res = await getChannexRoomSyncContextAction();
    if (res.success && res.data) setView(res.data);
  }

  function onOpenPreview() {
    setMsg(null);
    startTransition(async () => {
      const res = await previewChannexRoomTypeSyncAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      setPreview(res.data!);
    });
  }

  // Guarded against double submission at three layers: this ref-free `submitting`
  // flag, the disabled button, and the server's durable parent-job mutex.
  function onConfirmSync() {
    if (submitting) return;
    setSubmitting(true);
    setPreview(null);
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await startChannexRoomTypeSyncAction();
        if (!res.success) return setMsg({ tone: "err", text: res.error });
        const r = res.data!;
        await reload();
        setMsg({
          tone: r.partial ? "err" : "ok",
          text: r.partial
            ? `סנכרון חלקי: נוצרו ${r.created}, נכשלו ${r.failed}, נותרו ${r.remaining}. ניתן להמשיך את הסנכרון.`
            : `הסנכרון הושלם — נוצרו ${r.created} סוגי חדרים ב-Channex Staging.`,
        });
      } finally {
        setSubmitting(false);
      }
    });
  }

  function onRefresh() {
    setMsg(null);
    startTransition(async () => {
      const res = await refreshChannexRoomTypesAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      const r = res.data!;
      await reload();
      setMsg({
        tone: r.inaccessible > 0 || r.externalUnmapped > 0 ? "err" : "ok",
        text:
          `נמצאו ${r.externalRoomTypes} סוגי חדרים ב-Channex · אומתו ${r.verified}` +
          (r.drifted ? ` · ${r.drifted} עם אי-התאמה` : "") +
          (r.inaccessible ? ` · ${r.inaccessible} לא נגישים` : "") +
          (r.externalUnmapped ? ` · ${r.externalUnmapped} ללא מיפוי` : "") +
          (r.cleared ? ` · ${r.cleared} שוחררו לניסיון חוזר` : ""),
      });
    });
  }

  function onAdopt() {
    if (!adoptTarget || !adoptRoomId) return;
    const target = adoptTarget;
    setAdoptTarget(null);
    startTransition(async () => {
      const res = await adoptChannexRoomTypeAction({ roomId: adoptRoomId, channexRoomTypeId: target.externalId });
      setAdoptRoomId("");
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      await reload();
      setMsg({ tone: "ok", text: "סוג החדר החיצוני אומץ ומופה לחדר הפיזי" });
    });
  }

  const adoptableRooms = plan.rows.filter((r) => r.isActive && !r.channexRoomTypeId);
  const resumeMode = s.mappedRooms > 0 && s.validReady > 0;

  return (
    <section className="card">
      <div className="card-hd justify-between">
        <div className="flex items-center gap-2">
          <Icon name="rooms" size={20} className="text-primary" />
          <span className="h4">סנכרון חדרים פיזיים ל־Channex</span>
        </div>
        <span
          className={`chip ${
            s.activeRooms > 0 && s.mappedRooms === s.activeRooms ? "chip-paid" : "chip-neutral"
          }`}
        >
          <bdi className="ltr-num">{s.mappedRooms}/{s.activeRooms}</bdi> ממופים
        </span>
      </div>

      <div className="card-bd flex flex-col gap-4">
        {/* Model note — the inventory unit, and what count_of_rooms does NOT mean */}
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-primary-050 p-3">
          <Icon name="info" size={17} className="mt-0.5 shrink-0 text-primary" />
          <p className="t-label leading-relaxed text-text2">
            יחידת המיפוי ל-Channex היא <strong>החדר הפיזי</strong>: כל חדר הופך לסוג חדר אחד ב-Channex עם{" "}
            <strong>יחידה פיזית אחת</strong>. שלוש קטגוריות החדרים ב-GuestHub נשארות תיאוריות בלבד ואינן
            נרשמות כמלאי ב-Channex. כל סוג חדר מכיל יחידה פיזית אחת —{" "}
            <strong>הזמינות היומית תישאר סגורה עד לשלב סנכרון ה-ARI</strong>.
          </p>
        </div>

        {!view.connected && (
          <p className="t-label rounded-lg bg-status-warning-050 px-3 py-2 text-status-warning">
            לא קיים חיבור Channex.
          </p>
        )}
        {view.connected && !propertyId && (
          <p className="t-label rounded-lg bg-status-warning-050 px-3 py-2 text-status-warning">
            לא קיים נכס Channex ממופה — יש למפות נכס בכרטיס שלמעלה לפני סנכרון חדרים.
          </p>
        )}
        {view.connected && !view.apiKeyConfigured && (
          <p className="t-label rounded-lg bg-status-warning-050 px-3 py-2 text-status-warning">
            יש לשמור מפתח API של Channex בכרטיס החיבור למעלה.
          </p>
        )}

        {/* Summary cards */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-6">
          <Stat label="קטגוריות חדרים ב-GuestHub" value={s.roomCategories} hint="תיאורי — לא מלאי" />
          <Stat label="חדרים פיזיים פעילים" value={s.activeRooms} />
          <Stat label="תקינים ומוכנים ליצירה" value={s.validReady} />
          <Stat label="חדרים ממופים" value={s.mappedRooms} />
          <Stat label="חדרים ללא מיפוי" value={s.unmappedRooms} danger={s.unmappedRooms > 0} />
          <Stat label="שגיאות ולידציה" value={s.validationErrors} danger={s.validationErrors > 0} />
        </div>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-3">
          <Stat label="סוגי חדרים ב-Channex" value={s.externalRoomTypes} />
          <Stat label="סוגי חדרים חיצוניים ללא מיפוי" value={s.externalUnmapped} danger={s.externalUnmapped > 0} />
          <div className="rounded-xl border border-line bg-hover/40 p-4">
            <p className="h4">טרם סונכרנה</p>
            <p className="t-label mt-0.5">זמינות נוכחית ב-Channex</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onOpenPreview}
            disabled={!canAct || busy || s.validReady === 0 || view.running}
            className="btn btn-primary"
          >
            <Icon name="plus" size={20} />
            {resumeMode ? `המשך סנכרון (${s.validReady} חדרים)` : `יצירת ${s.validReady} חדרים ב־Channex Staging`}
          </button>
          <button type="button" onClick={onRefresh} disabled={!canAct || busy} className="btn btn-secondary">
            <Icon name="refresh" size={20} />
            רענון מצב החדרים מ־Channex
          </button>
          {view.running && (
            <span className="chip chip-approval">
              <span className="dot" />
              סנכרון פועל כעת
            </span>
          )}
        </div>

        {msg && (
          <p className={`t-secondary ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}>
            {msg.text}
          </p>
        )}

        {/* External Room Types with no local mapping — explicit adoption only */}
        {plan.externalUnmapped.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl border border-status-warning bg-status-warning-050 p-4">
            <p className="t-secondary text-status-warning">
              סוגי חדרים קיימים ב-Channex ללא מיפוי מקומי — אימוץ מפורש בלבד (אין אימוץ אוטומטי לפי שם):
            </p>
            {plan.externalUnmapped.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2">
                <div className="min-w-0">
                  <p className="t-secondary truncate text-ink">{e.title ?? "(ללא שם)"}</p>
                  <p className="t-label truncate text-faint">
                    <bdi className="ltr-num font-mono">{e.id}</bdi> · יחידות:{" "}
                    <bdi className="ltr-num">{e.countOfRooms ?? "—"}</bdi> ·{" "}
                    <bdi className="ltr-num">
                      {e.occAdults ?? "—"}/{e.occChildren ?? "—"}/{e.occInfants ?? "—"}
                    </bdi>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAdoptTarget({ externalId: e.id, title: e.title })}
                  disabled={busy}
                  className="btn btn-sm btn-secondary"
                >
                  אימוץ לחדר פיזי
                </button>
              </div>
            ))}
          </div>
        )}

        <PreviewTable rows={plan.rows} />
      </div>

      {preview && (
        <ConfirmDialog
          title="יצירת סוגי חדרים ב־Channex Staging"
          onClose={() => setPreview(null)}
          footer={
            <>
              <button
                type="button"
                onClick={onConfirmSync}
                disabled={busy || !!preview.blockedReason || preview.toCreate === 0}
                className="btn btn-primary"
              >
                {submitting ? "מסנכרן…" : "צור את החדרים הקיימים ב־Channex"}
              </button>
              <button type="button" onClick={() => setPreview(null)} className="btn btn-secondary">
                ביטול
              </button>
            </>
          }
        >
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5">
            <Dt>סביבה</Dt>
            <Dd className="col-span-2">Staging</Dd>
            <Dt>נכס Channex</Dt>
            <Dd className="col-span-2">{preview.propertyTitle ?? "—"}</Dd>
            <Dt>מזהה נכס</Dt>
            <Dd className="col-span-2"><bdi className="ltr-num font-mono">{preview.propertyId}</bdi></Dd>
            <Dt>חדרים פיזיים</Dt>
            <Dd className="col-span-2"><bdi className="ltr-num">{preview.activeRooms}</bdi></Dd>
            <Dt>כבר ממופים</Dt>
            <Dd className="col-span-2"><bdi className="ltr-num">{preview.alreadyMapped}</bdi></Dd>
            <Dt>ייווצרו כעת</Dt>
            <Dd className="col-span-2 text-ink"><bdi className="ltr-num">{preview.toCreate}</bdi></Dd>
            <Dt>מבנה השם</Dt>
            <Dd className="col-span-2 font-mono">חדר &lt;מספר&gt; - &lt;סוג חדר&gt;</Dd>
            <Dt>יחידות פיזיות</Dt>
            <Dd className="col-span-2">
              <bdi className="ltr-num">{preview.countOfRooms}</bdi> לכל סוג חדר
            </Dd>
          </dl>

          <div className="max-h-40 overflow-y-auto rounded-lg border border-line p-3">
            <p className="t-label mb-1 text-ink">
              שמות שייווצרו (<bdi className="ltr-num">{preview.titles.length}</bdi>)
            </p>
            <ul className="t-label flex flex-col gap-0.5 text-text2">
              {preview.titles.map((t) => (
                <li key={t.roomNumber}>{t.title}</li>
              ))}
            </ul>
          </div>

          <ul className="t-label flex flex-col gap-1 text-status-warning">
            <li>• הזמינות היומית תישאר 0 — לא מסונכרנת בשלב זה.</li>
            <li>• לא ייווצרו תוכניות תעריף (Rate Plans) ולא ייכתבו מחירים.</li>
            <li>• לא ייווצר חיבור ל-Booking.com או ל-Expedia.</li>
            <li>• חדרי GuestHub, קטגוריות ונתוני תפוסה אינם משתנים.</li>
          </ul>

          {preview.blockedReason && (
            <p className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
              {preview.blockedReason}
            </p>
          )}
        </ConfirmDialog>
      )}

      {adoptTarget && (
        <ConfirmDialog
          title="אימוץ סוג חדר קיים ב־Channex"
          onClose={() => setAdoptTarget(null)}
          footer={
            <>
              <button type="button" onClick={onAdopt} disabled={busy || !adoptRoomId} className="btn btn-primary">
                אמץ סוג חדר זה
              </button>
              <button type="button" onClick={() => setAdoptTarget(null)} className="btn btn-secondary">
                ביטול
              </button>
            </>
          }
        >
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5">
            <Dt>שם ב-Channex</Dt>
            <Dd className="col-span-2">{adoptTarget.title ?? "(ללא שם)"}</Dd>
            <Dt>מזהה Channex</Dt>
            <Dd className="col-span-2"><bdi className="ltr-num font-mono">{adoptTarget.externalId}</bdi></Dd>
          </dl>
          <label className="field">
            <span className="field-label">חדר פיזי לשיוך</span>
            <select
              className="field-input"
              value={adoptRoomId}
              onChange={(e) => setAdoptRoomId(e.target.value)}
            >
              <option value="">בחר חדר…</option>
              {adoptableRooms.map((r) => (
                <option key={r.roomId} value={r.roomId}>
                  {r.roomNumber} — {r.roomTypeName ?? "ללא סוג"}
                </option>
              ))}
            </select>
          </label>
          <p className="t-label">
            סוג החדר יאומת מול Channex לפני האימוץ. סוג חדר חיצוני אחד יכול להיות משויך לחדר פיזי אחד בלבד.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon name="list" size={17} className="text-muted" />
        <h3 className="h4">תצוגה מקדימה — חדר פיזי אחד לכל סוג חדר (לקריאה בלבד)</h3>
        <span className="chip chip-neutral">
          <bdi className="ltr-num">{rows.length}</bdi>
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[1080px] text-sm">
          <thead>
            <tr className="border-b border-line bg-hover/40">
              <th className="t-label px-4 py-3 text-start text-faint">חדר</th>
              <th className="t-label px-4 py-3 text-start text-faint">קטגוריה</th>
              <th className="t-label px-4 py-3 text-start text-faint">בניין/אזור</th>
              <th className="t-label px-4 py-3 text-start text-faint">קומה</th>
              <th className="t-label px-4 py-3 text-start text-faint">שם מוצע ב-Channex</th>
              <th className="t-label px-4 py-3 text-start text-faint">יחידות פיזיות</th>
              <th className="t-label px-4 py-3 text-start text-faint">מבוגרים</th>
              <th className="t-label px-4 py-3 text-start text-faint">ילדים</th>
              <th className="t-label px-4 py-3 text-start text-faint">תינוקות</th>
              <th className="t-label px-4 py-3 text-start text-faint">ברירת מחדל</th>
              <th className="t-label px-4 py-3 text-start text-faint">סטטוס</th>
              <th className="t-label px-4 py-3 text-start text-faint">מזהה Channex</th>
              <th className="t-label px-4 py-3 text-start text-faint">אומת</th>
              <th className="t-label px-4 py-3 text-start text-faint">הערה</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const meta = STATUS_META[r.status];
              return (
                <tr key={r.roomId} className={`border-b border-line last:border-0 ${r.isActive ? "" : "opacity-60"}`}>
                  <td className="px-4 py-3 text-ink">
                    <bdi className="ltr-num font-bold">{r.roomNumber}</bdi>
                  </td>
                  <td className="px-4 py-3 text-text2">{r.roomTypeName ?? "—"}</td>
                  <td className="px-4 py-3 text-text2">{r.areaName ?? "—"}</td>
                  <td className="px-4 py-3 text-text2">
                    <bdi className="ltr-num">{r.floor ?? "—"}</bdi>
                  </td>
                  <td className="px-4 py-3 text-text2">{r.proposedTitle ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">
                    <bdi className="ltr-num">{r.isActive ? r.countOfRooms : "—"}</bdi>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <bdi className="ltr-num">{r.occ?.occ_adults ?? "—"}</bdi>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <bdi className="ltr-num">{r.occ?.occ_children ?? "—"}</bdi>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <bdi className="ltr-num">{r.occ?.occ_infants ?? "—"}</bdi>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <bdi className="ltr-num">{r.occ?.default_occupancy ?? "—"}</bdi>
                    {r.occ?.defaultOccupancyCapped && (
                      <span
                        className="chip chip-approval ms-1"
                        title={`ב-GuestHub ${r.occ.sourceDefaultOccupancy} — הוקטן ל-${r.occ.default_occupancy} כי Channex אוסר על ערך גדול ממספר מקומות המבוגרים. הנתון ב-GuestHub לא שונה.`}
                      >
                        הוקטן
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`chip ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-4 py-3 text-faint">
                    <bdi className="ltr-num font-mono">{r.channexRoomTypeId ?? "—"}</bdi>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <bdi className="ltr-num">{fmtDt(r.lastVerifiedAt)}</bdi>
                  </td>
                  <td className="t-label px-4 py-3 text-status-danger">{r.validationError ?? r.lastError ?? ""}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={14} className="px-4 py-6 text-center text-sm text-muted">
                  אין חדרים להצגה.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, danger }: { label: string; value: number; hint?: string; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-hover/40 p-4">
      <p className={`h3 ${danger ? "text-status-danger" : "text-ink"}`}>
        <bdi className="ltr-num">{value}</bdi>
      </p>
      <p className="t-label mt-0.5">{label}</p>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

const Dt = ({ children }: { children: React.ReactNode }) => <dt className="t-label text-faint">{children}</dt>;
const Dd = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <dd className={`t-secondary text-text2 ${className}`}>{children}</dd>
);
