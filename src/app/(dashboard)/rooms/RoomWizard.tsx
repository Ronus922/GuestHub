"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { CardTitle, Field } from "@/components/reservations/BookingPanel";
import { Segmented, Switch } from "@/app/(dashboard)/settings/controls";
import {
  resolveEffectivePricing,
  validateRoomOccupancy,
  type PricingSource,
} from "@/lib/commercial/room-pricing";
import type { ExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import type {
  AmenityOption,
  BoardRoom,
  BuildingOption,
  Lang,
  RoomImage,
  RoomTypeOption,
} from "@/lib/rooms/service";
import type { Can } from "./RoomsScreen";
import {
  addAmenityAction,
  deleteRoomAction,
  deleteRoomImageAction,
  duplicateRoomAction,
  saveRoomAction,
  updateRoomImagesAction,
} from "./actions";

type Property = ExtraGuestDefaults & { adult_min_age: number };

const LANG_META: Record<Lang, { label: string; tag: string }> = {
  he: { label: "עברית", tag: "IL" },
  en: { label: "English", tag: "GB" },
  ar: { label: "عربية", tag: "SA" },
};
const ALL_LANGS: Lang[] = ["he", "en", "ar"];

const SOURCE_LABEL: Record<PricingSource, string> = {
  room_override: "חריגת חדר",
  property_default: "ברירת מחדל של הנכס",
  unconfigured: "טרם הוגדר",
};

type TrDraft = {
  name: string;
  description: string;
  summary: string;
  slug: string;
  seo_title: string;
  meta_description: string;
  og_title: string;
  og_description: string;
  noindex: boolean;
};

const EMPTY_TR: TrDraft = {
  name: "", description: "", summary: "", slug: "",
  seo_title: "", meta_description: "", og_title: "", og_description: "",
  noindex: false,
};

type BaseDraft = {
  room_number: string;
  room_type_id: string | null;
  area_id: string | null;
  floor: string;
  status: "available" | "inactive" | "out_of_order";
  is_active: boolean;
  show_on_website: boolean;
  sort_order: number;
  size_sqm: number | null;
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
  single_beds: number;
  double_beds: number;
  queen_beds: number;
  sofa_beds: number;
  cribs: number;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function RoomWizard({
  room,
  buildings,
  roomTypes,
  amenities,
  property,
  currency,
  can,
  onClose,
}: {
  room: BoardRoom | null; // null = create
  buildings: BuildingOption[];
  roomTypes: RoomTypeOption[];
  amenities: AmenityOption[];
  property: Property;
  currency: string;
  can: Can;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [lang, setLang] = useState<Lang>("he");
  const [roomId, setRoomId] = useState<string | null>(room?.id ?? null);
  const dirtyLangs = useRef<Set<Lang>>(new Set(room ? [] : ["he"]));

  const [base, setBase] = useState<BaseDraft>({
    room_number: room?.room_number ?? "",
    room_type_id: room?.room_type_id ?? null,
    area_id: room?.area_id ?? null,
    floor: room?.floor ?? "",
    status: (room?.status as BaseDraft["status"]) ?? "available",
    is_active: room?.is_active ?? true,
    show_on_website: room?.show_on_website ?? false,
    sort_order: room?.sort_order ?? 0,
    size_sqm: room?.size_sqm ?? null,
    max_occupancy: room?.max_occupancy ?? 2,
    max_adults: room?.max_adults ?? 2,
    max_children: room?.max_children ?? 0,
    max_infants: room?.max_infants ?? 0,
    default_occupancy: room?.default_occupancy ?? null,
    included_occupancy: room?.included_occupancy ?? null,
    extra_guest_pricing_mode: room?.extra_guest_pricing_mode ?? "inherit",
    extra_adult_override: room?.extra_adult_override ?? null,
    extra_child_override: room?.extra_child_override ?? null,
    extra_infant_override: room?.extra_infant_override ?? null,
    charge_frequency_override: room?.charge_frequency_override ?? null,
    single_beds: room?.single_beds ?? 0,
    double_beds: room?.double_beds ?? 0,
    queen_beds: room?.queen_beds ?? 0,
    sofa_beds: room?.sofa_beds ?? 0,
    cribs: room?.cribs ?? 0,
  });

  const [trs, setTrs] = useState<Record<Lang, TrDraft>>(() => {
    const init = { he: { ...EMPTY_TR }, en: { ...EMPTY_TR }, ar: { ...EMPTY_TR } };
    for (const t of room?.translations ?? []) {
      init[t.lang] = {
        name: t.name ?? "", description: t.description ?? "", summary: t.summary ?? "",
        slug: t.slug ?? "", seo_title: t.seo_title ?? "",
        meta_description: t.meta_description ?? "", og_title: t.og_title ?? "",
        og_description: t.og_description ?? "", noindex: t.noindex,
      };
    }
    if (!init.he.name && room?.name) init.he.name = room.name;
    return init;
  });

  const [amenityIds, setAmenityIds] = useState<string[]>(room?.amenity_ids ?? []);
  const [customAmenities, setCustomAmenities] = useState<AmenityOption[]>([]);
  const [images, setImages] = useState<RoomImage[]>(room?.images ?? []);
  const imagesDirty = useRef(false);

  const setB = <K extends keyof BaseDraft>(k: K, v: BaseDraft[K]) => setBase((s) => ({ ...s, [k]: v }));
  const setT = <K extends keyof TrDraft>(k: K, v: TrDraft[K]) => {
    dirtyLangs.current.add(lang);
    setTrs((s) => ({ ...s, [lang]: { ...s[lang], [k]: v } }));
  };
  const tr = trs[lang];

  const published = base.is_active && base.status === "available";
  const isOverride = base.extra_guest_pricing_mode === "override";
  const effective = useMemo(
    () =>
      resolveEffectivePricing(
        {
          mode: base.extra_guest_pricing_mode,
          extra_adult: base.extra_adult_override,
          extra_child: base.extra_child_override,
          extra_infant: base.extra_infant_override,
          charge_frequency: base.charge_frequency_override,
        },
        property,
      ),
    [base, property],
  );
  const { errors: occupancyErrors, warnings } = validateRoomOccupancy({
    maxOccupancy: base.max_occupancy,
    maxAdults: base.max_adults,
    maxChildren: base.max_children,
    maxInfants: base.max_infants,
    defaultOccupancy: base.default_occupancy,
    includedOccupancy: base.included_occupancy,
    mode: base.extra_guest_pricing_mode,
    extra_adult: isOverride ? base.extra_adult_override : null,
    extra_child: isOverride ? base.extra_child_override : null,
    extra_infant: isOverride ? base.extra_infant_override : null,
    published,
    propertyConfigured: property.configured,
  });

  const requiredErrors: string[] = [];
  if (!base.room_number.trim()) requiredErrors.push("נדרש מספר חדר");
  if (!trs.he.name.trim()) requiredErrors.push("נדרש שם חדר בעברית");
  const blocked = requiredErrors.length > 0 || occupancyErrors.length > 0;

  const payload = () => ({
    id: roomId ?? undefined,
    room_number: base.room_number.trim(),
    room_type_id: base.room_type_id,
    area_id: base.area_id,
    floor: base.floor.trim() || null,
    status: base.status,
    is_active: base.is_active,
    show_on_website: base.show_on_website,
    sort_order: base.sort_order,
    size_sqm: base.size_sqm,
    max_occupancy: base.max_occupancy,
    max_adults: base.max_adults,
    max_children: base.max_children,
    max_infants: base.max_infants,
    default_occupancy: base.default_occupancy,
    included_occupancy: base.included_occupancy,
    extra_guest_pricing_mode: base.extra_guest_pricing_mode,
    extra_adult_override: base.extra_adult_override,
    extra_child_override: base.extra_child_override,
    extra_infant_override: base.extra_infant_override,
    charge_frequency_override: base.charge_frequency_override,
    single_beds: base.single_beds,
    double_beds: base.double_beds,
    queen_beds: base.queen_beds,
    sofa_beds: base.sofa_beds,
    cribs: base.cribs,
    amenity_ids: amenityIds,
    // only languages the user touched — never overwrites the others
    translations: Object.fromEntries(
      [...dirtyLangs.current].map((l) => {
        const t = trs[l];
        return [
          l,
          {
            name: t.name.trim() || null,
            description: t.description.trim() || null,
            summary: t.summary.trim() || null,
            slug: t.slug.trim() || null,
            seo_title: t.seo_title.trim() || null,
            meta_description: t.meta_description.trim() || null,
            og_title: t.og_title.trim() || null,
            og_description: t.og_description.trim() || null,
            noindex: t.noindex,
          },
        ];
      }),
    ),
  });

  const save = (opts: { close: boolean; after?: (id: string) => void }) =>
    startSaving(async () => {
      const res = await saveRoomAction(payload());
      if (!res.success) return void toast.error(res.error);
      const id = res.id ?? roomId;
      if (id && imagesDirty.current) {
        const metaRes = await updateRoomImagesAction(
          id,
          images.map((img, i) => ({ id: img.id, alt_text: img.alt_text || null, is_main: img.is_main, sort_order: i })),
        );
        if (!metaRes.success) return void toast.error(metaRes.error);
        imagesDirty.current = false;
      }
      if (id) setRoomId(id);
      toast.success("החדר נשמר");
      router.refresh();
      if (opts.close) onClose();
      else if (id) opts.after?.(id);
    });

  const goNext = () => {
    if (step === 1 && blocked) {
      toast.error(requiredErrors[0] ?? occupancyErrors[0]);
      return;
    }
    // create-mode: persist on leaving step 1 so image upload has a room id
    if (step === 1 && !roomId) return save({ close: false, after: () => setStep(2) });
    setStep((s) => (s === 3 ? 3 : ((s + 1) as 2 | 3)));
  };

  const copyFromLang = (src: Lang) => {
    const s = trs[src];
    dirtyLangs.current.add(lang);
    setTrs((prev) => ({
      ...prev,
      [lang]: { ...s, slug: "" }, // slug is unique per language — never copied
    }));
    toast.success(`הועתק מ${LANG_META[src].label} — שמרו כדי להחיל`);
  };

  const doDuplicate = () =>
    startSaving(async () => {
      if (!roomId) return;
      const res = await duplicateRoomAction(roomId);
      if (!res.success) return void toast.error(res.error);
      toast.success("החדר שוכפל");
      router.refresh();
      onClose();
    });

  const doDelete = () =>
    startSaving(async () => {
      if (!roomId) return;
      if (!window.confirm("למחוק את החדר? היסטוריית הזמנות עבר נשמרת, אך התוכן והתמונות יימחקו.")) return;
      const res = await deleteRoomAction(roomId);
      if (!res.success) return void toast.error(res.error);
      toast.success("החדר נמחק");
      router.refresh();
      onClose();
    });

  const allAmenities = [...amenities, ...customAmenities];

  return (
    <SidePanel
      open
      onClose={onClose}
      title={roomId ? `עריכת חדר ${base.room_number}` : "הקמת חדר"}
      subtitle="הגדרת פרטי חדר, איבזור ותוכן"
      icon="rooms"
      band={<Stepper step={step} onStep={(s) => (roomId ? setStep(s) : s === 1 && setStep(1))} />}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-faint">שלב {step} מתוך 3{warnings[0] ? ` · ${warnings[0]}` : ""}</span>
          <div className="flex gap-2">
            <button type="button" className="bw-btn bw-btn-o" onClick={onClose}>ביטול</button>
            {step > 1 && (
              <button type="button" className="bw-btn bw-btn-o" onClick={() => setStep((s) => (s === 1 ? 1 : ((s - 1) as 1 | 2)))}>
                חזרה
              </button>
            )}
            {step < 3 ? (
              <button type="button" className="bw-btn bw-btn-primary" disabled={saving} onClick={goNext}>
                הבא
                <Icon name="chevron-left" size={16} />
              </button>
            ) : (
              <button type="button" className="bw-btn bw-btn-primary" disabled={saving || blocked} onClick={() => save({ close: true })}>
                <Icon name="check" size={16} />
                {saving ? "שומר…" : "שמירה"}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {/* language tabs + room-level actions */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1 rounded-xl border border-line bg-surface p-1">
            {ALL_LANGS.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`flex min-h-9 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${
                  lang === l ? "bg-primary text-white" : "text-text2 hover:bg-hover"
                }`}
              >
                <span className="text-[10px] opacity-70">{LANG_META[l].tag}</span>
                {LANG_META[l].label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyFromMenu current={lang} onCopy={copyFromLang} />
            {roomId && can.create && (
              <button type="button" className="bw-btn bw-btn-o" disabled={saving} onClick={doDuplicate}>
                <Icon name="copy" size={14} />
                שכפל חדר
              </button>
            )}
            {roomId && can.del && (
              <button
                type="button"
                className="bw-btn bw-btn-o text-status-danger"
                style={{ borderColor: "var(--color-status-danger-050)", background: "var(--color-status-danger-050)" }}
                disabled={saving}
                onClick={doDelete}
              >
                <Icon name="trash" size={14} />
                מחק חדר
              </button>
            )}
          </div>
        </div>

        {step === 1 && (
          <>
            <section className="bw-card">
              <div className="mb-1 flex items-center justify-between">
                <CardTitle icon="info" title="פרטים כלליים" />
                <span className="text-xs text-faint">עריכה בשפה: {LANG_META[lang].label}</span>
              </div>
              <div className="bw-grid2">
                <Field label="שם החדר *">
                  <input
                    className="bw-fld"
                    dir={lang === "en" ? "ltr" : "rtl"}
                    placeholder="לדוגמה: סוויטת פרימיום פנטהאוס עם נוף לים"
                    value={tr.name}
                    onChange={(e) => setT("name", e.target.value)}
                  />
                </Field>
                <Field label="מספר חדר *">
                  <input
                    className="bw-fld"
                    dir="ltr"
                    placeholder="לדוגמה: 101"
                    value={base.room_number}
                    onChange={(e) => setB("room_number", e.target.value)}
                  />
                </Field>
                <Field label="סוג חדר">
                  <select className="bw-fld" value={base.room_type_id ?? ""} onChange={(e) => setB("room_type_id", e.target.value || null)}>
                    <option value="">בחר סוג חדר</option>
                    {roomTypes.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="בניין / אגף">
                  <select className="bw-fld" value={base.area_id ?? ""} onChange={(e) => setB("area_id", e.target.value || null)}>
                    <option value="">ללא</option>
                    {buildings.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="קומה">
                  <input
                    className="bw-fld"
                    dir="ltr"
                    placeholder="לדוגמה: 1 (0 = קרקע)"
                    value={base.floor}
                    onChange={(e) => setB("floor", e.target.value)}
                  />
                </Field>
              </div>
              <div className="mt-3 flex flex-col gap-3">
                <CountedTextarea
                  label="תיאור החדר"
                  placeholder="תיאור מפורט של החדר או האירוח…"
                  value={tr.description}
                  max={4000}
                  rows={5}
                  onChange={(v) => setT("description", v)}
                />
                <CountedTextarea
                  label="תקציר SEO / Meta Summary"
                  placeholder="תקציר קצר לתוצאות חיפוש…"
                  value={tr.summary}
                  max={200}
                  rows={2}
                  hint="יעד: 80–140 תווים"
                  onChange={(v) => setT("summary", v)}
                />
              </div>
            </section>

            <section className="bw-card">
              <CardTitle icon="users-round" title="תפוסה" />
              <div className="bw-grid2">
                <StepField label="תפוסת ברירת מחדל" value={base.default_occupancy} nullable onChange={(v) => setB("default_occupancy", v)} />
                <StepField label="תפוסה מקסימלית" value={base.max_occupancy} min={1} onChange={(v) => setB("max_occupancy", v ?? 1)} />
                <StepField label="אורחים הכלולים במחיר הבסיס" value={base.included_occupancy} nullable onChange={(v) => setB("included_occupancy", v)} />
                <StepField label="מקסימום מבוגרים" value={base.max_adults} onChange={(v) => setB("max_adults", v ?? 0)} />
                <StepField label="מקסימום ילדים" value={base.max_children} hint={base.max_children === 0 ? "החדר אינו מאפשר ילדים" : undefined} onChange={(v) => setB("max_children", v ?? 0)} />
                <StepField label="מקסימום תינוקות" value={base.max_infants} hint={base.max_infants === 0 ? "החדר אינו מאפשר תינוקות" : undefined} onChange={(v) => setB("max_infants", v ?? 0)} />
              </div>
              <p className="bw-hint">
                ״אורחים הכלולים במחיר הבסיס״ קובע מאיזה אורח מתחיל חיוב נוסף (ערך 2 → חיוב מהאורח השלישי).
              </p>
            </section>

            <section className="bw-card">
              <div className="mb-3 flex items-center justify-between">
                <CardTitle icon="finance" title="תמחור אורח נוסף" />
                <Segmented
                  ariaLabel="מצב תמחור"
                  value={base.extra_guest_pricing_mode}
                  onChange={(v) => setB("extra_guest_pricing_mode", v)}
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
                  <p className="bw-hint">
                    {property.configured
                      ? "החדר יורש את ערכי הנכס. ״חריגה לחדר״ מאפשרת עריכה — ערכי הנכס לא יועתקו לחדר."
                      : "תמחור הנכס טרם הוגדר. הגדירו בהגדרות ← תמחור תפוסה, או קבעו חריגה לחדר זה."}
                  </p>
                </div>
              ) : (
                <div className="bw-grid2">
                  <MoneyField label="אורח בוגר נוסף" currency={currency} value={base.extra_adult_override} onChange={(v) => setB("extra_adult_override", v)} />
                  <MoneyField label="ילד נוסף" currency={currency} value={base.extra_child_override} onChange={(v) => setB("extra_child_override", v)} />
                  <MoneyField label="תינוק נוסף" currency={currency} value={base.extra_infant_override} onChange={(v) => setB("extra_infant_override", v)} />
                  <Field label="תדירות חיוב">
                    <Segmented
                      ariaLabel="תדירות חריגה"
                      value={base.charge_frequency_override ?? "per_night"}
                      onChange={(v) => setB("charge_frequency_override", v)}
                      options={[
                        { value: "per_night", label: "לכל לילה" },
                        { value: "per_stay", label: "לכל השהות" },
                      ]}
                    />
                  </Field>
                </div>
              )}
            </section>

            <section className="bw-card">
              <CardTitle icon="settings" title="סטטוס וזמינות" />
              <div className="flex flex-col gap-3">
                <Field label="סטטוס חדר">
                  <select className="bw-fld" value={base.status} onChange={(e) => setB("status", e.target.value as BaseDraft["status"])}>
                    <option value="available">זמין</option>
                    <option value="out_of_order">חסימה זמנית</option>
                    <option value="inactive">בשיפוץ</option>
                  </select>
                </Field>
                <p className="bw-hint">חדר פעיל — זמין להזמנות · לחסימה זמנית (תחזוקה, ניקיון יסודי וכד׳) — ניהול חסימות</p>
                <div className="bw-grid2">
                  <ToggleCard label="חדר פעיל" hint="חדר זמין להזמנות" checked={base.is_active} onChange={(v) => setB("is_active", v)} />
                  <ToggleCard label="מוצג באתר" hint="חדר נראה לאורחים" checked={base.show_on_website} onChange={(v) => setB("show_on_website", v)} />
                </div>
                <StepField label="סדר מיון" value={base.sort_order} onChange={(v) => setB("sort_order", v ?? 0)} />
              </div>
            </section>
          </>
        )}

        {step === 2 && (
          <>
            <AmenitiesSection
              all={allAmenities}
              selected={amenityIds}
              onToggle={(id) =>
                setAmenityIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
              }
              onAdd={async (label) => {
                const res = await addAmenityAction(label);
                if (!res.success) return void toast.error(res.error);
                if (!res.id) return;
                const id = res.id;
                setCustomAmenities((s) => [...s, { id, key: "custom", label }]);
                setAmenityIds((s) => [...s, id]);
              }}
            />

            <section className="bw-card">
              <CardTitle icon="rooms" title="הסדרי שינה וגודל" />
              <div className="bw-grid2">
                <StepField label="מיטות יחיד" value={base.single_beds} onChange={(v) => setB("single_beds", v ?? 0)} />
                <StepField label="מיטות זוגיות" value={base.double_beds} onChange={(v) => setB("double_beds", v ?? 0)} />
                <StepField label="מיטות קווין" value={base.queen_beds} onChange={(v) => setB("queen_beds", v ?? 0)} />
                <StepField label="ספות נפתחות" value={base.sofa_beds} onChange={(v) => setB("sofa_beds", v ?? 0)} />
                <StepField label="עריסות (לתינוק)" value={base.cribs} onChange={(v) => setB("cribs", v ?? 0)} />
                <Field label="גודל החדר (מ״ר)">
                  <input
                    className="bw-fld"
                    dir="ltr"
                    inputMode="decimal"
                    placeholder="לדוגמה: 32"
                    value={base.size_sqm ?? ""}
                    onChange={(e) => {
                      const s = e.target.value.trim();
                      const n = Number(s);
                      setB("size_sqm", s === "" || !Number.isFinite(n) ? null : n);
                    }}
                  />
                </Field>
              </div>
            </section>

            <ImagesSection
              roomId={roomId}
              images={images}
              onChange={(next) => {
                imagesDirty.current = true;
                setImages(next);
              }}
              onUploaded={(img) => setImages((s) => [...s, img])}
              onDeleted={(id) => setImages((s) => s.filter((i) => i.id !== id))}
            />
          </>
        )}

        {step === 3 && (
          <>
            <section className="bw-card">
              <div className="mb-1 flex items-center justify-between">
                <CardTitle icon="link" title="הגדרות SEO" />
                <span className="text-xs text-faint">עריכה בשפה: {LANG_META[lang].label}</span>
              </div>
              <div className="flex flex-col gap-3">
                <Field label="כתובת URL (Slug) — ייחודית לכל שפה">
                  <div className="flex gap-2">
                    <input
                      className="bw-fld"
                      dir="ltr"
                      placeholder="premium-suite-sea-view"
                      value={tr.slug}
                      onChange={(e) => setT("slug", e.target.value)}
                    />
                    <button
                      type="button"
                      className="bw-btn bw-btn-o shrink-0"
                      onClick={() => setT("slug", slugify(tr.name))}
                      title="יצירה אוטומטית מהשם"
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  </div>
                </Field>
                <p className="bw-hint" dir="ltr">/{lang}/rooms/{tr.slug || "…"}</p>
                <CountedTextarea
                  label="כותרת SEO (Title Tag)"
                  placeholder="כותרת המופיעה בתוצאות חיפוש…"
                  value={tr.seo_title}
                  max={160}
                  rows={1}
                  hint="מומלץ עד 60 תווים"
                  onChange={(v) => setT("seo_title", v)}
                />
                <CountedTextarea
                  label="תיאור SEO (Meta Description)"
                  placeholder="תיאור קצר המופיע בתוצאות גוגל…"
                  value={tr.meta_description}
                  max={320}
                  rows={2}
                  hint="מומלץ 120–160 תווים"
                  onChange={(v) => setT("meta_description", v)}
                />
                <div className="bw-grid2">
                  <Field label="כותרת לשיתוף (OG Title)">
                    <input className="bw-fld" value={tr.og_title} onChange={(e) => setT("og_title", e.target.value)} />
                  </Field>
                  <Field label="תיאור לשיתוף (OG Description)">
                    <input className="bw-fld" value={tr.og_description} onChange={(e) => setT("og_description", e.target.value)} />
                  </Field>
                </div>
                <ToggleCard
                  label="מוסתר ממנועי חיפוש (noindex)"
                  hint="העמוד לא יופיע בתוצאות חיפוש בשפה זו"
                  checked={tr.noindex}
                  onChange={(v) => setT("noindex", v)}
                />
              </div>
            </section>

            <section className="bw-card">
              <CardTitle icon="search" title="תצוגה בתוצאות חיפוש" />
              <div className="rounded-xl border border-line bg-surface px-4 py-3" dir={lang === "he" || lang === "ar" ? "rtl" : "ltr"}>
                <p className="truncate text-base font-semibold" style={{ color: "#1a0dab" }}>
                  {tr.seo_title || tr.name || "כותרת העמוד"}
                </p>
                <p className="truncate text-xs" style={{ color: "#006621" }} dir="ltr">
                  {`example.com/${lang}/rooms/${tr.slug || slugify(tr.name) || "room"}`}
                </p>
                <p className="line-clamp-2 text-sm text-text2">
                  {tr.meta_description || tr.summary || "תיאור העמוד יופיע כאן…"}
                </p>
              </div>
            </section>

            <section className="bw-card">
              <CardTitle icon="languages" title="מצב השלמת שפות" />
              <div className="flex flex-col gap-2">
                {ALL_LANGS.map((l) => {
                  const t = trs[l];
                  const done = Boolean(t.name && t.seo_title && t.meta_description);
                  return (
                    <div key={l} className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-2.5">
                      <span className="text-sm font-semibold text-ink">{LANG_META[l].label}</span>
                      <span className={`flex items-center gap-1.5 text-xs font-semibold ${done ? "text-status-success" : "text-status-warning"}`}>
                        <Icon name={done ? "check" : "warning"} size={14} />
                        {done ? "הושלם" : "שם · כותרת SEO · תיאור SEO"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {(requiredErrors.length > 0 || occupancyErrors.length > 0) && (
              <section className="bw-card">
                <CardTitle icon="warning" title="סיכום אימות" />
                {[...requiredErrors, ...occupancyErrors].map((e, i) => (
                  <p key={i} className="flex items-center gap-2 text-sm text-status-danger">
                    <Icon name="warning" size={14} /> {e}
                  </p>
                ))}
              </section>
            )}
          </>
        )}

        {step === 1 && occupancyErrors.length > 0 && (
          <section className="bw-card">
            {occupancyErrors.map((e, i) => (
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

// ---------- step 2 sections ----------

function AmenitiesSection({
  all,
  selected,
  onToggle,
  onAdd,
}: {
  all: AmenityOption[];
  selected: string[];
  onToggle: (id: string) => void;
  onAdd: (label: string) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const needle = q.trim().toLowerCase();
  const visible = needle ? all.filter((a) => a.label.toLowerCase().includes(needle)) : all;
  return (
    <section className="bw-card">
      <CardTitle icon="star" title="איבזור ושירותים" />
      <div className="flex flex-col gap-3">
        <input
          className="bw-fld"
          placeholder="חיפוש איבזור…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {visible.map((a) => {
            const on = selected.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onToggle(a.id)}
                className={`flex min-h-10 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-semibold transition-colors ${
                  on ? "border-primary bg-primary-050 text-primary" : "border-line bg-surface text-text2 hover:bg-hover"
                }`}
              >
                {on && <Icon name="check" size={14} />}
                {a.label}
              </button>
            );
          })}
          {visible.length === 0 && <p className="text-sm text-faint">לא נמצא איבזור תואם.</p>}
        </div>
        <div className="flex gap-2">
          <input
            className="bw-fld"
            placeholder="איבזור מותאם אישית…"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button
            type="button"
            className="bw-btn bw-btn-o shrink-0"
            disabled={!newLabel.trim()}
            onClick={async () => {
              await onAdd(newLabel.trim());
              setNewLabel("");
            }}
          >
            <Icon name="plus" size={14} />
            הוסף
          </button>
        </div>
      </div>
    </section>
  );
}

function ImagesSection({
  roomId,
  images,
  onChange,
  onUploaded,
  onDeleted,
}: {
  roomId: string | null;
  images: RoomImage[];
  onChange: (next: RoomImage[]) => void;
  onUploaded: (img: RoomImage) => void;
  onDeleted: (id: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length || !roomId) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("roomId", roomId);
        form.set("file", file);
        const res = await fetch("/api/rooms/images", { method: "POST", body: form });
        const data = (await res.json()) as { image?: RoomImage; error?: string };
        if (!res.ok || !data.image) {
          toast.error(data.error ?? "העלאה נכשלה");
          continue;
        }
        onUploaded(data.image);
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...images];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  return (
    <section className="bw-card">
      <CardTitle icon="documents" title="תמונות" />
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={!roomId || uploading}
          onClick={() => fileRef.current?.click()}
          className="flex min-h-[96px] flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line bg-surface p-4 text-sm text-faint hover:border-primary hover:text-primary disabled:opacity-50"
        >
          <Icon name="plus" size={20} />
          {uploading ? "מעלה…" : "גררו לכאן את התמונה הראשית או לחצו לבחירה"}
          <span className="text-xs">JPG, PNG, WEBP · עד 20 תמונות · עד 15MB לתמונה · מומלץ 1600×900</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(e) => upload(e.target.files)}
        />
        <p className="bw-hint">התמונה הראשית מוצגת באתר ובתוצאות החיפוש.</p>

        {images.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {images.map((img, i) => (
              <div key={img.id} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.alt_text ?? ""} className="h-32 w-full rounded-lg object-cover" />
                <input
                  className="bw-fld"
                  placeholder="טקסט חלופי (Alt) לתמונה…"
                  value={img.alt_text ?? ""}
                  onChange={(e) =>
                    onChange(images.map((x) => (x.id === img.id ? { ...x, alt_text: e.target.value } : x)))
                  }
                />
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold ${
                      img.is_main ? "bg-primary-050 text-primary" : "text-text2 hover:bg-hover"
                    }`}
                    onClick={() =>
                      onChange(images.map((x) => ({ ...x, is_main: x.id === img.id })))
                    }
                  >
                    <Icon name="star" size={12} />
                    {img.is_main ? "תמונה ראשית" : "קבע כראשית"}
                  </button>
                  <div className="flex gap-1">
                    <IconBtn label="הזז ימינה" icon="chevron-right" onClick={() => move(i, -1)} />
                    <IconBtn label="הזז שמאלה" icon="chevron-left" onClick={() => move(i, 1)} />
                    <IconBtn
                      label="מחיקת תמונה"
                      icon="trash"
                      onClick={async () => {
                        const res = await deleteRoomImageAction(img.id);
                        if (!res.success) return void toast.error(res.error);
                        onDeleted(img.id);
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- small shared bits ----------

function Stepper({ step, onStep }: { step: 1 | 2 | 3; onStep: (s: 1 | 2 | 3) => void }) {
  const steps: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: "פרטים כלליים" },
    { n: 2, label: "איבזור ותמונות" },
    { n: 3, label: "אתר / SEO" },
  ];
  return (
    <div className="flex items-center justify-center gap-2 py-1" dir="rtl">
      {steps.map((s, i) => (
        <span key={s.n} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onStep(s.n)}
            className={`flex min-h-9 items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${
              step === s.n ? "bg-white/20 text-white" : "text-white/70 hover:text-white"
            }`}
          >
            <span
              className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${
                step >= s.n ? "bg-white text-primary" : "border border-white/50 text-white/80"
              }`}
            >
              {s.n}
            </span>
            {s.label}
          </button>
          {i < steps.length - 1 && <span className="h-px w-6 bg-white/40" />}
        </span>
      ))}
    </div>
  );
}

function CopyFromMenu({ current, onCopy }: { current: Lang; onCopy: (src: Lang) => void }) {
  const [open, setOpen] = useState(false);
  const others = ALL_LANGS.filter((l) => l !== current);
  return (
    <span className="relative">
      <button type="button" className="bw-btn bw-btn-o" onClick={() => setOpen((s) => !s)}>
        <Icon name="languages" size={14} />
        שכפל משפה אחרת
      </button>
      {open && (
        <span className="absolute end-0 top-full z-10 mt-1 flex min-w-36 flex-col rounded-xl border border-line bg-surface p-1 shadow-pop">
          {others.map((l) => (
            <button
              key={l}
              type="button"
              className="rounded-lg px-3 py-2 text-start text-sm text-text2 hover:bg-hover"
              onClick={() => {
                onCopy(l);
                setOpen(false);
              }}
            >
              {LANG_META[l].label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function IconBtn({ label, icon, onClick }: { label: string; icon: "chevron-right" | "chevron-left" | "trash"; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid h-8 w-8 place-items-center rounded-lg text-text2 hover:bg-hover"
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function ToggleCard({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{label}</p>
        <p className="text-xs text-faint">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function StepField({
  label,
  value,
  onChange,
  min = 0,
  nullable,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  nullable?: boolean;
  hint?: string;
}) {
  const shown = value ?? (nullable ? null : min);
  return (
    <Field label={label}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`הפחתת ${label}`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line text-text2 hover:bg-hover"
          onClick={() => onChange(Math.max(min, (shown ?? min) - 1))}
        >
          <Icon name="minus" size={14} />
        </button>
        <input
          className="bw-fld text-center"
          dir="ltr"
          inputMode="numeric"
          placeholder={nullable ? "טרם הוגדר" : undefined}
          value={shown ?? ""}
          onChange={(e) => {
            const s = e.target.value.trim();
            if (s === "") return onChange(nullable ? null : min);
            const n = parseInt(s, 10);
            onChange(Number.isFinite(n) ? Math.max(min, n) : nullable ? null : min);
          }}
        />
        <button
          type="button"
          aria-label={`הוספת ${label}`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line text-text2 hover:bg-hover"
          onClick={() => onChange((shown ?? min) + 1)}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {hint ? <p className="mt-1 text-xs text-faint">{hint}</p> : null}
    </Field>
  );
}

function CountedTextarea({
  label,
  placeholder,
  value,
  max,
  rows,
  hint,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  max: number;
  rows: number;
  hint?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <textarea
        className="bw-fld min-h-0 resize-y"
        style={{ height: "auto" }}
        rows={rows}
        maxLength={max}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="mt-1 flex justify-between text-xs text-faint">
        <span>{hint ?? ""}</span>
        <span dir="ltr">{value.length} / {max}</span>
      </p>
    </Field>
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
