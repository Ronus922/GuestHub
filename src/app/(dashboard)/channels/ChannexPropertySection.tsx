"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/shared/Icon";
import {
  getChannexPropertyContextAction,
  saveChannexPropertyProfileAction,
  listChannexPropertiesAction,
  createChannexPropertyAction,
  adoptChannexPropertyAction,
  refreshChannexPropertyAction,
  type ChannexPropertyContextView,
} from "@/lib/channel/admin";
import type { ChannexProfileOverrides } from "@/lib/channel/property-profile";

// Channex Staging PROPERTY mapping (D60) — super_admin only (page-gated). Maps
// the EXISTING GuestHub tenant to ONE Channex Staging property. Read-only room
// preview; the external property is created/adopted by the operator here. No
// local property/room is ever created from this screen.

const dtFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Jerusalem" });
const fmtDt = (v: string | null) => (v ? dtFmt.format(new Date(v)) : "—");

type Msg = { tone: "ok" | "err"; text: string } | null;
type AdoptItem = { id: string; title: string | null; currency: string | null };

const STATUS_LABEL: Record<string, string> = {
  available: "פעיל",
  inactive: "לא פעיל",
  out_of_order: "מושבת",
  maintenance: "אחזקה",
};

export function ChannexPropertySection({ initial }: { initial: ChannexPropertyContextView }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();
  const [editingProfile, setEditingProfile] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [adoptList, setAdoptList] = useState<AdoptItem[] | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptItem | null>(null);
  const [form, setForm] = useState<ChannexProfileOverrides>(initial.overrides ?? {});

  const canAct = view.secretsKeyConfigured && view.apiKeyConfigured;

  async function reload() {
    const res = await getChannexPropertyContextAction();
    if (res.success) setView(res.data!);
  }

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string, after?: () => void) {
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.success) return setMsg({ tone: "err", text: res.error ?? "אירעה שגיאה" });
      await reload();
      after?.();
      setMsg({ tone: "ok", text: okText });
    });
  }

  function onSaveProfile() {
    run(() => saveChannexPropertyProfileAction(form), "פרטי הפרופיל נשמרו", () => setEditingProfile(false));
  }

  function onCreate() {
    setConfirmCreate(false);
    run(() => createChannexPropertyAction(), "נכס Channex Staging נוצר");
  }

  function onCheckExisting() {
    setMsg(null);
    startTransition(async () => {
      const res = await listChannexPropertiesAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error ?? "אירעה שגיאה" });
      const props = res.data!.properties;
      setAdoptList(props);
      if (props.length === 0) setMsg({ tone: "ok", text: "לא נמצאו נכסים קיימים במפתח זה" });
    });
  }

  function onAdopt(item: AdoptItem) {
    setAdoptTarget(null);
    setAdoptList(null);
    run(() => adoptChannexPropertyAction({ propertyId: item.id }), "הנכס אומץ ומופה בהצלחה");
  }

  function onRefresh() {
    run(() => refreshChannexPropertyAction(), "סטטוס הנכס עודכן");
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name="building" size={20} className="text-primary" />
          <h2 className="text-lg font-bold text-ink">נכס Channex (Staging)</h2>
        </div>
        {view.mapping ? (
          <span className="flex items-center gap-1.5 rounded-full bg-status-success-050 px-3 py-1 text-xs font-bold text-status-success">
            <Icon name="check-circle" size={14} />
            ממופה
          </span>
        ) : (
          <span className="rounded-full bg-hover px-3 py-1 text-xs font-bold text-muted">לא ממופה</span>
        )}
      </div>

      {/* Scope note */}
      <div className="flex items-start gap-2.5 rounded-xl border border-line bg-primary-050 p-3">
        <Icon name="info" size={18} className="mt-0.5 shrink-0 text-primary" />
        <p className="text-xs font-semibold leading-relaxed text-text2">
          נכס ה-Channex הוא הייצוג החיצוני של העסק הקיים ב-GuestHub — <strong>לא</strong> נוצר נכס, בניין
          או חדר מקומי חדש. החדרים הקיימים ימופו לסוגי חדרים ב-Channex בשלב הבא ואינם מוקלדים מחדש.
        </p>
      </div>

      {!view.secretsKeyConfigured && (
        <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
          מפתח ההצפנה בשרת (CHANNEL_SECRETS_KEY) אינו מוגדר — פעולות נכס אינן זמינות.
        </p>
      )}
      {view.secretsKeyConfigured && !view.apiKeyConfigured && (
        <p className="rounded-lg bg-status-warning-050 px-3 py-2 text-xs font-semibold text-status-warning">
          יש לשמור מפתח API של Channex בכרטיס החיבור למעלה לפני יצירה או אימוץ של נכס.
        </p>
      )}

      {/* Existing GuestHub property summary */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="עסק (GuestHub)" value={view.tenant.name} />
        <Stat label="מטבע קנוני" value={view.tenant.currency} />
        <Stat label="חדרים" value={String(view.roomCount)} />
        <Stat label="חדרים פעילים" value={String(view.activeRoomCount)} />
      </div>

      {view.mapping ? (
        <MappedCard view={view} onRefresh={onRefresh} pending={pending} />
      ) : (
        <Readiness view={view} />
      )}

      {/* Profile editor */}
      <div className="rounded-xl border border-line">
        <button
          type="button"
          onClick={() => setEditingProfile((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-bold text-ink"
        >
          <span className="flex items-center gap-2">
            <Icon name="edit" size={16} className="text-muted" />
            פרטי פרופיל האינטגרציה
          </span>
          <Icon name={editingProfile ? "arrow-up" : "arrow-down"} size={16} className="text-faint" />
        </button>
        {editingProfile && (
          <div className="flex flex-col gap-3 border-t border-line p-4">
            <p className="text-xs font-semibold text-muted">
              ערכים קנוניים (מטבע: {view.tenant.currency} · אזור זמן: {view.profile.timezone}) נקראים מ-GuestHub
              ואינם ניתנים לעריכה כאן. השדות הבאים משלימים פרטים הנדרשים לפני חיבור ערוצים חיים.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="שם חיצוני (Title)" v={form.title} onChange={(x) => setForm({ ...form, title: x })} ph={view.profile.title} />
              <Field label="סוג נכס" v={form.propertyType} onChange={(x) => setForm({ ...form, propertyType: x })} ph="apartment" />
              <Field label="מדינה (ISO-2)" v={form.country} onChange={(x) => setForm({ ...form, country: x })} ph="IL" ltr />
              <Field label="עיר" v={form.city} onChange={(x) => setForm({ ...form, city: x })} />
              <Field label="כתובת" v={form.address} onChange={(x) => setForm({ ...form, address: x })} />
              <Field label="מיקוד" v={form.zipCode} onChange={(x) => setForm({ ...form, zipCode: x })} ltr />
              <Field label="אימייל" v={form.email} onChange={(x) => setForm({ ...form, email: x })} ltr />
              <Field label="טלפון" v={form.phone} onChange={(x) => setForm({ ...form, phone: x })} ltr />
              <Field label="אתר" v={form.website} onChange={(x) => setForm({ ...form, website: x })} ltr />
              <Field label="קו רוחב" v={numStr(form.latitude)} onChange={(x) => setForm({ ...form, latitude: toNum(x) })} ltr />
              <Field label="קו אורך" v={numStr(form.longitude)} onChange={(x) => setForm({ ...form, longitude: toNum(x) })} ltr />
            </div>
            <div>
              <button
                type="button"
                onClick={onSaveProfile}
                disabled={pending || !view.secretsKeyConfigured}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                שמור פרטי פרופיל
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Rooms preview (read-only) */}
      <RoomsPreview view={view} />

      {/* Actions (only when not yet mapped) */}
      {!view.mapping && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirmCreate(true)}
            disabled={!canAct || pending || !view.readiness.canCreate}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            <Icon name="plus" size={16} />
            יצירת נכס Channex Staging
          </button>
          <button
            type="button"
            onClick={onCheckExisting}
            disabled={!canAct || pending}
            className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-bold text-ink hover:bg-hover disabled:opacity-50"
          >
            <Icon name="search" size={16} />
            בדוק נכסים קיימים לאימוץ
          </button>
        </div>
      )}

      {msg && (
        <p className={`text-sm font-semibold ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}>
          {msg.text}
        </p>
      )}

      {/* Adoption list */}
      {adoptList && adoptList.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-status-warning bg-status-warning-050 p-4">
          <p className="text-sm font-bold text-status-warning">נמצאו נכסים קיימים במפתח — בחר לאימוץ מפורש:</p>
          {adoptList.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">{p.title ?? "(ללא שם)"}</p>
                <p className="truncate font-mono text-xs text-faint">{p.id} · {p.currency ?? "—"}</p>
              </div>
              <button
                type="button"
                onClick={() => setAdoptTarget(p)}
                disabled={pending}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-ink hover:bg-hover disabled:opacity-50"
              >
                אימוץ נכס זה
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Create confirmation modal */}
      {confirmCreate && (
        <ConfirmDialog title="יצירת נכס Channex Staging" onClose={() => setConfirmCreate(false)}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <Dt>עסק GuestHub</Dt><Dd>{view.tenant.name}</Dd>
            <Dt>שם חיצוני</Dt><Dd>{view.profile.title}</Dd>
            <Dt>סביבה</Dt><Dd>Staging</Dd>
            <Dt>מטבע</Dt><Dd>{view.profile.currency}</Dd>
            <Dt>מדינה / עיר</Dt><Dd>{view.profile.country ?? "—"} / {view.profile.city ?? "—"}</Dd>
            <Dt>חדרים קיימים</Dt><Dd>{view.roomCount}</Dd>
          </dl>
          <ul className="flex flex-col gap-1.5 text-xs font-semibold text-status-warning">
            <li>• החדרים אינם נוצרים מחדש — רק סוגי חדרים ימופו בשלב הבא.</li>
            <li>• סוגי חדרים ותוכניות תעריף ייווצרו בשלב עתידי (Phase 4C).</li>
            <li>• לא נוצר חיבור חי ל-Booking.com או ל-Expedia.</li>
          </ul>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmCreate(false)} className="rounded-xl border border-line px-4 py-2 text-sm font-bold text-ink hover:bg-hover">
              ביטול
            </button>
            <button type="button" onClick={onCreate} disabled={pending} className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              צור נכס Channex Staging
            </button>
          </div>
        </ConfirmDialog>
      )}

      {/* Adopt confirmation modal */}
      {adoptTarget && (
        <ConfirmDialog title="אימוץ נכס Channex קיים" onClose={() => setAdoptTarget(null)}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <Dt>שם הנכס</Dt><Dd>{adoptTarget.title ?? "(ללא שם)"}</Dd>
            <Dt>מזהה Channex</Dt><Dd className="font-mono text-xs">{adoptTarget.id}</Dd>
            <Dt>מטבע</Dt><Dd>{adoptTarget.currency ?? "—"}</Dd>
            <Dt>סביבה</Dt><Dd>Staging</Dd>
          </dl>
          <p className="text-xs font-semibold text-muted">האימוץ יקשר את העסק הקיים לנכס זה. לא נוצר נכס חדש.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAdoptTarget(null)} className="rounded-xl border border-line px-4 py-2 text-sm font-bold text-ink hover:bg-hover">
              ביטול
            </button>
            <button type="button" onClick={() => onAdopt(adoptTarget)} disabled={pending} className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              אמץ נכס זה
            </button>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-hover/40 p-3">
      <p className="truncate text-base font-extrabold text-ink" title={value}>{value}</p>
      <p className="mt-0.5 text-xs font-medium text-muted">{label}</p>
    </div>
  );
}

function Readiness({ view }: { view: ChannexPropertyContextView }) {
  const { readiness } = view;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ChecklistCard title="נדרש ליצירת הנכס" items={readiness.createItems} tone={readiness.canCreate ? "ok" : "warn"} />
      <ChecklistCard title="נדרש לפני חיבור ערוצים חיים" items={readiness.liveItems} tone={readiness.liveReady ? "ok" : "warn"} />
    </div>
  );
}

function ChecklistCard({ title, items, tone }: { title: string; items: { key: string; label: string; present: boolean }[]; tone: "ok" | "warn" }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
      <div className="flex items-center gap-2">
        <Icon name={tone === "ok" ? "shield-check" : "warning"} size={16} className={tone === "ok" ? "text-status-success" : "text-status-warning"} />
        <p className="text-sm font-bold text-ink">{title}</p>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 text-xs font-semibold">
            <Icon name={i.present ? "check" : "close"} size={13} className={i.present ? "text-status-success" : "text-faint"} />
            <span className={i.present ? "text-text2" : "text-faint"}>{i.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MappedCard({ view, onRefresh, pending }: { view: ChannexPropertyContextView; onRefresh: () => void; pending: boolean }) {
  const m = view.mapping!;
  const snap = (m.snapshot ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof snap[k] === "string" ? (snap[k] as string) : "—");
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-status-success bg-status-success-050/40 p-4">
      {m.reconcileState === "inaccessible" && (
        <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-bold text-status-danger">
          הנכס הממופה אינו נגיש למפתח הנוכחי — נדרשת התאמה מחדש. המיפוי נשמר ולא נמחק.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm lg:grid-cols-3">
        <Dt>עסק GuestHub</Dt><Dd>{view.tenant.name}</Dd>
        <Dt>שם הנכס</Dt><Dd>{m.title ?? "—"}</Dd>
        <Dt>מזהה Channex</Dt><Dd className="font-mono text-xs">{m.propertyId}</Dd>
        <Dt>אופן</Dt><Dd>{m.method === "created" ? "נוצר" : m.method === "adopted" ? "אומץ" : "—"}</Dd>
        <Dt>סביבה</Dt><Dd>Staging</Dd>
        <Dt>מטבע</Dt><Dd>{str("currency")}</Dd>
        <Dt>מדינה / עיר</Dt><Dd>{str("country")} / {str("city")}</Dd>
        <Dt>אזור זמן</Dt><Dd>{str("timezone")}</Dd>
        <Dt>סוג נכס</Dt><Dd>{str("property_type")}</Dd>
        <Dt>חדרים ב-GuestHub</Dt><Dd>{view.roomCount}</Dd>
        <Dt>סוגי חדרים ב-Channex</Dt><Dd>{typeof snap.room_type_count === "number" ? String(snap.room_type_count) : "0"}</Dd>
        <Dt>אומת לאחרונה</Dt><Dd>{fmtDt(m.verifiedAt)}</Dd>
      </dl>
      <p className="text-xs font-semibold text-muted">השלב הבא: סנכרון סוגי החדרים הקיימים של GuestHub אל Channex.</p>
      <div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={pending}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-bold text-ink hover:bg-hover disabled:opacity-50"
        >
          <Icon name="refresh" size={16} />
          רענון סטטוס הנכס
        </button>
      </div>
    </div>
  );
}

function RoomsPreview({ view }: { view: ChannexPropertyContextView }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon name="list" size={16} className="text-muted" />
        <h3 className="text-sm font-bold text-ink">תצוגת חדרים קיימים (לקריאה בלבד)</h3>
        <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-bold text-muted">{view.rooms.length}</span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-line bg-hover/40 text-right text-xs font-bold text-faint">
              <th className="px-4 py-3">חדר</th>
              <th className="px-4 py-3">בניין/אזור</th>
              <th className="px-4 py-3">קומה</th>
              <th className="px-4 py-3">סוג חדר</th>
              <th className="px-4 py-3">סטטוס</th>
              <th className="px-4 py-3">תפוסה (מ׳–מקס)</th>
              <th className="px-4 py-3">מבוגרים/ילדים/תינוקות</th>
            </tr>
          </thead>
          <tbody>
            {view.rooms.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-bold text-ink">{r.room_number}</td>
                <td className="px-4 py-3 text-text2">{r.area_name ?? "—"}</td>
                <td className="px-4 py-3 text-text2">{r.floor ?? "—"}</td>
                <td className="px-4 py-3 text-text2">{r.room_type_name ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${r.is_active && r.status === "available" ? "bg-status-success-050 text-status-success" : "bg-hover text-muted"}`}>
                    {r.is_active ? STATUS_LABEL[r.status] ?? r.status : "לא פעיל"}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted">{r.min_occupancy ?? "—"}–{r.max_occupancy}</td>
                <td className="px-4 py-3 text-muted">{r.max_adults}/{r.max_children}/{r.max_infants}</td>
              </tr>
            ))}
            {view.rooms.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-sm text-muted">אין חדרים להצגה.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConfirmDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" dir="rtl" onClick={onClose}>
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold text-ink">{title}</h3>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-hover" aria-label="סגור">
            <Icon name="close" size={18} className="text-muted" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, v, onChange, ph, ltr }: { label: string; v: string | null | undefined; onChange: (v: string) => void; ph?: string; ltr?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-semibold text-text2">{label}</span>
      <input
        type="text"
        value={v ?? ""}
        placeholder={ph}
        onChange={(e) => onChange(e.target.value)}
        dir={ltr ? "ltr" : undefined}
        className="bw-fld"
      />
    </label>
  );
}

const Dt = ({ children }: { children: React.ReactNode }) => <dt className="text-faint">{children}</dt>;
const Dd = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <dd className={`truncate font-semibold text-text2 ${className}`}>{children}</dd>
);

function numStr(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : String(n);
}
function toNum(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
