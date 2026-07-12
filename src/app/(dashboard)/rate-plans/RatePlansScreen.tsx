"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { formatFullDate } from "@/lib/dates";
import type { PlanKind } from "@/lib/pricing/resolve";
import type { RatePlanDetail } from "@/lib/rate-plans/service";
import type { AssignableUnit, PolicyOption, RatePlanListItem, RatePlansCan } from "./types";
import {
  archiveRatePlanAction,
  deleteRatePlanAction,
  duplicateRatePlanAction,
  getRatePlanDetailAction,
} from "./actions";
import { RatePlanWizard } from "./RatePlanWizard";
import { OverridesPanel } from "./OverridesPanel";
import { SimulatorPanel } from "./SimulatorPanel";

// ============================================================
// Rate Plans board (spec §18–§21). Card list over the server-ordered plans
// (is_archived last, then sort_order, then name — order preserved, filters
// only subset). Edit opens the shared wizard after loading the full detail
// (description / policies / assignments) via getRatePlanDetailAction.
// ============================================================

const KIND_LABEL: Record<PlanKind, string> = {
  base: "מחיר בסיס",
  derived_percentage: "נגזרת אחוז",
  derived_fixed: "נגזרת סכום",
  independent: "עצמאי",
};

type StatusFilter = "all" | "active" | "inactive" | "archived";
type KindFilter = "all" | PlanKind;
type RefundFilter = "all" | "refundable" | "nonref";

