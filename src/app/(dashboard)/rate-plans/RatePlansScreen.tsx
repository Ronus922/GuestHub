"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { Badge } from "@/components/ui/Badge";
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
        <h1 className="text-xl font-bold text-ink">תוכניות תעריף</h1>
        <Badge tone="brand">{plans.length} תוכניות</Badge>
        <span className="flex-1" />
        <div className="relative w-64 max-sm:w-full">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            className="field min-h-11 py-2 ps-11"
            placeholder="חיפוש לפי שם או קוד…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {can.simulate && (
          <button type="button" className="btn btn-outline" onClick={() => setSimOpen(true)}>
            <Icon name="calculator" size={17} />
            סימולטור תמחור
          </button>
        )}
        {can.create && (
          <button type="button" className="btn btn-primary" onClick={() => setWizard({ detail: null })}>
            <Icon name="plus" size={17} />
            תוכנית חדשה
          </button>
        )}
      </div>

      {/* uncovered-rooms warning */}
      {unitsWithoutPlan > 0 && hasActivePlan && (
        <div className="flex items-center gap-3 rounded-card border border-status-warning/30 bg-status-warning-050 p-4 text-sm font-medium text-status-warning">
          <Icon name="warning" size={18} className="shrink-0" />
          {unitsWithoutPlan} חדרים ללא תוכנית תעריף פעילה
        </div>
      )}

      {plans.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-surface p-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-050 text-primary">
            <Icon name="tags" size={26} />
          </span>
          <p className="text-base font-bold text-ink">טרם הוגדרו תוכניות תעריף</p>
          <p className="max-w-md text-sm text-muted">
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
            <span className="text-sm font-medium text-muted">סטטוס:</span>
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
            <span className="text-sm font-medium text-muted">סוג:</span>
            <Chip on={kindF === "all"} onClick={() => setKindF("all")}>
              הכל
            </Chip>
            {(Object.keys(KIND_LABEL) as PlanKind[]).map((k) => (
              <Chip key={k} on={kindF === k} onClick={() => setKindF(k)}>
                {KIND_LABEL[k]}
              </Chip>
            ))}
            <span className="h-6 w-px bg-line" />
            <span className="text-sm font-medium text-muted">החזר:</span>
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
              <div className="rounded-card border border-dashed border-line bg-surface p-8 text-center text-sm text-muted">
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
        <h2 className="text-base font-bold text-ink">{p.name}</h2>
        {p.public_name && p.public_name !== p.name && (
          <span className="text-sm text-muted">({p.public_name})</span>
        )}
        <span dir="ltr" className="rounded-md bg-hover px-2 py-0.5 font-mono text-xs text-text2">
          {p.code}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-050 px-2.5 py-0.5 text-xs font-semibold text-primary">
          <Icon name="percent" size={13} />
          {p.formula}
        </span>
        {p.is_archived ? (
          <Badge tone="muted">ארכיון</Badge>
        ) : p.is_active ? (
          <Badge tone="success" dot>
            פעילה
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            לא פעילה
          </Badge>
        )}
        <Badge tone={p.is_refundable ? "success" : "neutral"}>
          {p.is_refundable ? "גמיש" : "ללא החזר"}
        </Badge>
        {p.is_visible_website && (
          <span className="text-primary" title="מוצג באתר" aria-label="מוצג באתר">
            <Icon name="globe" size={16} />
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="rooms" size={15} />
          {p.active_assigned_units} חדרים
        </span>
        {p.cancellation_policy_name && (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="circle-slash" size={15} />
            {p.cancellation_policy_name}
          </span>
        )}
        {(p.valid_from || p.valid_until) && (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="calendar" size={15} />
            בתוקף
            {p.valid_from && (
              <>
                {" "}
                מ־<span dir="ltr">{formatFullDate(p.valid_from)}</span>
              </>
            )}
            {p.valid_until && (
              <>
                {" "}
                עד <span dir="ltr">{formatFullDate(p.valid_until)}</span>
              </>
            )}
          </span>
        )}
        {p.override_rows > 0 && <Badge tone="brand">{p.override_rows} חריגות תאריך</Badge>}
        {p.incomplete.map((flag) => (
          <Badge key={flag} tone="warning">
            <Icon name="warning" size={12} />
            {flag}
          </Badge>
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
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
        on
          ? "border-primary bg-primary-050 text-primary"
          : "border-line bg-surface text-text2 hover:bg-hover"
      }`}
    >
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
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-11 w-11 place-items-center rounded-xl transition-colors disabled:opacity-50 ${
        danger ? "text-status-danger hover:bg-status-danger-050" : "text-text2 hover:bg-hover"
      }`}
    >
      <Icon name={icon} size={18} />
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
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 ${
          danger ? "bg-status-danger-050 text-status-danger" : "bg-primary-050 text-primary"
        }`}
      >
        <Icon name={icon} size={15} />
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
