"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Icon } from "@/components/shared/Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  getChannexPropertyContextAction,
  listChannexPropertiesAction,
  createChannexPropertyAction,
  adoptChannexPropertyAction,
  refreshChannexPropertyAction,
  previewChannexUpdateAction,
  updateChannexPropertyFromBusinessProfileAction,
  type ChannexPropertyContextView,
  type ChannexUpdatePreview,
} from "@/lib/channel/admin";

// Channex Staging PROPERTY mapping. Maps the EXISTING GuestHub tenant to ONE
// Channex Staging property. Business/property IDENTITY is read-only here and
// edited in /settings → פרופיל העסק (the source of truth). The mapped property
// is CORRECTED via PUT from the canonical Business Profile — never recreated.
// super_admin only (page-gated). No local property/room is created here.

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

const BUSINESS_PROFILE_HREF = "/settings?section=business";

export function ChannexPropertySection({ initial }: { initial: ChannexPropertyContextView }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, startTransition] = useTransition();
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [adoptList, setAdoptList] = useState<AdoptItem[] | null>(null);
  const [adoptTarget, setAdoptTarget] = useState<AdoptItem | null>(null);
  const [updatePreview, setUpdatePreview] = useState<ChannexUpdatePreview | null>(null);

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

  function onOpenUpdate() {
    setMsg(null);
    startTransition(async () => {
      const res = await previewChannexUpdateAction();
      if (!res.success) return setMsg({ tone: "err", text: res.error ?? "אירעה שגיאה" });
      setUpdatePreview(res.data!);
    });
  }

  function onConfirmUpdate() {
    setUpdatePreview(null);
    run(() => updateChannexPropertyFromBusinessProfileAction(), "פרטי הנכס עודכנו ב-Channex");
  }

  return (
    <section className="card">
      <div className="card-hd justify-between">
        <div className="flex items-center gap-2">
          <Icon name="building" size={20} className="text-primary" />
          <span className="h4">נכס Channex (Staging)</span>
        </div>
        {view.mapping ? (
          <span className="chip chip-paid">
            <Icon name="check-circle" size={13.5} />
            ממופה
          </span>
        ) : (
          <span className="chip chip-neutral">לא ממופה</span>
        )}
      </div>

      <div className="card-bd flex flex-col gap-4">
        {/* Scope note */}
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-primary-050 p-3">
          <Icon name="info" size={17} className="mt-0.5 shrink-0 text-primary" />
          <p className="t-label leading-relaxed text-text2">
            נכס ה-Channex הוא הייצוג החיצוני של העסק הקיים ב-GuestHub — <strong>לא</strong> נוצר נכס, בניין
            או חדר מקומי חדש. זהות העסק והנכס נערכת ב<Link href={BUSINESS_PROFILE_HREF} className="underline">פרופיל העסק</Link> ומוזנת לכאן.
          </p>
        </div>

        {!view.secretsKeyConfigured && (
          <p className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
            מפתח ההצפנה בשרת (CHANNEL_SECRETS_KEY) אינו מוגדר — פעולות נכס אינן זמינות.
          </p>
        )}
        {view.secretsKeyConfigured && !view.apiKeyConfigured && (
          <p className="t-label rounded-lg bg-status-warning-050 px-3 py-2 text-status-warning">
            יש לשמור מפתח API של Channex בכרטיס החיבור למעלה לפני יצירה, אימוץ או עדכון של נכס.
          </p>
        )}

        {/* Canonical business/property identity (read-only; edited in settings) */}
        <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
            <Dt>עסק</Dt><Dd>{view.business.businessName ?? "לא הוגדר"}</Dd>
            <Dt>נכס</Dt><Dd>{view.business.propertyName ?? "לא הוגדר"}</Dd>
          </dl>
          {!view.business.hasPropertyName && (
            <p className="t-label rounded-lg bg-status-warning-050 px-3 py-2 text-status-warning">
              פרופיל העסק אינו מלא. יש להשלים את פרטי העסק לפני חיבור Booking.com או Expedia.
            </p>
          )}
          <Link href={BUSINESS_PROFILE_HREF} className="t-label flex w-fit items-center gap-1.5 text-primary underline">
            <Icon name="edit" size={13.5} />
            מעבר לפרופיל העסק
          </Link>
        </div>

        {/* Read-only summary stats */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="מטבע קנוני" value={view.tenant.currency} />
          <Stat label="חדרים" value={String(view.roomCount)} />
          <Stat label="חדרים פעילים" value={String(view.activeRoomCount)} />
          <Stat label="סוגי חדרים" value={String(view.roomTypeCount)} />
        </div>

        {view.mapping ? (
          <MappedCard
            view={view}
            onRefresh={onRefresh}
            onUpdate={onOpenUpdate}
            canAct={canAct}
            pending={pending}
          />
        ) : (
          <Readiness view={view} />
        )}

        {/* Rooms preview (read-only) */}
        <RoomsPreview view={view} />

        {/* Actions (only when not yet mapped) */}
        {!view.mapping && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setConfirmCreate(true)}
              disabled={!canAct || pending || !view.readiness.canCreate}
              className="btn btn-primary"
            >
              <Icon name="plus" size={20} />
              יצירת נכס Channex Staging
            </button>
            <button
              type="button"
              onClick={onCheckExisting}
              disabled={!canAct || pending}
              className="btn btn-secondary"
            >
              <Icon name="search" size={20} />
              בדוק נכסים קיימים לאימוץ
            </button>
          </div>
        )}

        {msg && (
          <p className={`t-secondary ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}>
            {msg.text}
          </p>
        )}

        {/* Adoption list */}
        {adoptList && adoptList.length > 0 && (
          <div className="flex flex-col gap-2 rounded-xl border border-status-warning bg-status-warning-050 p-4">
            <p className="t-secondary text-status-warning">נמצאו נכסים קיימים במפתח — בחר לאימוץ מפורש:</p>
            {adoptList.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2">
                <div className="min-w-0">
                  <p className="t-secondary truncate text-ink">{p.title ?? "(ללא שם)"}</p>
                  <p className="t-label truncate text-faint">
                    <bdi className="ltr-num font-mono">{p.id}</bdi> · {p.currency ?? "—"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAdoptTarget(p)}
                  disabled={pending}
                  className="btn btn-sm btn-secondary"
                >
                  אימוץ נכס זה
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create confirmation modal */}
      {confirmCreate && (
        <ConfirmDialog
          title="יצירת נכס Channex Staging"
          onClose={() => setConfirmCreate(false)}
          footer={
            <>
              <button type="button" onClick={onCreate} disabled={pending} className="btn btn-primary">
                צור נכס Channex Staging
              </button>
              <button type="button" onClick={() => setConfirmCreate(false)} className="btn btn-secondary">
                ביטול
              </button>
            </>
          }
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <Dt>נכס</Dt><Dd>{view.business.propertyName ?? "לא הוגדר"}</Dd>
            <Dt>סביבה</Dt><Dd>Staging</Dd>
            <Dt>מטבע</Dt><Dd>{view.tenant.currency}</Dd>
            <Dt>חדרים קיימים</Dt><Dd>{view.roomCount}</Dd>
          </dl>
          <ul className="t-label flex flex-col gap-1.5 text-status-warning">
            <li>• החדרים אינם נוצרים מחדש — רק סוגי חדרים ימופו בשלב הבא.</li>
            <li>• סוגי חדרים ותוכניות תעריף ייווצרו בשלב עתידי.</li>
            <li>• לא נוצר חיבור חי ל-Booking.com או ל-Expedia.</li>
          </ul>
        </ConfirmDialog>
      )}

      {/* Adopt confirmation modal */}
      {adoptTarget && (
        <ConfirmDialog
          title="אימוץ נכס Channex קיים"
          onClose={() => setAdoptTarget(null)}
          footer={
            <>
              <button type="button" onClick={() => onAdopt(adoptTarget)} disabled={pending} className="btn btn-primary">
                אמץ נכס זה
              </button>
              <button type="button" onClick={() => setAdoptTarget(null)} className="btn btn-secondary">
                ביטול
              </button>
            </>
          }
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <Dt>שם הנכס</Dt><Dd>{adoptTarget.title ?? "(ללא שם)"}</Dd>
            <Dt>מזהה Channex</Dt><Dd><bdi className="ltr-num font-mono">{adoptTarget.id}</bdi></Dd>
            <Dt>מטבע</Dt><Dd>{adoptTarget.currency ?? "—"}</Dd>
            <Dt>סביבה</Dt><Dd>Staging</Dd>
          </dl>
          <p className="t-label">האימוץ יקשר את העסק הקיים לנכס זה. לא נוצר נכס חדש.</p>
        </ConfirmDialog>
      )}

      {/* Channex update (PUT) confirmation modal */}
      {updatePreview && (
        <UpdateDialog
          preview={updatePreview}
          roomCount={view.roomCount}
          pending={pending}
          onClose={() => setUpdatePreview(null)}
          onConfirm={onConfirmUpdate}
        />
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-hover/40 p-4">
      <p className="h4 truncate" title={value}>
        <bdi className="ltr-num">{value}</bdi>
      </p>
      <p className="t-label mt-0.5">{label}</p>
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
        <Icon name={tone === "ok" ? "shield-check" : "warning"} size={17} className={tone === "ok" ? "text-status-success" : "text-status-warning"} />
        <p className="t-secondary text-ink">{title}</p>
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.key} className="t-label flex items-center gap-2">
            <Icon name={i.present ? "check" : "close"} size={13.5} className={i.present ? "text-status-success" : "text-faint"} />
            <span className={i.present ? "text-text2" : "text-faint"}>{i.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MappedCard({
  view,
  onRefresh,
  onUpdate,
  canAct,
  pending,
}: {
  view: ChannexPropertyContextView;
  onRefresh: () => void;
  onUpdate: () => void;
  canAct: boolean;
  pending: boolean;
}) {
  const m = view.mapping!;
  const snap = (m.snapshot ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof snap[k] === "string" ? (snap[k] as string) : "—");
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-status-success bg-status-success-050/40 p-4">
      {m.reconcileState === "inaccessible" && (
        <p className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
          הנכס הממופה אינו נגיש למפתח הנוכחי — נדרשת התאמה מחדש. המיפוי נשמר ולא נמחק.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 lg:grid-cols-3">
        <Dt>עסק</Dt><Dd>{view.business.businessName ?? "לא הוגדר"}</Dd>
        <Dt>נכס</Dt><Dd>{view.business.propertyName ?? "לא הוגדר"}</Dd>
        <Dt>שם Channex</Dt><Dd>{m.title ?? "—"}</Dd>
        <Dt>מזהה Channex</Dt><Dd><bdi className="ltr-num font-mono">{m.propertyId}</bdi></Dd>
        <Dt>אופן</Dt><Dd>{m.method === "created" ? "נוצר" : m.method === "adopted" ? "אומץ" : "—"}</Dd>
        <Dt>סביבה</Dt><Dd>Staging</Dd>
        <Dt>מטבע</Dt><Dd>{str("currency")}</Dd>
        <Dt>מדינה / עיר</Dt><Dd>{str("country")} / {str("city")}</Dd>
        <Dt>כתובת</Dt><Dd>{str("address")}</Dd>
        <Dt>אזור זמן</Dt><Dd>{str("timezone")}</Dd>
        <Dt>סוג נכס</Dt><Dd>{str("property_type")}</Dd>
        <Dt>חדרים ב-GuestHub</Dt><Dd><bdi className="ltr-num">{view.roomCount}</bdi></Dd>
        <Dt>סוגי חדרים ב-Channex</Dt>
        <Dd>
          <bdi className="ltr-num">{typeof snap.room_type_count === "number" ? String(snap.room_type_count) : "0"}</bdi>
        </Dd>
        <Dt>אומת לאחרונה</Dt><Dd><bdi className="ltr-num">{fmtDt(m.verifiedAt)}</bdi></Dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onUpdate}
          disabled={pending || !canAct || !view.business.hasPropertyName}
          title={!view.business.hasPropertyName ? "יש להזין שם נכס בפרופיל העסק" : undefined}
          className="btn btn-primary"
        >
          <Icon name="refresh" size={20} />
          עדכון פרטי הנכס ב־Channex
        </button>
        <button type="button" onClick={onRefresh} disabled={pending} className="btn btn-secondary">
          <Icon name="refresh" size={20} />
          רענון סטטוס הנכס
        </button>
      </div>
    </div>
  );
}

function UpdateDialog({
  preview,
  roomCount,
  pending,
  onClose,
  onConfirm,
}: {
  preview: ChannexUpdatePreview;
  roomCount: number;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title="עדכון פרטי הנכס ב־Channex"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || !preview.canUpdate}
            title={preview.reason ?? undefined}
            className="btn btn-primary"
          >
            עדכון הנכס הקיים ב־Channex
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary">
            ביטול
          </button>
        </>
      }
    >
      <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5">
        <Dt>מזהה Channex</Dt>
        <Dd className="col-span-2"><bdi className="ltr-num font-mono">{preview.propertyId}</bdi></Dd>
        <Dt>סביבה</Dt><Dd className="col-span-2">Staging</Dd>
        <Dt>שם נוכחי</Dt><Dd className="col-span-2">{preview.currentTitle ?? "—"}</Dd>
        <Dt>שם חדש</Dt><Dd className="col-span-2 text-ink">{preview.proposedTitle ?? "—"}</Dd>
        <Dt>מדינה/עיר נוכחי</Dt><Dd className="col-span-2">{preview.currentCountry ?? "—"} / {preview.currentCity ?? "—"}</Dd>
        <Dt>מדינה/עיר חדש</Dt><Dd className="col-span-2">{preview.proposedCountry ?? "—"} / {preview.proposedCity ?? "—"}</Dd>
        <Dt>כתובת נוכחי</Dt><Dd className="col-span-2">{preview.currentAddress ?? "—"}</Dd>
        <Dt>כתובת חדש</Dt><Dd className="col-span-2">{preview.proposedAddress ?? "—"}</Dd>
        <Dt>מיקוד נוכחי</Dt><Dd className="col-span-2">{preview.currentZipCode ?? "—"}</Dd>
        <Dt>מיקוד חדש</Dt>
        <Dd className="col-span-2">
          {preview.proposedZipCode ?? "לא הוגדר בפרופיל העסק — לא יישלח"}
        </Dd>
      </dl>
      <div className="rounded-lg border border-line p-3">
        <p className="t-label mb-1 text-ink">
          שדות שישתנו (<bdi className="ltr-num">{preview.changes.length}</bdi>)
        </p>
        {preview.changes.length === 0 ? (
          <p className="t-label">אין שינויים — הנתונים כבר תואמים.</p>
        ) : (
          <ul className="t-label flex flex-col gap-0.5 text-text2">
            {preview.changes.map((c) => (
              <li key={c.key} className="ltr-num font-mono">{c.key}: {String(c.from ?? "∅")} → {String(c.to ?? "∅")}</li>
            ))}
          </ul>
        )}
      </div>
      <ul className="t-label flex flex-col gap-1 text-status-warning">
        <li>• לא נוצר נכס חדש — מעודכן הנכס הקיים בלבד (אותו מזהה).</li>
        <li>• חדרים, תעריפים והזמנות אינם משתנים (<bdi className="ltr-num">{roomCount}</bdi> חדרים ללא שינוי).</li>
      </ul>
    </ConfirmDialog>
  );
}

function RoomsPreview({ view }: { view: ChannexPropertyContextView }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon name="list" size={17} className="text-muted" />
        <h3 className="h4">תצוגת חדרים קיימים (לקריאה בלבד)</h3>
        <span className="chip chip-neutral">
          <bdi className="ltr-num">{view.rooms.length}</bdi>
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-line bg-hover/40">
              <th className="t-label px-4 py-3 text-start text-faint">חדר</th>
              <th className="t-label px-4 py-3 text-start text-faint">בניין/אזור</th>
              <th className="t-label px-4 py-3 text-start text-faint">קומה</th>
              <th className="t-label px-4 py-3 text-start text-faint">סוג חדר</th>
              <th className="t-label px-4 py-3 text-start text-faint">סטטוס</th>
              <th className="t-label px-4 py-3 text-start text-faint">תפוסה (מ׳–מקס)</th>
              <th className="t-label px-4 py-3 text-start text-faint">מבוגרים/ילדים/תינוקות</th>
            </tr>
          </thead>
          <tbody>
            {view.rooms.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 text-ink">
                  <bdi className="ltr-num font-bold">{r.room_number}</bdi>
                </td>
                <td className="px-4 py-3 text-text2">{r.area_name ?? "—"}</td>
                <td className="px-4 py-3 text-text2">
                  <bdi className="ltr-num">{r.floor ?? "—"}</bdi>
                </td>
                <td className="px-4 py-3 text-text2">{r.room_type_name ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`chip ${r.is_active && r.status === "available" ? "chip-paid" : "chip-neutral"}`}>
                    {r.is_active ? STATUS_LABEL[r.status] ?? r.status : "לא פעיל"}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted">
                  <bdi className="ltr-num">{r.min_occupancy ?? "—"}–{r.max_occupancy}</bdi>
                </td>
                <td className="px-4 py-3 text-muted">
                  <bdi className="ltr-num">{r.max_adults}/{r.max_children}/{r.max_infants}</bdi>
                </td>
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

const Dt =({ children }: { children: React.ReactNode }) => <dt className="t-label text-faint">{children}</dt>;
const Dd = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <dd className={`t-secondary truncate text-text2 ${className}`}>{children}</dd>
);