export function RatePlansScreen({
  plans,
  units,
  cancellationPolicies,
  paymentPolicies,
  can,
}: {
  plans: RatePlanListItem[];
  units: AssignableUnit[];
  cancellationPolicies: PolicyOption[];
  paymentPolicies: PolicyOption[];
  can: RatePlansCan;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState<StatusFilter>("all");
  const [kindF, setKindF] = useState<KindFilter>("all");
  const [refundF, setRefundF] = useState<RefundFilter>("all");
  const [wizard, setWizard] = useState<{ detail: RatePlanDetail | null } | null>(null);
  const [overridesFor, setOverridesFor] = useState<RatePlanListItem | null>(null);
  const [simOpen, setSimOpen] = useState(false);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      plans.filter((p) => {
        if (needle && !`${p.name} ${p.public_name ?? ""} ${p.code}`.toLowerCase().includes(needle))
          return false;
        if (statusF === "active" && !(p.is_active && !p.is_archived)) return false;
        if (statusF === "inactive" && !(!p.is_active && !p.is_archived)) return false;
        if (statusF === "archived" && !p.is_archived) return false;
        if (kindF !== "all" && p.plan_kind !== kindF) return false;
        if (refundF === "refundable" && !p.is_refundable) return false;
        if (refundF === "nonref" && p.is_refundable) return false;
        return true;
      }),
    [plans, needle, statusF, kindF, refundF],
  );

  const unitsWithoutPlan = useMemo(
    () => units.filter((u) => u.active_plan_count === 0).length,
    [units],
  );
  const hasActivePlan = plans.some((p) => p.is_active && !p.is_archived);

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) =>
    startBusy(async () => {
      const res = await fn();
      if (!res.success) return void toast.error(res.error ?? "אירעה שגיאה בלתי צפויה");
      toast.success(okMsg);
      router.refresh();
    });

  const openEdit = async (p: RatePlanListItem) => {
    setDetailLoadingId(p.id);
    try {
      const res = await getRatePlanDetailAction({ id: p.id });
      if (!res.success) return void toast.error(res.error);
      if (!res.detail) return void toast.error("תוכנית התעריף לא נמצאה");
      setWizard({ detail: res.detail });
    } finally {
      setDetailLoadingId(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col gap-4 p-6 max-sm:p-4" dir="rtl">
      {/* header bar */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="h1">תוכניות תעריף</h1>
        <span className="chip chip-neutral">{plans.length} תוכניות</span>
        <span className="flex-1" />
        <div className="relative w-64 max-sm:w-full">
          <Icon
            name="search"
            size={20}
            className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            className="field-input ps-11"
            aria-label="חיפוש תוכנית תעריף"
            placeholder="חיפוש לפי שם או קוד…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {can.simulate && (
          <button type="button" className="btn btn-secondary" onClick={() => setSimOpen(true)}>
            <Icon name="calculator" size={20} />
            סימולטור תמחור
          </button>
        )}
        {can.create && (
          <button type="button" className="btn btn-primary" onClick={() => setWizard({ detail: null })}>
            <Icon name="plus" size={20} />
            תוכנית חדשה
          </button>
        )}
      </div>

      {/* uncovered-rooms warning */}
      {unitsWithoutPlan > 0 && hasActivePlan && (
        <div className="flex items-center gap-3 rounded-card border border-status-warning/30 bg-status-warning-050 p-4 text-[14px] font-medium text-status-warning">
          <Icon name="warning" size={20} className="shrink-0" />
          {unitsWithoutPlan} חדרים ללא תוכנית תעריף פעילה
        </div>
      )}

      {plans.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-surface p-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-primary-050 text-primary">
            <Icon name="tags" size={24} />
          </span>
          <p className="h4">טרם הוגדרו תוכניות תעריף</p>
          <p className="max-w-md text-[14px] text-muted">
            תוכניות תעריף קובעות כיצד מתומחר כל חדר — מחיר בסיס, נגזרות אחוז או סכום, ותוכניות
            עצמאיות. צרו את התוכנית הראשונה כדי להתחיל.
          </p>
          {can.create && (
            <button type="button" className="btn btn-primary" onClick={() => setWizard({ detail: null })}>
              <Icon name="plus" size={17} />
              תוכנית חדשה
            </button>
          )}
        </div>
      ) : (
        <>
          {/* quick filter chips */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="t-label">סטטוס:</span>
            {(
              [
                { v: "all", label: "הכל" },
                { v: "active", label: "פעילות" },
                { v: "inactive", label: "לא פעילות" },
                { v: "archived", label: "ארכיון" },
              ] as const
            ).map((o) => (
              <Chip key={o.v} on={statusF === o.v} onClick={() => setStatusF(o.v)}>
                {o.label}
              </Chip>
            ))}
            <span className="h-6 w-px bg-line" />
            <span className="t-label">סוג:</span>
            <Chip on={kindF === "all"} onClick={() => setKindF("all")}>
              הכל
            </Chip>
            {(Object.keys(KIND_LABEL) as PlanKind[]).map((k) => (
              <Chip key={k} on={kindF === k} onClick={() => setKindF(k)}>
                {KIND_LABEL[k]}
              </Chip>
            ))}
            <span className="h-6 w-px bg-line" />
            <span className="t-label">החזר:</span>
            {(
              [
                { v: "all", label: "הכל" },
                { v: "refundable", label: "גמיש" },
                { v: "nonref", label: "ללא החזר" },
              ] as const
            ).map((o) => (
              <Chip key={o.v} on={refundF === o.v} onClick={() => setRefundF(o.v)}>
                {o.label}
              </Chip>
            ))}
          </div>

          {/* plan cards (server order preserved) */}
          <div className="flex flex-col gap-3">
            {filtered.map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                can={can}
                busy={busy}
                loadingDetail={detailLoadingId === p.id}
                onEdit={() => void openEdit(p)}
                onDuplicate={() =>
                  run(
                    () => duplicateRatePlanAction({ id: p.id, withAssignments: true }),
                    "התוכנית שוכפלה — העותק נוצר כלא פעיל",
                  )
                }
                onOverrides={() => setOverridesFor(p)}
                onArchive={() =>
                  run(
                    () => archiveRatePlanAction({ id: p.id, archived: !p.is_archived }),
                    p.is_archived ? "התוכנית שוחזרה מהארכיון" : "התוכנית הועברה לארכיון",
                  )
                }
                onDelete={() => run(() => deleteRatePlanAction({ id: p.id }), "התוכנית נמחקה")}
              />
            ))}
            {filtered.length === 0 && (
              <div className="rounded-card border border-dashed border-line bg-surface p-8 text-center text-[14px] text-muted">
                לא נמצאו תוכניות תעריף תואמות לסינון
              </div>
            )}
          </div>
        </>
      )}

      {wizard && (
        <RatePlanWizard
          open
          onClose={() => setWizard(null)}
          detail={wizard.detail}
          plans={plans}
          units={units}
          cancellationPolicies={cancellationPolicies}
          paymentPolicies={paymentPolicies}
          canSave={wizard.detail ? can.edit : can.create}
        />
      )}

      {overridesFor && (
        <OverridesPanel
          open
          onClose={() => setOverridesFor(null)}
          plan={overridesFor}
          units={units}
          canEdit={can.edit}
        />
      )}

      <SimulatorPanel open={simOpen} onClose={() => setSimOpen(false)} units={units} plans={plans} />
    </div>
  );
}

