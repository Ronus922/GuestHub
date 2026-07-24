"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
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

// ============================================================
// Room window — ported 1:1 from ref/html/WindowNewRoom.html +
// ref/screens/WindowAddRoom.png (D49). ONE shared form for create + edit:
// 60vw drawer, white steps strip, three steps (פרטים כלליים / איבזור ותמונות /
// אתר-SEO), reference cards/fields/counters/steppers. Persistence goes through
// saveRoomAction (canonical occupancy + extra-guest pricing seam preserved).
// ============================================================

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

// reference counters: description 724, summary 140 (target 80–140), SEO 60/160
const DESC_MAX = 724;
const SUMMARY_MAX = 140;
const SEO_TITLE_MAX = 60;
const SEO_DESC_MAX = 160;

// Canonical floor options for the room create/edit wizard (one shared source —
// RoomWizard is the single form used for both create and edit). Offers 5–16 only.
// Legacy rooms whose floor falls outside this range still DISPLAY via the select's
// fallback <option> below, but out-of-range floors are never offered as new choices.
const FLOOR_OPTIONS = ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"];
const floorLabel = (f: string) => (f === "0" ? "קרקע" : `קומה ${f}`);

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
  show_on_calendar: boolean;
  sort_order: number;
  size_sqm: number | null;
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
  min_occupancy: number | null;
  default_occupancy: number | null;
  included_occupancy: number | null;
  notes: string;
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
    show_on_calendar: room?.show_on_calendar ?? true,
    sort_order: room?.sort_order ?? 0,
    size_sqm: room?.size_sqm ?? null,
    max_occupancy: room?.max_occupancy ?? 2,
    max_adults: room?.max_adults ?? 2,
    max_children: room?.max_children ?? 0,
    max_infants: room?.max_infants ?? 0,
    min_occupancy: room?.min_occupancy ?? 1,
    default_occupancy: room?.default_occupancy ?? null,
    included_occupancy: room?.included_occupancy ?? null,
    notes: room?.notes ?? "",
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
  // in-flight image uploads block save/close so a batch is never half-persisted
  const [uploading, setUploading] = useState(false);

  // Save/close must wait for in-flight uploads — closing mid-batch would abandon
  // images the user selected. Guarded so the X/backdrop/cancel can't skip it.
  const closeGuarded = () => {
    if (uploading) return void toast.error("המתן לסיום העלאת התמונות");
    onClose();
  };

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
    minOccupancy: base.min_occupancy,
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
    show_on_calendar: base.show_on_calendar,
    sort_order: base.sort_order,
    size_sqm: base.size_sqm,
    max_occupancy: base.max_occupancy,
    max_adults: base.max_adults,
    max_children: base.max_children,
    max_infants: base.max_infants,
    min_occupancy: base.min_occupancy,
    default_occupancy: base.default_occupancy,
    included_occupancy: base.included_occupancy,
    notes: base.notes.trim() || null,
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
      if (
        !window.confirm(
          "מחיקה אפשרית רק לחדר שמעולם לא היה בשימוש (ללא הזמנות, ניקיון, חסימות או תמחור). לחדר עם היסטוריה — השביתו אותו במקום (חדר פעיל → כבוי). למחוק את החדר?",
        )
      )
        return;
      const res = await deleteRoomAction(roomId);
      if (!res.success) return void toast.error(res.error);
      toast.success("החדר נמחק");
      router.refresh();
      onClose();
    });

  const allAmenities = [...amenities, ...customAmenities];

  // language completion (reference: שם · כותרת SEO · תיאור SEO → N / 3 שדות)
  const langDone = (l: Lang) =>
    [trs[l].name.trim(), trs[l].seo_title.trim(), trs[l].meta_description.trim()].filter(Boolean).length;

  return (
    <SidePanel
      open
      onClose={closeGuarded}
      title={roomId ? `עריכת חדר ${base.room_number}` : "הקמת חדר"}
      subtitle="הגדרת פרטי חדר, איבזור ותוכן"
      icon="rooms"
      widthClassName="w-[60vw]"
      bodyClassName="p-4"
      band={<StepsBar step={step} onStep={(s) => (roomId ? setStep(s) : s === 1 && setStep(1))} />}
      footer={
        /* §7 footer — DIRECT children of .dw-ft (row-reverse): the PRIMARY is
           FIRST in the DOM and lands on the LEFT edge, "ביטול" to its right.
           No local flex wrapper — the shared .dw-ft rule owns the ordering. */
        <>
          {step < 3 ? (
            <button type="button" className="btn btn-primary" disabled={saving || uploading} onClick={goNext}>
              הבא
              <Icon name="chevron-left" size={20} />
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={saving || blocked || uploading} onClick={() => save({ close: true })}>
              <Icon name="check" size={20} />
              {saving ? "שומר…" : uploading ? "מעלה תמונות…" : "שמור"}
            </button>
          )}
          <button type="button" className="btn btn-tertiary" onClick={closeGuarded}>ביטול</button>
          {step > 1 && (
            <button type="button" className="btn btn-secondary" onClick={() => setStep((s) => (s === 1 ? 1 : ((s - 1) as 1 | 2)))}>
              חזרה
              <Icon name="chevron-right" size={20} />
            </button>
          )}
          <span className="flex-1" />
          <span className="rm-ftnote">
            <Icon name="info" size={17} />
            שלב {step} מתוך 3{warnings[0] ? ` · ${warnings[0]}` : ""}
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {/* language chips + room-level actions (reference row) */}
        <div className="flex flex-wrap items-center gap-2">
          {ALL_LANGS.map((l) => (
            /* .rm-opt: these pickers sit on WHITE surfaces where the transparent
               resting state of .chip.clickable has no visible boundary */
            <button key={l} type="button" onClick={() => setLang(l)} className={`chip clickable rm-opt${lang === l ? " on" : ""}`}>
              {LANG_META[l].label}
              <span className="rm-cc">{LANG_META[l].tag}</span>
            </button>
          ))}
          <span className="flex-1" />
          <CopyFromMenu current={lang} onCopy={copyFromLang} />
          {roomId && can.create && (
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={doDuplicate}>
              <Icon name="copy" size={20} />
              שכפל חדר
            </button>
          )}
          {roomId && can.del && (
            <button type="button" className="btn btn-danger" disabled={saving} onClick={doDelete}>
              <Icon name="trash" size={20} />
              מחק חדר
            </button>
          )}
        </div>

        {step === 1 && (
          <>
            <Sec icon="info" title="פרטים כלליים" note={`עריכה בשפה: ${LANG_META[lang].label}`}>
              <div className="rm-frow">
                <F label="שם החדר" required>
                  <input
                    className="field-input"
                    dir="auto"
                    placeholder="לדוגמה: סוויטת פרימיום פנטהאוס עם נוף לים"
                    value={tr.name}
                    onChange={(e) => setT("name", e.target.value)}
                  />
                </F>
                <F label="מספר חדר" required>
                  <input
                    className="field-input ltr-num text-end"
                    dir="ltr"
                    placeholder="לדוגמה: 101"
                    value={base.room_number}
                    onChange={(e) => setB("room_number", e.target.value)}
                  />
                </F>
              </div>
              <div className="rm-frow3">
                <F label="סוג חדר" required>
                  <select className="field-input" value={base.room_type_id ?? ""} onChange={(e) => setB("room_type_id", e.target.value || null)}>
                    <option value="">בחר סוג חדר</option>
                    {roomTypes.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </F>
                <F label="בניין / אגף">
                  <select className="field-input" value={base.area_id ?? ""} onChange={(e) => setB("area_id", e.target.value || null)}>
                    <option value="">בניין</option>
                    {buildings.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </F>
                <F label="קומה">
                  <select className="field-input" value={base.floor} onChange={(e) => setB("floor", e.target.value)}>
                    <option value="">קומה</option>
                    {!FLOOR_OPTIONS.includes(base.floor) && base.floor !== "" && (
                      <option value={base.floor}>{floorLabel(base.floor)}</option>
                    )}
                    {FLOOR_OPTIONS.map((f) => (
                      <option key={f} value={f}>{floorLabel(f)}</option>
                    ))}
                  </select>
                </F>
              </div>
              <RichTextArea
                label="תיאור החדר"
                placeholder="תיאור מפורט של החדר או האירוח…"
                value={tr.description}
                max={DESC_MAX}
                onChange={(v) => setT("description", v)}
              />
              <F label="תקציר SEO / Meta Summary">
                <textarea
                  className="field-input"
                  rows={2}
                  dir="auto"
                  maxLength={SUMMARY_MAX}
                  placeholder="תקציר קצר לתוצאות חיפוש…"
                  value={tr.summary}
                  onChange={(e) => setT("summary", e.target.value)}
                />
                <span className={`rm-cnt${tr.summary.length >= 80 && tr.summary.length <= 140 ? " ok" : ""}`} dir="rtl">
                  {tr.summary.length} / {SUMMARY_MAX} · יעד: 80–140 תווים
                </span>
              </F>
            </Sec>

            <Sec icon="users-round" title="תפוסה">
              <div className="rm-frow3">
                <QtyStep label="תפוסה מינימלית" value={base.min_occupancy} min={1} nullable onChange={(v) => setB("min_occupancy", v)} />
                <QtyStep label="תפוסת ברירת מחדל" value={base.default_occupancy} min={1} nullable onChange={(v) => setB("default_occupancy", v)} />
                <QtyStep label="תפוסה מקסימלית" value={base.max_occupancy} min={1} onChange={(v) => setB("max_occupancy", v ?? 1)} />
              </div>
              <div className="rm-frow3">
                <QtyStep label="מקסימום מבוגרים" value={base.max_adults} onChange={(v) => setB("max_adults", v ?? 0)} />
                <QtyStep label="מקסימום ילדים" value={base.max_children} hint={base.max_children === 0 ? "החדר אינו מאפשר ילדים" : undefined} onChange={(v) => setB("max_children", v ?? 0)} />
                <QtyStep label="מקסימום תינוקות" value={base.max_infants} hint={base.max_infants === 0 ? "החדר אינו מאפשר תינוקות" : undefined} onChange={(v) => setB("max_infants", v ?? 0)} />
              </div>
            </Sec>

            <Sec icon="finance" title="תמחור אורח נוסף">
              <div className="rm-frow">
                <QtyStep label="אורחים הכלולים במחיר הבסיס" value={base.included_occupancy} min={1} nullable onChange={(v) => setB("included_occupancy", v)} />
                <F label="מצב תמחור">
                  <Segmented
                    ariaLabel="מצב תמחור"
                    value={base.extra_guest_pricing_mode}
                    onChange={(v) => setB("extra_guest_pricing_mode", v)}
                    options={[
                      { value: "inherit", label: "ירושה מהנכס" },
                      { value: "override", label: "חריגה לחדר" },
                    ]}
                  />
                </F>
              </div>
              {!isOverride ? (
                <div className="flex flex-col gap-2">
                  <EffRow label="אורח בוגר נוסף" amount={effective.extra_adult.value} source={SOURCE_LABEL[effective.extra_adult.source]} currency={currency} />
                  <EffRow label="ילד נוסף" amount={effective.extra_child.value} source={SOURCE_LABEL[effective.extra_child.source]} currency={currency} />
                  <EffRow label="תינוק נוסף" amount={effective.extra_infant.value} source={SOURCE_LABEL[effective.extra_infant.source]} currency={currency} />
                  <p className="field-hint">
                    {property.configured
                      ? "״אורחים הכלולים במחיר הבסיס״ קובע מאיזה אורח מתחיל חיוב נוסף (ערך 2 → חיוב מהאורח השלישי). החדר יורש את ערכי הנכס."
                      : "תמחור הנכס טרם הוגדר. הגדירו בהגדרות ← תמחור תפוסה, או קבעו חריגה לחדר זה."}
                  </p>
                </div>
              ) : (
                <div className="rm-frow">
                  <MoneyField label="אורח בוגר נוסף" currency={currency} value={base.extra_adult_override} onChange={(v) => setB("extra_adult_override", v)} />
                  <MoneyField label="ילד נוסף" currency={currency} value={base.extra_child_override} onChange={(v) => setB("extra_child_override", v)} />
                  <MoneyField label="תינוק נוסף" currency={currency} value={base.extra_infant_override} onChange={(v) => setB("extra_infant_override", v)} />
                  <F label="תדירות חיוב">
                    <Segmented
                      ariaLabel="תדירות חריגה"
                      value={base.charge_frequency_override ?? "per_night"}
                      onChange={(v) => setB("charge_frequency_override", v)}
                      options={[
                        { value: "per_night", label: "לכל לילה" },
                        { value: "per_stay", label: "לכל השהות" },
                      ]}
                    />
                  </F>
                </div>
              )}
            </Sec>

            <Sec icon="filter" title="סטטוס וזמינות">
              <F label="סטטוס חדר">
                <select className="field-input" value={base.status} onChange={(e) => setB("status", e.target.value as BaseDraft["status"])}>
                  <option value="available">זמין</option>
                  <option value="out_of_order">חסימה זמנית</option>
                  <option value="inactive">בשיפוץ</option>
                </select>
                <span className="field-hint">חדר פעיל — זמין להזמנות · לחסימה זמנית (תחזוקה, ניקיון יסודי וכד׳) — ניהול חסימות</span>
              </F>
              <div className="rm-frow3">
                <SwRow label="חדר פעיל" hint="חדר זמין להזמנות" checked={base.is_active} onChange={(v) => setB("is_active", v)} />
                <SwRow label="מוצג באתר" hint="חדר נראה לאורחים" checked={base.show_on_website} onChange={(v) => setB("show_on_website", v)} />
                {/* display only — an OFF room stays bookable and counted (migration 053) */}
                <SwRow label="מוצג בלוח תפוסה" hint="החדר מופיע ביומן החדרים" checked={base.show_on_calendar} onChange={(v) => setB("show_on_calendar", v)} />
              </div>
              <F label="הערות פנימיות">
                <textarea
                  className="field-input"
                  rows={2}
                  placeholder="הערות פנימיות לצוות…"
                  value={base.notes}
                  onChange={(e) => setB("notes", e.target.value)}
                />
              </F>
            </Sec>

            {occupancyErrors.length > 0 && (
              <div className="rm-vlist">
                {occupancyErrors.map((e, i) => (
                  <p key={i} className="rm-vitem w">
                    <Icon name="warning" size={17} /> {e}
                  </p>
                ))}
              </div>
            )}
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
                setCustomAmenities((s) => [...s, { id, key: "custom", label, icon: null, group: null }]);
                setAmenityIds((s) => [...s, id]);
              }}
            />

            <Sec icon="rooms" title="הסדרי שינה וגודל">
              <div className="rm-frow3">
                <QtyStep label="מיטות יחיד" value={base.single_beds} onChange={(v) => setB("single_beds", v ?? 0)} />
                <QtyStep label="מיטות זוגיות" value={base.double_beds} onChange={(v) => setB("double_beds", v ?? 0)} />
                <QtyStep label="מיטות קווין" value={base.queen_beds} onChange={(v) => setB("queen_beds", v ?? 0)} />
                <QtyStep label="ספות נפתחות" value={base.sofa_beds} onChange={(v) => setB("sofa_beds", v ?? 0)} />
                <QtyStep label="עריסות (לתינוק)" value={base.cribs} onChange={(v) => setB("cribs", v ?? 0)} />
                <F label="גודל החדר (מ״ר)">
                  <input
                    className="field-input ltr-num"
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
                </F>
              </div>
            </Sec>

            <ImagesSection
              roomId={roomId}
              images={images}
              onUploadingChange={setUploading}
              onChange={(next) => {
                imagesDirty.current = true;
                setImages(next);
              }}
              onUploaded={(img) => setImages((s) => [...s, img])}
              onDeleted={(id, promotedId) =>
                setImages((s) => {
                  const next = s.filter((i) => i.id !== id);
                  // Mirror the EXACT row the server promoted (returned as
                  // promotedId) so a later metadata save can't overwrite the
                  // promoted main. No client-side guessing — server is the source
                  // of truth for the tiebreak. promotedId is null for a non-main
                  // or last-image delete, leaving the existing main untouched.
                  if (!promotedId) return next;
                  return next.map((i) => ({ ...i, is_main: i.id === promotedId }));
                })
              }
            />
          </>
        )}

        {step === 3 && (
          <>
            <Sec icon="globe" title="הגדרות SEO" note={`עריכה בשפה: ${LANG_META[lang].label}`}>
              <F label="כותרת SEO (Title Tag)">
                <input
                  className="field-input"
                  dir="auto"
                  maxLength={SEO_TITLE_MAX}
                  placeholder="כותרת המופיעה בתוצאות חיפוש…"
                  value={tr.seo_title}
                  onChange={(e) => setT("seo_title", e.target.value)}
                />
                <span className="rm-cnt" dir="rtl">{tr.seo_title.length} / {SEO_TITLE_MAX}</span>
              </F>
              <F label="תיאור SEO (Meta Description)">
                <textarea
                  className="field-input"
                  rows={3}
                  dir="auto"
                  maxLength={SEO_DESC_MAX}
                  placeholder="תיאור קצר המופיע בתוצאות גוגל…"
                  value={tr.meta_description}
                  onChange={(e) => setT("meta_description", e.target.value)}
                />
                <span className="rm-cnt" dir="rtl">{tr.meta_description.length} / {SEO_DESC_MAX}</span>
              </F>
            </Sec>

            <div className="rm-frow">
              <Sec icon="eye" title="תצוגה מקדימה באתר">
                <div className="rm-pvsite">
                  <div className="rm-im">
                    {images.find((i) => i.is_main) ?? images[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={(images.find((i) => i.is_main) ?? images[0]).url} alt="" />
                    ) : (
                      <Icon name="image" size={24} />
                    )}
                  </div>
                  <div className="rm-bd">
                    <div className="rm-nm">{tr.name || "שם החדר"}</div>
                    <div className="rm-ds">{tr.summary || "תקציר החדר…"}</div>
                    <div className="rm-mt">
                      {/* the phrase is ONE flex item — a bare <bdi> sibling would
                          become its own item and pick up the flex gap as spacing */}
                      <span className="inline-flex items-center gap-1.5">
                        <Icon name="users-round" size={17} />
                        <span>
                          עד <bdi className="ltr-num">{base.max_occupancy}</bdi> אורחים
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <Icon name="star" size={17} />
                        <span>
                          <bdi className="ltr-num">{amenityIds.length}</bdi> שירותים
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              </Sec>
              <Sec icon="search" title="תצוגה בתוצאות חיפוש">
                <div className="rm-pvg">
                  <div className="rm-u">www.yourhotel.com/rooms/{base.room_number || "101"}</div>
                  <div className="rm-t">{tr.seo_title || "כותרת SEO של החדר"}</div>
                  <div className="rm-d">{tr.meta_description || "תיאור SEO המופיע בתוצאות חיפוש של גוגל…"}</div>
                </div>
              </Sec>
            </div>

            <Sec icon="languages" title="מצב השלמת שפות" note="שם · כותרת SEO · תיאור SEO">
              <div className="rm-langst">
                {ALL_LANGS.map((l) => {
                  const n = langDone(l);
                  const cls = n === 3 ? "ok" : n > 0 ? "mid" : "no";
                  return (
                    <button key={l} type="button" className={`rm-lst${lang === l ? " on" : ""}`} onClick={() => setLang(l)}>
                      <div className="rm-cc">{LANG_META[l].tag}</div>
                      <div className="rm-nm">{LANG_META[l].label}</div>
                      <div className={`rm-st ${cls}`}>{n} / 3 שדות</div>
                    </button>
                  );
                })}
              </div>
            </Sec>

            <Sec icon="list-checks" title="סיכום אימות">
              <div className="rm-vlist">
                <VItem ok={Boolean(trs.he.name.trim())} okLabel="שם חדר הוגדר" missLabel="שם חדר חסר" />
                <VItem ok={Boolean(base.room_number.trim())} okLabel="מספר חדר הוגדר" missLabel="מספר חדר חסר" />
                <VItem ok={Boolean(base.room_type_id)} okLabel="סוג חדר נבחר" missLabel="סוג חדר לא נבחר" />
                <VItem ok={Boolean(tr.seo_title.trim())} okLabel="כותרת SEO הוגדרה" missLabel="כותרת SEO חסרה" />
                <VItem ok={Boolean(tr.meta_description.trim())} okLabel="תיאור SEO הוגדר" missLabel="תיאור SEO חסר" />
                <VItem ok={amenityIds.length > 0} okLabel={`${amenityIds.length} פריטי איבזור נבחרו`} missLabel="אין איבזור נבחר" />
                {occupancyErrors.map((e, i) => (
                  <p key={i} className="rm-vitem w">
                    <Icon name="warning" size={17} /> {e}
                  </p>
                ))}
              </div>
            </Sec>
          </>
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

  // group in catalog order (reference: חדר רחצה / בידור / כללי / מטבח / יוקרה)
  const groups: { name: string; items: AmenityOption[] }[] = [];
  for (const a of visible) {
    const name = a.group ?? "מותאם אישית";
    const g = groups.find((x) => x.name === name);
    if (g) g.items.push(a);
    else groups.push({ name, items: [a] });
  }

  return (
    <Sec icon="approve-requests" title="איבזור ושירותים" note={`${selected.length} פריטים נבחרו`}>
      <div className="field-input rm-search">
        <Icon name="search" size={20} />
        <input placeholder="חיפוש איבזור…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.map((g) => (
        <div key={g.name} className="contents">
          <div className="rm-agrp">{g.name}</div>
          <div className="rm-achips">
            {g.items.map((a) => {
              const on = selected.includes(a.id);
              return (
                /* .rm-opt: visible resting boundary on the white card body */
                <button key={a.id} type="button" onClick={() => onToggle(a.id)} className={`chip clickable rm-opt${on ? " on" : ""}`}>
                  {a.icon && <Icon name={a.icon as IconName} size={13.5} />}
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {visible.length === 0 && <p className="field-hint">לא נמצא איבזור תואם.</p>}
      <div className="rm-addrow">
        <input
          className="field-input"
          placeholder="הוסף איבזור חדש…"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!newLabel.trim()}
          onClick={async () => {
            await onAdd(newLabel.trim());
            setNewLabel("");
          }}
        >
          <Icon name="plus" size={20} />
          הוסף
        </button>
      </div>
    </Sec>
  );
}

function ImagesSection({
  roomId,
  images,
  onUploadingChange,
  onChange,
  onUploaded,
  onDeleted,
}: {
  roomId: string | null;
  images: RoomImage[];
  onUploadingChange: (v: boolean) => void;
  onChange: (next: RoomImage[]) => void;
  onUploaded: (img: RoomImage) => void;
  onDeleted: (id: string, promotedId: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Every selected file is uploaded sequentially and awaited, so the room is
  // never saved with a half-uploaded batch. Each success persists a row + file
  // server-side immediately; a failure is surfaced and the rest continue.
  const upload = async (files: FileList | null) => {
    if (!files?.length || !roomId) return;
    setUploading(true);
    onUploadingChange(true);
    let failed = 0;
    try {
      for (const file of Array.from(files)) {
        if (file.size > 15 * 1024 * 1024) {
          failed++;
          toast.error(`הקובץ "${file.name}" גדול מדי — עד 15MB לתמונה`);
          continue;
        }
        const form = new FormData();
        form.set("roomId", roomId);
        form.set("file", file);
        const res = await fetch("/api/rooms/images", { method: "POST", body: form });
        // The response isn't always JSON: a proxy can reject an oversized upload
        // with an HTML 413 page before it reaches the API. Parse defensively so we
        // surface a real error instead of throwing "Unexpected token '<'".
        let data: { image?: RoomImage; error?: string } = {};
        try {
          data = (await res.json()) as { image?: RoomImage; error?: string };
        } catch {
          /* non-JSON body (e.g. proxy 413/502 HTML page) */
        }
        if (!res.ok || !data.image) {
          failed++;
          toast.error(
            res.status === 413
              ? `הקובץ "${file.name}" גדול מדי — עד 15MB לתמונה`
              : data.error ?? "העלאה נכשלה",
          );
          continue;
        }
        onUploaded(data.image);
      }
      if (failed > 0) toast.error(`${failed} תמונות לא הועלו — נסו שוב`);
    } finally {
      setUploading(false);
      onUploadingChange(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Drag-and-drop routes through the same awaited upload path as the picker.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!roomId || uploading) return;
    void upload(e.dataTransfer.files);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (roomId && !uploading) setDragOver(true);
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...images];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  const main = images.find((i) => i.is_main) ?? images[0] ?? null;

  return (
    <Sec icon="image" title="תמונות" note="JPG, PNG, WEBP · עד 20 תמונות · עד 15MB לתמונה · מומלץ 1600×900">
      <div
        className={`rm-imgrow rounded-xl${dragOver ? " ring-2 ring-primary ring-offset-2" : ""}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
      >
        <button
          type="button"
          disabled={!roomId || uploading}
          onClick={() => fileRef.current?.click()}
          className="rm-imgslot"
          style={main ? { padding: 0, borderStyle: "solid", overflow: "hidden" } : undefined}
        >
          {main ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={main.url} alt={main.alt_text ?? ""} className="h-full min-h-[140px] w-full object-cover" />
          ) : (
            <>
              <Icon name="plus" size={20} />
              {uploading ? "מעלה…" : "גררו לכאן את התמונה הראשית או לחצו לבחירה"}
            </>
          )}
        </button>
        <button
          type="button"
          disabled={!roomId || uploading}
          onClick={() => fileRef.current?.click()}
          className="rm-imgslot"
        >
          <Icon name="plus" size={20} />
          {uploading ? "מעלה…" : "תמונת גלריה"}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => upload(e.target.files)}
      />
      {!roomId && <p className="field-hint">שמרו את שלב 1 כדי לאפשר העלאת תמונות.</p>}

      {images.length > 0 && (
        <div className="rm-imgtiles">
          {images.map((img, i) => (
            <div key={img.id} className="rm-imgtile">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.alt_text ?? ""} />
              <input
                className="field-input"
                placeholder="טקסט חלופי (Alt) לתמונה…"
                value={img.alt_text ?? ""}
                onChange={(e) =>
                  onChange(images.map((x) => (x.id === img.id ? { ...x, alt_text: e.target.value } : x)))
                }
              />
              <div className="rm-imgacts">
                <button
                  type="button"
                  /* .rm-opt: visible resting boundary on the white image tile */
                  className={`chip clickable rm-opt${img.is_main ? " on" : ""}`}
                  onClick={() => onChange(images.map((x) => ({ ...x, is_main: x.id === img.id })))}
                >
                  <Icon name="star" size={13.5} />
                  {img.is_main ? "תמונה ראשית" : "קבע כראשית"}
                </button>
                <div className="flex gap-1">
                  <IconBtn label="הזז ימינה" icon="chevron-right" disabled={uploading} onClick={() => move(i, -1)} />
                  <IconBtn label="הזז שמאלה" icon="chevron-left" disabled={uploading} onClick={() => move(i, 1)} />
                  <IconBtn
                    label="מחיקת תמונה"
                    icon="trash"
                    disabled={uploading}
                    onClick={async () => {
                      const res = await deleteRoomImageAction(img.id);
                      if (!res.success) return void toast.error(res.error);
                      onDeleted(img.id, res.data?.promotedId ?? null);
                      if (res.data?.orphanFile)
                        toast.warning("התמונה הוסרה מהחדר, אך מחיקת הקובץ מהאחסון נכשלה — ייתכן קובץ יתום");
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="rm-imgnote">התמונה הראשית מוצגת באתר ובתוצאות החיפוש</div>
    </Sec>
  );
}

// ---------- shared building blocks (canonical primitives, §5/§6) ----------

// section card — the canonical .card / .card-hd / .card-bd (§6)
export function Sec({
  icon,
  title,
  note,
  children,
}: {
  icon: IconName;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-hd">
        <Icon name={icon} size={20} className="text-primary" />
        <span>{title}</span>
        {note ? <span className="field-hint ms-auto">{note}</span> : null}
      </div>
      <div className="card-bd flex flex-col gap-4">{children}</div>
    </section>
  );
}

// field — the canonical .field / .field-label (§5): label ABOVE, 12px/700
export function F({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <span className="field-label">
        {label}
        {required && <span className="rm-req">*</span>}
      </span>
      {children}
    </div>
  );
}

function StepsBar({ step, onStep }: { step: 1 | 2 | 3; onStep: (s: 1 | 2 | 3) => void }) {
  const steps: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: "פרטים כלליים" },
    { n: 2, label: "איבזור ותמונות" },
    { n: 3, label: "אתר / SEO" },
  ];
  return (
    <div className="rm-steps" dir="rtl">
      {steps.map((s, i) => (
        <span key={s.n} className="contents">
          <button
            type="button"
            onClick={() => onStep(s.n)}
            className={`rm-stp${step === s.n ? " on" : step > s.n ? " done" : ""}`}
          >
            <span className="rm-n">{step > s.n ? <Icon name="check" size={17} /> : s.n}</span>
            <span className="rm-l">{s.label}</span>
          </button>
          {i < steps.length - 1 && <span className={`rm-stln${step > s.n ? " done" : ""}`} />}
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
      <button type="button" className="btn btn-secondary" onClick={() => setOpen((s) => !s)}>
        <Icon name="languages" size={20} />
        שכפל משפה אחרת
      </button>
      {open && (
        <span className="absolute end-0 top-full z-10 mt-1 flex min-w-36 flex-col rounded-xl border border-line bg-surface p-1 shadow-pop">
          {others.map((l) => (
            <button
              key={l}
              type="button"
              className="btn btn-sm btn-tertiary justify-start"
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

// icon-only control — the canonical .icon-btn (36×36, radius 10, 20px icon, §4)
function IconBtn({ label, icon, onClick, disabled }: { label: string; icon: "chevron-right" | "chevron-left" | "trash"; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" title={label} disabled={disabled} className="icon-btn" onClick={onClick}>
      <Icon name={icon} size={20} label={label} />
    </button>
  );
}

// reference sw-row: bordered row with title/hint + switch
function SwRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="rm-swrow">
      <div className="min-w-0 flex-1">
        <p className="rm-swt">{label}</p>
        <p className="rm-swd">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

// reference numeric stepper: [add][value][remove] — RTL puts + on the right
export function QtyStep({
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
    <div className="rm-occg">
      <span className="field-label">{label}</span>
      <span className="rm-step">
        <button type="button" aria-label={`הוספת ${label}`} onClick={() => onChange((shown ?? min) + 1)}>
          <Icon name="plus" size={20} />
        </button>
        <input
          className="rm-v"
          dir="ltr"
          inputMode="numeric"
          aria-label={label}
          placeholder={nullable ? "—" : undefined}
          value={shown ?? ""}
          onChange={(e) => {
            const s = e.target.value.trim();
            if (s === "") return onChange(nullable ? null : min);
            const n = parseInt(s, 10);
            onChange(Number.isFinite(n) ? Math.max(min, n) : nullable ? null : min);
          }}
        />
        <button type="button" aria-label={`הפחתת ${label}`} onClick={() => onChange(Math.max(min, (shown ?? min) - 1))}>
          <Icon name="minus" size={20} />
        </button>
      </span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

// rich-text toolbar (reference rtb) — wraps the selection with markdown markers
function RichTextArea({
  label,
  placeholder,
  value,
  max,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  max: number;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const wrap = (before: string, after = before) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const sel = value.slice(a, b) || "טקסט";
    onChange(value.slice(0, a) + before + sel + after + value.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + sel.length);
    });
  };
  const linePrefix = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const a = el.selectionStart;
    const lineStart = value.lastIndexOf("\n", a - 1) + 1;
    onChange(value.slice(0, lineStart) + prefix + value.slice(lineStart));
    requestAnimationFrame(() => el.focus());
  };

  const tools: { icon: IconName; title: string; run: () => void }[] = [
    { icon: "bold", title: "מודגש", run: () => wrap("**") },
    { icon: "italic", title: "נטוי", run: () => wrap("*") },
    { icon: "underline", title: "קו תחתון", run: () => wrap("__") },
  ];
  const tools2: { icon: IconName; title: string; run: () => void }[] = [
    { icon: "list", title: "רשימה", run: () => linePrefix("- ") },
    { icon: "list-ordered", title: "רשימה ממוספרת", run: () => linePrefix("1. ") },
  ];
  const tools3: { icon: IconName; title: string; run: () => void }[] = [
    { icon: "link", title: "קישור", run: () => wrap("[", "](url)") },
    { icon: "image", title: "תמונה", run: () => wrap("![", "](url)") },
  ];

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="rm-rtb">
        {tools.map((t) => (
          <button key={t.icon} type="button" className="icon-btn" title={t.title} onClick={t.run}>
            <Icon name={t.icon} size={20} label={t.title} />
          </button>
        ))}
        <span className="rm-sep" />
        {tools2.map((t) => (
          <button key={t.icon} type="button" className="icon-btn" title={t.title} onClick={t.run}>
            <Icon name={t.icon} size={20} label={t.title} />
          </button>
        ))}
        <span className="rm-sep" />
        {tools3.map((t) => (
          <button key={t.icon} type="button" className="icon-btn" title={t.title} onClick={t.run}>
            <Icon name={t.icon} size={20} label={t.title} />
          </button>
        ))}
      </div>
      <textarea
        ref={ref}
        className="field-input rm-rtxt"
        rows={5}
        dir="auto"
        maxLength={max}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="rm-cnt" dir="rtl">{value.length} / {max}</span>
    </div>
  );
}

function VItem({ ok, okLabel, missLabel }: { ok: boolean; okLabel: string; missLabel: string }) {
  return (
    <p className={`rm-vitem ${ok ? "ok" : "w"}`}>
      <Icon name={ok ? "check-circle" : "warning"} size={17} />
      {ok ? okLabel : missLabel}
    </p>
  );
}

function EffRow({ label, amount, source, currency }: { label: string; amount: number | null; source: string; currency: string }) {
  return (
    <div className="rm-swrow">
      <span className="rm-swt flex-1">{label}</span>
      <span className="text-sm">
        {amount === null ? (
          <span className="text-status-warning">טרם הוגדר</span>
        ) : (
          <strong className="ltr-num">{amount} {currency}</strong>
        )}
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
    <F label={`${label} (${currency})`}>
      <input
        className="field-input ltr-num"
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
    </F>
  );
}
