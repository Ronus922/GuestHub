"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/shared/Icon";
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

const STATUS_META: Record<RowStatus, { label: string; cls: string }> = {
  ready: { label: "מוכן", cls: "bg-primary-050 text-primary" },
  validation_required: { label: "נדרש תיקון נתונים", cls: "bg-status-warning-050 text-status-warning" },
  excluded_inactive: { label: "לא פעיל — לא יסונכרן", cls: "bg-hover text-muted" },
  creating: { label: "ביצירה", cls: "bg-status-warning-050 text-status-warning" },
  mapped: { label: "ממופה", cls: "bg-status-success-050 text-status-success" },
  adopted: { label: "אומץ", cls: "bg-status-success-050 text-status-success" },
  inaccessible: { label: "לא נגיש", cls: "bg-status-danger-050 text-status-danger" },
  failed: { label: "נכשל", cls: "bg-status-danger-050 text-status-danger" },
  reconciliation_required: { label: "נדרשת התאמה מחדש", cls: "bg-status-danger-050 text-status-danger" },
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
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name="rooms" size={20} className="text-primary" />
          <h2 className="text-lg font-bold text-ink">סנכרון חדרים פיזיים ל־Channex</h2>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            s.activeRooms > 0 && s.mappedRooms === s.activeRooms
              ? "bg-status-success-050 text-status-success"
              : "bg-hover text-muted"
          }`}
        >
          {s.mappedRooms}/{s.activeRooms} ממופים
        </span>
      </div>

      {/* Model note — the inventory unit, and what count_of_rooms does NOT mean */}
      <div className="flex items-start gap-2.5 rounded-xl border border-line bg-primary-050 p-3">
        <Icon name="info" size={18} className="mt-0.5 shrink-0 text-primary" />
        <p className="text-xs font-semibold leading-relaxed text-text2">
          יחידת המיפוי ל-Channex היא <strong>החדר הפיזי</strong>: כל חדר הופך לסוג חדר אחד ב-Channex עם{" "}
          <strong>יחידה פיזית אחת</strong>. שלוש קטגוריות החדרים ב-GuestHub נשארות תיאוריות בלבד ואינן
          נרשמות כמלאי ב-Channex. כל סוג חדר מכיל יחידה פיזית אחת —{" "}
          <strong>הזמינות היומית תישאר סגורה עד לשלב סנכרון ה-ARI</strong>.
        </p>
      </div>

      {!view.connected && (
        <p className="rounded-lg bg-status-warning-050 px-3 py-2 text-xs font-semibold text-status-warning">
          לא קיים חיבור Channex.
        </p>
      )}
      {view.connected && !propertyId && (
        <p className="rounded-lg bg-status-warning-050 px-3 py-2 text-xs font-semibold text-status-warning">
          לא קיים נכס Channex ממופה — יש למפות נכס בכרטיס שלמעלה לפני סנכרון חדרים.
        </p>
      )}
      {view.connected && !view.apiKeyConfigured && (
        <p className="rounded-lg bg-status-warning-050 px-3 py-2 text-xs font-semibold text-status-warning">
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
        <div className="rounded-xl border border-line bg-hover/40 p-3">
          <p className="text-base font-extrabold text-ink">טרם סונכרנה</p>
          <p className="mt-0.5 text-xs font-medium text-muted">זמינות נוכחית ב-Channex</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onOpenPreview}
          disabled={!canAct || busy || s.validReady === 0 || view.running}
          className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          <Icon name="plus" size={16} />
          {resumeMode ? `המשך סנכרון (${s.validReady} חדרים)` : `יצירת ${s.validReady} חדרים ב־Channex Staging`}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!canAct || busy}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-bold text-ink hover:bg-hover disabled:opacity-50"
        >
          <Icon name="refresh" size={16} />
          רענון מצב החדרים מ־Channex
        </button>
        {view.running && (
          <span className="rounded-full bg-status-warning-050 px-3 py-1 text-xs font-bold text-status-warning">
            סנכרון פועל כעת
          </span>
        )}
      </div>

      {msg && (
        <p className={`text-sm font-semibold ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}>
          {msg.text}
        </p>
      )}

      {/* External Room Types with no local mapping — explicit adoption only */}
      {plan.externalUnmapped.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-status-warning bg-status-warning-050 p-4">
          <p className="text-sm font-bold text-status-warning">
            סוגי חדרים קיימים ב-Channex ללא מיפוי מקומי — אימוץ מפורש בלבד (אין אימוץ אוטומטי לפי שם):
          </p>
          {plan.externalUnmapped.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">{e.title ?? "(ללא שם)"}</p>
                <p className="truncate font-mono text-xs text-faint">
                  {e.id} · יחידות: {e.countOfRooms ?? "—"} · {e.occAdults ?? "—"}/{e.occChildren ?? "—"}/
                  {e.occInfants ?? "—"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAdoptTarget({ externalId: e.id, title: e.title })}
                disabled={busy}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-ink hover:bg-hover disabled:opacity-50"
              >
                אימוץ לחדר פיזי
              </button>
            </div>
          ))}
        </div>
      )}

      <PreviewTable rows={plan.rows} />

      {preview && (
        <ConfirmDialog title="יצירת סוגי חדרים ב־Channex Staging" onClose={() => setPreview(null)}>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm">
            <Dt>סביבה</Dt>
            <Dd className="col-span-2">Staging</Dd>
            <Dt>נכס Channex</Dt>
            <Dd className="col-span-2">{preview.propertyTitle ?? "—"}</Dd>
            <Dt>מזהה נכס</Dt>
            <Dd className="col-span-2 font-mono text-xs">{preview.propertyId}</Dd>
            <Dt>חדרים פיזיים</Dt>
            <Dd className="col-span-2">{preview.activeRooms}</Dd>
            <Dt>כבר ממופים</Dt>
            <Dd className="col-span-2">{preview.alreadyMapped}</Dd>
            <Dt>ייווצרו כעת</Dt>
            <Dd className="col-span-2 font-bold text-ink">{preview.toCreate}</Dd>
            <Dt>מבנה השם</Dt>
            <Dd className="col-span-2 font-mono text-xs">חדר &lt;מספר&gt; - &lt;סוג חדר&gt;</Dd>
            <Dt>יחידות פיזיות</Dt>
            <Dd className="col-span-2">{preview.countOfRooms} לכל סוג חדר</Dd>
          </dl>

          <div className="max-h-40 overflow-y-auto rounded-lg border border-line p-3">
            <p className="mb-1 text-xs font-bold text-ink">שמות שייווצרו ({preview.titles.length})</p>
            <ul className="flex flex-col gap-0.5 text-xs font-semibold text-text2">
              {preview.titles.map((t) => (
                <li key={t.roomNumber}>{t.title}</li>
              ))}
            </ul>
          </div>

          <ul className="flex flex-col gap-1 text-xs font-semibold text-status-warning">
            <li>• הזמינות היומית תישאר 0 — לא מסונכרנת בשלב זה.</li>
            <li>• לא ייווצרו תוכניות תעריף (Rate Plans) ולא ייכתבו מחירים.</li>
            <li>• לא ייווצר חיבור ל-Booking.com או ל-Expedia.</li>
            <li>• חדרי GuestHub, קטגוריות ונתוני תפוסה אינם משתנים.</li>
          </ul>

          {preview.blockedReason && (
            <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-bold text-status-danger">
              {preview.blockedReason}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="rounded-xl border border-line px-4 py-2 text-sm font-bold text-ink hover:bg-hover"
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={onConfirmSync}
              disabled={busy || !!preview.blockedReason || preview.toCreate === 0}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              {submitting ? "מסנכרן…" : "צור את החדרים הקיימים ב־Channex"}
            </button>
          </div>
        </ConfirmDialog>
      )}

      {adoptTarget && (
        <ConfirmDialog title="אימוץ סוג חדר קיים ב־Channex" onClose={() => setAdoptTarget(null)}>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm">
            <Dt>שם ב-Channex</Dt>
            <Dd className="col-span-2">{adoptTarget.title ?? "(ללא שם)"}</Dd>
            <Dt>מזהה Channex</Dt>
            <Dd className="col-span-2 font-mono text-xs">{adoptTarget.externalId}</Dd>
          </dl>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-bold text-ink">חדר פיזי לשיוך</span>
            <select
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
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
          <p className="text-xs font-semibold text-muted">
            סוג החדר יאומת מול Channex לפני האימוץ. סוג חדר חיצוני אחד יכול להיות משויך לחדר פיזי אחד בלבד.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdoptTarget(null)}
              className="rounded-xl border border-line px-4 py-2 text-sm font-bold text-ink hover:bg-hover"
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={onAdopt}
              disabled={busy || !adoptRoomId}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            >
              אמץ סוג חדר זה
            </button>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon name="list" size={16} className="text-muted" />
        <h3 className="text-sm font-bold text-ink">תצוגה מקדימה — חדר פיזי אחד לכל סוג חדר (לקריאה בלבד)</h3>
        <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-bold text-muted">{rows.length}</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[1080px] text-sm">
          <thead>
            <tr className="border-b border-line bg-hover/40 text-right text-xs font-bold text-faint">
              <th className="px-4 py-3">חדר</th>
              <th className="px-4 py-3">קטגוריה</th>
              <th className="px-4 py-3">בניין/אזור</th>
              <th className="px-4 py-3">קומה</th>
              <th className="px-4 py-3">שם מוצע ב-Channex</th>
              <th className="px-4 py-3">יחידות פיזיות</th>
              <th className="px-4 py-3">מבוגרים</th>
              <th className="px-4 py-3">ילדים</th>
              <th className="px-4 py-3">תינוקות</th>
              <th className="px-4 py-3">ברירת מחדל</th>
              <th className="px-4 py-3">סטטוס</th>
              <th className="px-4 py-3">מזהה Channex</th>
              <th className="px-4 py-3">אומת</th>
              <th className="px-4 py-3">הערה</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const meta = STATUS_META[r.status];
              return (
                <tr key={r.roomId} className={`border-b border-line last:border-0 ${r.isActive ? "" : "opacity-60"}`}>
                  <td className="px-4 py-3 font-bold text-ink">{r.roomNumber}</td>
                  <td className="px-4 py-3 text-text2">{r.roomTypeName ?? "—"}</td>
                  <td className="px-4 py-3 text-text2">{r.areaName ?? "—"}</td>
                  <td className="px-4 py-3 text-text2">{r.floor ?? "—"}</td>
                  <td className="px-4 py-3 font-semibold text-text2">{r.proposedTitle ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{r.isActive ? r.countOfRooms : "—"}</td>
                  <td className="px-4 py-3 text-muted">{r.occ?.occ_adults ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{r.occ?.occ_children ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{r.occ?.occ_infants ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">
                    {r.occ?.default_occupancy ?? "—"}
                    {r.occ?.defaultOccupancyCapped && (
                      <span
                        className="mr-1 rounded-full bg-status-warning-050 px-1.5 py-0.5 text-[10px] font-bold text-status-warning"
                        title={`ב-GuestHub ${r.occ.sourceDefaultOccupancy} — הוקטן ל-${r.occ.default_occupancy} כי Channex אוסר על ערך גדול ממספר מקומות המבוגרים. הנתון ב-GuestHub לא שונה.`}
                      >
                        הוקטן
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-faint">{r.channexRoomTypeId ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{fmtDt(r.lastVerifiedAt)}</td>
                  <td className="px-4 py-3 text-xs text-status-danger">{r.validationError ?? r.lastError ?? ""}</td>
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
    <div className="rounded-xl border border-line bg-hover/40 p-3">
      <p className={`text-xl font-extrabold ${danger ? "text-status-danger" : "text-ink"}`}>{value}</p>
      <p className="mt-0.5 text-xs font-medium text-muted">{label}</p>
      {hint && <p className="text-[10px] font-medium text-faint">{hint}</p>}
    </div>
  );
}

function ConfirmDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" dir="rtl" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold text-ink">{title}</h3>
          <button type="button" onClick={onClose} className="grid h-11 w-11 place-items-center rounded-lg hover:bg-hover" aria-label="סגור">
            <Icon name="close" size={18} className="text-muted" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const Dt = ({ children }: { children: React.ReactNode }) => <dt className="text-faint">{children}</dt>;
const Dd = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <dd className={`font-semibold text-text2 ${className}`}>{children}</dd>
);