// ---------- plan card ----------

function PlanCard({
  plan: p,
  can,
  busy,
  loadingDetail,
  onEdit,
  onDuplicate,
  onOverrides,
  onArchive,
  onDelete,
}: {
  plan: RatePlanListItem;
  can: RatePlansCan;
  busy: boolean;
  loadingDetail: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onOverrides: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      className={`flex flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-card ${
        p.is_archived ? "opacity-70" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="h4">{p.name}</h2>
        {p.public_name && p.public_name !== p.name && (
          <span className="text-[14px] text-muted">({p.public_name})</span>
        )}
        <span className="chip chip-neutral ltr-num font-mono">{p.code}</span>
        <span className="chip chip-neutral">
          <Icon name="percent" size={13.5} />
          {p.formula}
        </span>
        {p.is_archived ? (
          <span className="chip chip-cancelled">ארכיון</span>
        ) : p.is_active ? (
          <span className="chip chip-paid">
            <span className="dot" />
            פעילה
          </span>
        ) : (
          <span className="chip chip-neutral">
            <span className="dot" />
            לא פעילה
          </span>
        )}
        <span className={`chip ${p.is_refundable ? "chip-paid" : "chip-neutral"}`}>
          {p.is_refundable ? "גמיש" : "ללא החזר"}
        </span>
        {p.is_visible_website && (
          <span className="text-primary" title="מוצג באתר">
            <Icon name="globe" size={17} label="מוצג באתר" />
          </span>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          {can.edit && (
            <IconAction
              label="עריכה"
              icon="edit"
              disabled={loadingDetail || busy}
              onClick={onEdit}
            />
          )}
          {can.create && (
            <TwoClick
              label="שכפול"
              confirmLabel="לאשר שכפול?"
              icon="copy"
              disabled={busy}
              onConfirm={onDuplicate}
            />
          )}
          {can.edit && <IconAction label="חריגות תאריך" icon="percent" onClick={onOverrides} />}
          {can.del && (
            <IconAction
              label={p.is_archived ? "שחזור מהארכיון" : "העברה לארכיון"}
              icon={p.is_archived ? "refresh" : "circle-slash"}
              disabled={busy}
              onClick={onArchive}
            />
          )}
          {can.del && (
            <TwoClick
              label="מחיקה"
              confirmLabel="לאשר מחיקה?"
              icon="trash"
              danger
              disabled={busy}
              onConfirm={onDelete}
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="rooms" size={17} />
          {p.active_assigned_units} חדרים
        </span>
        {p.cancellation_policy_name && (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="circle-slash" size={17} />
            {p.cancellation_policy_name}
          </span>
        )}
        {(p.valid_from || p.valid_until) && (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="calendar" size={17} />
            בתוקף
            {p.valid_from && (
              <>
                {" "}
                מ־<bdi className="ltr-num">{formatFullDate(p.valid_from)}</bdi>
              </>
            )}
            {p.valid_until && (
              <>
                {" "}
                עד <bdi className="ltr-num">{formatFullDate(p.valid_until)}</bdi>
              </>
            )}
          </span>
        )}
        {p.override_rows > 0 && <span className="chip chip-neutral">{p.override_rows} חריגות תאריך</span>}
        {p.incomplete.map((flag) => (
          <span key={flag} className="chip chip-approval">
            <Icon name="warning" size={13.5} />
            {flag}
          </span>
        ))}
      </div>
    </article>
  );
}

// ---------- small building blocks ----------

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`chip clickable${on ? " on" : ""}`}>
      {children}
    </button>
  );
}

function IconAction({
  label,
  icon,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  icon: IconName;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`icon-btn ${danger ? "text-status-danger hover:bg-status-danger-050" : ""}`}
    >
      <Icon name={icon} size={20} label={label} />
    </button>
  );
}

// Two-click destructive confirm (window.confirm is banned): first click arms
// the button into an explicit Hebrew confirmation, second click executes.
// Losing focus disarms, so an accidental first click never lingers.
function TwoClick({
  label,
  confirmLabel,
  icon,
  danger,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  icon: IconName;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        onBlur={() => setArmed(false)}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
        className={`btn btn-sm ${danger ? "btn-danger" : "btn-secondary"}`}
      >
        <Icon name={icon} size={17} />
        {confirmLabel}
      </button>
    );
  }
  return (
    <IconAction
      label={label}
      icon={icon}
      danger={danger}
      disabled={disabled}
      onClick={() => setArmed(true)}
    />
  );
}
