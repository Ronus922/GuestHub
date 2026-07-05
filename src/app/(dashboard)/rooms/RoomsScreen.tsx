"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { CardTitle, Field } from "@/components/reservations/BookingPanel";
import { Segmented } from "@/app/(dashboard)/settings/controls";
import {
  resolveEffectivePricing,
  validateRoomOccupancy,
  type RoomExtraGuestOverride,
  type PricingSource,
} from "@/lib/commercial/room-pricing";
import type { ExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import type { RoomRow } from "@/lib/commercial/service";
import { saveRoomOccupancyAction } from "./actions";

type Property = ExtraGuestDefaults & { adult_min_age: number };

const SOURCE_LABEL: Record<PricingSource, string> = {
  room_override: "חריגת חדר",
  property_default: "ברירת מחדל של הנכס",
  unconfigured: "טרם הוגדר",
};

const overrideOf = (r: RoomRow): RoomExtraGuestOverride => ({
  mode: r.extra_guest_pricing_mode,
  extra_adult: r.extra_adult_override,
  extra_child: r.extra_child_override,
  extra_infant: r.extra_infant_override,
  charge_frequency: r.charge_frequency_override,
});

export function RoomsScreen({
  rooms,
  property,
  currency,
  canEdit,
}: {
  rooms: RoomRow[];
  property: Property;
  currency: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<RoomRow | null>(null);
  const incomplete = rooms.filter((r) => r.included_occupancy === null).length;

  return (
    <div className="flex flex-col gap-5 p-[26px]" dir="rtl">
      <div>
        <h1 className="text-2xl font-extrabold text-ink">חדרים</h1>
        <p className="mt-1 text-sm font-semibold text-muted">תפוסה ותמחור אורח נוסף לכל חדר</p>
      </div>

      {!property.configured && (
        <div className="flex items-center gap-2 rounded-xl bg-status-warning-050 px-4 py-3 text-sm" style={{ color: "#B4670A" }}>
          <Icon name="info" size={16} />
          תמחור אורח נוסף של הנכס טרם הוגדר. חדרים היורשים מהנכס יסומנו כדורשים השלמה.
        </div>
      )}
      {incomplete > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-status-warning-050 px-4 py-3 text-sm" style={{ color: "#B4670A" }}>
          <Icon name="warning" size={16} />
          {incomplete} חדרים דורשים השלמה — לא הוגדרו ״אורחים הכלולים במחיר הבסיס״.
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-line text-faint">
              <th className="px-4 py-3 text-start font-semibold">חדר</th>
              <th className="px-4 py-3 text-start font-semibold">תפוסה מקס׳</th>
              <th className="px-4 py-3 text-start font-semibold">כלולים במחיר</th>
              <th className="px-4 py-3 text-start font-semibold">תמחור אורח נוסף</th>
              <th className="px-4 py-3 text-start font-semibold">מצב</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rooms.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-faint">אין חדרים</td></tr>
            )}
            {rooms.map((r) => {
              const eff = resolveEffectivePricing(overrideOf(r), property);
              const priceText = eff.complete
                ? `${eff.extra_adult.value} / ${eff.extra_child.value} / ${eff.extra_infant.value} ${currency}`
                : "טרם הוגדר";
              return (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-hover">
                  <td className="px-4 py-3">
                    <span className="font-bold text-ink" dir="ltr">{r.room_number}</span>
                    {r.name ? <span className="text-faint"> · {r.name}</span> : null}
                    {r.room_type_name ? <div className="text-xs text-faint">{r.room_type_name}</div> : null}
                  </td>
                  <td className="px-4 py-3">{r.max_occupancy}</td>
                  <td className="px-4 py-3">
                    {r.included_occupancy ?? <span className="text-status-warning">טרם הוגדר</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div>{priceText}</div>
                    <div className="text-xs text-faint">
                      {r.extra_guest_pricing_mode === "override" ? "חריגת חדר" : "ירושה מהנכס"} ·{" "}
                      {SOURCE_LABEL[eff.extra_adult.source]}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {r.included_occupancy === null
                      ? <span className="rounded-full bg-status-warning-050 px-2 py-0.5 text-xs font-semibold text-status-warning">דורש השלמה</span>
                      : <span className="rounded-full bg-status-success-050 px-2 py-0.5 text-xs font-semibold text-status-success">מוגדר</span>}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <button
                      type="button"
                      className="grid h-9 w-9 place-items-center rounded-lg text-text2 hover:bg-hover disabled:opacity-40"
                      aria-label="עריכה"
                      disabled={!canEdit}
                      onClick={() => setEditing(r)}
                    >
                      <Icon name="edit" size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <RoomEditPanel room={editing} property={property} currency={currency} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

type Draft = {
  id: string;
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
  default_occupancy: number | null;
  included_occupancy: number | null;
  extra_guest_pricing_mode: "inherit" | "override";
  extra_adult_override: number | null;
  extra_child_override: number | null;
  extra_infant_override: number | null;
  charge_frequency_override: "per_night" | "per_stay" | null;
};

function RoomEditPanel({
  room,
  property,
  currency,
  onClose,
}: {
  room: RoomRow;
  property: Property;
  currency: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [d, setD] = useState<Draft>({
    id: room.id,
    max_occupancy: room.max_occupancy,
    max_adults: room.max_adults,
    max_children: room.max_children,
    max_infants: room.max_infants,
    default_occupancy: room.default_occupancy,
    included_occupancy: room.included_occupancy,
    extra_guest_pricing_mode: room.extra_guest_pricing_mode,
    extra_adult_override: room.extra_adult_override,
    extra_child_override: room.extra_child_override,
    extra_infant_override: room.extra_infant_override,
    charge_frequency_override: room.charge_frequency_override,
  });
  const published = room.is_active && room.status === "available";
  const isOverride = d.extra_guest_pricing_mode === "override";

  const effective = useMemo(
    () =>
      resolveEffectivePricing(
        {
          mode: d.extra_guest_pricing_mode,
          extra_adult: d.extra_adult_override,
          extra_child: d.extra_child_override,
          extra_infant: d.extra_infant_override,
          charge_frequency: d.charge_frequency_override,
        },
        property,
      ),
    [d, property],
  );

  const { errors, warnings } = validateRoomOccupancy({
    maxOccupancy: d.max_occupancy,
    maxAdults: d.max_adults,
    maxChildren: d.max_children,
    maxInfants: d.max_infants,
    defaultOccupancy: d.default_occupancy,
    includedOccupancy: d.included_occupancy,
    mode: d.extra_guest_pricing_mode,
    extra_adult: isOverride ? d.extra_adult_override : null,
    extra_child: isOverride ? d.extra_child_override : null,
    extra_infant: isOverride ? d.extra_infant_override : null,
    published,
    propertyConfigured: property.configured,
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }));

  const save = () =>
    startSaving(async () => {
      const res = await saveRoomOccupancyAction(d);
      if (res.success) {
        toast.success("החדר נשמר");
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });

  return (
    <SidePanel
      open
      onClose={onClose}
      title={`חדר ${room.room_number}`}
      subtitle={room.name ?? undefined}
      icon="rooms"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-faint">{warnings[0] ?? ""}</span>
          <div className="flex gap-2">
            <button type="button" className="bw-btn bw-btn-o" onClick={onClose}>ביטול</button>
            <button type="button" className="bw-btn bw-btn-primary" disabled={saving || errors.length > 0} onClick={save}>
              <Icon name="check" size={16} />
              {saving ? "שומר…" : "שמירה"}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="bw-card">
          <CardTitle icon="rooms" title="תפוסה" />
          <div className="bw-grid2">
            <NumField label="תפוסה מקסימלית" value={d.max_occupancy} onChange={(v) => set("max_occupancy", v ?? 1)} />
            <NumField label="תפוסת ברירת מחדל" value={d.default_occupancy} nullable placeholder="טרם הוגדר" onChange={(v) => set("default_occupancy", v)} />
            <NumField label="אורחים הכלולים במחיר הבסיס" value={d.included_occupancy} nullable placeholder="טרם הוגדר" onChange={(v) => set("included_occupancy", v)} />
            <NumField label="מקסימום מבוגרים" value={d.max_adults} onChange={(v) => set("max_adults", v ?? 0)} />
            <NumField label="מקסימום ילדים" value={d.max_children} onChange={(v) => set("max_children", v ?? 0)} />
            <NumField label="מקסימום תינוקות" value={d.max_infants} onChange={(v) => set("max_infants", v ?? 0)} />
          </div>
          <p className="bw-hint">
            ״אורחים הכלולים במחיר הבסיס״ קובע מאיזה אורח מתחיל חיוב נוסף (ערך 2 → חיוב מהאורח השלישי).
          </p>
        </section>

        <section className="bw-card">
          <div className="mb-3 flex items-center justify-between">
            <CardTitle icon="finance" title="תמחור תפוסה" />
            <Segmented
              ariaLabel="מצב תמחור"
              value={d.extra_guest_pricing_mode}
              onChange={(v) => set("extra_guest_pricing_mode", v)}
              options={[
                { value: "inherit", label: "ירושה מהנכס" },
                { value: "override", label: "חריגה לחדר" },
              ]}
            />
          </div>

          {!isOverride ? (
            <div className="flex flex-col gap-2">
              <EffRow label="אורח בוגר נוסף" amount={effective.extra_adult.value} source={SOURCE_LABEL[effective.extra_adult.source]} currency={currency} />
              <EffRow label="ילד נוסף" amount={effective.extra_child.value} source={SOURCE_LABEL[effective.extra_child.source]} currency={currency} />
              <EffRow label="תינוק נוסף" amount={effective.extra_infant.value} source={SOURCE_LABEL[effective.extra_infant.source]} currency={currency} />
              <div className="text-sm text-text2">
                תדירות: {effective.charge_frequency.value === "per_night" ? "לכל לילה" : "לכל השהות"}
                <span className="text-faint"> · {SOURCE_LABEL[effective.charge_frequency.source]}</span>
              </div>
              <p className="bw-hint">
                {property.configured
                  ? "החדר יורש את ערכי הנכס. לחיצה על ״חריגה לחדר״ תאפשר עריכה — ערכי הנכס לא יועתקו לחדר."
                  : "תמחור הנכס טרם הוגדר. הגדר בהגדרות ← תמחור תפוסה, או קבע חריגה לחדר זה."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="bw-grid2">
                <MoneyField label="אורח בוגר נוסף" currency={currency} value={d.extra_adult_override} onChange={(v) => set("extra_adult_override", v)} />
                <MoneyField label="ילד נוסף" currency={currency} value={d.extra_child_override} onChange={(v) => set("extra_child_override", v)} />
                <MoneyField label="תינוק נוסף" currency={currency} value={d.extra_infant_override} onChange={(v) => set("extra_infant_override", v)} />
                <Field label="תדירות חיוב">
                  <Segmented
                    ariaLabel="תדירות חריגה"
                    value={d.charge_frequency_override ?? "per_night"}
                    onChange={(v) => set("charge_frequency_override", v)}
                    options={[
                      { value: "per_night", label: "לכל לילה" },
                      { value: "per_stay", label: "לכל השהות" },
                    ]}
                  />
                </Field>
              </div>
              <p className="bw-hint">
                שדה ריק יורש מהנכס עבור אותה קטגוריה. ניתן לשמור 0 כחריגה מפורשת.
                {" "}
                <button type="button" className="font-semibold text-primary underline" onClick={() => set("extra_guest_pricing_mode", "inherit")}>
                  חזרה לירושה מהנכס
                </button>
              </p>
            </div>
          )}
        </section>

        {errors.length > 0 && (
          <section className="bw-card">
            {errors.map((e, i) => (
              <p key={i} className="flex items-center gap-2 text-sm text-status-danger">
                <Icon name="warning" size={14} /> {e}
              </p>
            ))}
          </section>
        )}
      </div>
    </SidePanel>
  );
}

function EffRow({ label, amount, source, currency }: { label: string; amount: number | null; source: string; currency: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-2.5">
      <span className="text-sm text-ink">{label}</span>
      <span className="text-sm">
        {amount === null ? <span className="text-status-warning">טרם הוגדר</span> : <strong dir="ltr">{amount} {currency}</strong>}
        <span className="text-xs text-faint"> · {source}</span>
      </span>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  nullable,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  nullable?: boolean;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <input
        className="bw-fld"
        dir="ltr"
        inputMode="numeric"
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const s = e.target.value.trim();
          if (s === "") return onChange(nullable ? null : 0);
          const n = parseInt(s, 10);
          onChange(Number.isFinite(n) ? n : nullable ? null : 0);
        }}
      />
    </Field>
  );
}

function MoneyField({
  label,
  currency,
  value,
  onChange,
}: {
  label: string;
  currency: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <Field label={`${label} (${currency})`}>
      <input
        className="bw-fld"
        dir="ltr"
        inputMode="decimal"
        placeholder="יורש מהנכס"
        value={value ?? ""}
        onChange={(e) => {
          const s = e.target.value.trim();
          if (s === "") return onChange(null);
          const n = Number(s);
          onChange(Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
        }}
      />
    </Field>
  );
}
