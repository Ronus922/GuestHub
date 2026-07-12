"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { PROPERTY_TYPES } from "@/lib/business/profile";
import { Field, FormGrid, SettingsCard } from "./controls";
import {
  getBusinessProfileContextAction,
  saveBusinessProfileAction,
  removeBusinessLogoAction,
  type BusinessProfileContext,
} from "./business-actions";
import { LocationPicker } from "./LocationPicker";

// פרופיל העסק — canonical Business/Property identity, separate from the GuestHub
// application brand. Identity + contact save through saveBusinessProfileAction;
// logo through /api/branding/logo; location through LocationPicker. Nothing here
// prefills "GuestHub" or an invented name — empty fields stay empty.

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  apartment: "דירה",
  hotel: "מלון",
  hostel: "הוסטל",
  guest_house: "בית הארחה",
  bed_and_breakfast: "לינה וארוחת בוקר",
  villa: "וילה",
  resort: "ריזורט",
  motel: "מוטל",
  boutique_hotel: "מלון בוטיק",
  cottage: "בקתה",
};

type IdentityForm = {
  businessName: string;
  slogan: string;
  propertyName: string;
  propertySubtitle: string;
  propertyType: string;
  email: string;
  phone: string;
  website: string;
};

function toForm(ctx: BusinessProfileContext): IdentityForm {
  const p = ctx.profile;
  return {
    businessName: p.businessName ?? "",
    slogan: p.slogan ?? "",
    propertyName: p.propertyName ?? "",
    propertySubtitle: p.propertySubtitle ?? "",
    propertyType: p.propertyType ?? "apartment",
    email: p.email ?? "",
    phone: p.phone ?? "",
    website: p.website ?? "",
  };
}

export function BusinessProfileSection({ initial }: { initial: BusinessProfileContext }) {
  const [ctx, setCtx] = useState(initial);
  const [form, setForm] = useState<IdentityForm>(toForm(initial));
  const [logo, setLogo] = useState<string | null>(initial.profile.logo);
  const [uploading, setUploading] = useState(false);
  const [saving, startSave] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(ctx));

  // Every save path (identity, logo, location) funnels through here. The action's
  // revalidatePath("/settings") only covers the page — the dashboard LAYOUT, which
  // renders the sidebar account card, is above it and is not re-rendered by a
  // Server Action. router.refresh() refetches the whole tree, so the sidebar picks
  // up the new property identity with no logout, hard refresh or redeploy.
  async function reload() {
    const res = await getBusinessProfileContextAction();
    if (res.success && res.data) {
      setCtx(res.data);
      setForm(toForm(res.data));
      setLogo(res.data.profile.logo);
    }
    router.refresh();
  }

  function set<K extends keyof IdentityForm>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function onSave() {
    startSave(async () => {
      const res = await saveBusinessProfileAction(form);
      if (!res.success) {
        toast.error(res.error ?? "אירעה שגיאה");
        return;
      }
      toast.success("פרטי העסק נשמרו");
      await reload();
    });
  }

  async function onUploadLogo(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/branding/logo", { method: "POST", body: fd });
      // The upload proxy can return a non-JSON 413 page; parse defensively.
      let body: { logo?: string; error?: string } = {};
      try {
        body = await res.json();
      } catch {
        body = { error: res.status === 413 ? "הקובץ גדול מדי" : "העלאה נכשלה" };
      }
      if (!res.ok || !body.logo) return toast.error(body.error ?? "העלאת הלוגו נכשלה");
      setLogo(body.logo);
      toast.success("הלוגו הועלה");
      await reload();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function onRemoveLogo() {
    startSave(async () => {
      const res = await removeBusinessLogoAction();
      if (!res.success) {
        toast.error(res.error ?? "אירעה שגיאה");
        return;
      }
      setLogo(null);
      toast.success("הלוגו הוסר");
      await reload();
    });
  }

  const { status } = ctx;

  return (
    <div className="flex flex-col gap-5" dir="rtl">
      {/* Identity note — GuestHub is the application, not the business */}
      <div className="flex items-start gap-2.5 rounded-xl border border-line bg-primary-050 p-3">
        <Icon name="info" size={17} className="mt-0.5 shrink-0 text-primary" />
        <p className="text-xs font-semibold leading-relaxed text-text2">
          GuestHub הוא שם מערכת הניהול בלבד. כאן מגדירים את זהות <strong>העסק</strong> ו<strong>הנכס</strong> הציבורית
          — השם המופיע ללקוחות, במסמכים, בהודעות ובחיבור לערוצי הזמנות. השם אינו נגזר אוטומטית משם המערכת.
        </p>
      </div>

      {/* completion + channel readiness */}
      <div className="grid gap-3 sm:grid-cols-2">
        <ChecklistCard title="פרטי עסק בסיסיים" items={status.businessItems} done={status.businessComplete} />
        <ChecklistCard title="מוכנות לחיבור ערוצים (Booking/Expedia)" items={status.channelItems} done={status.channelReady} />
      </div>

      {/* Business identity */}
      <SettingsCard icon="building" title="זהות העסק">
        <div className="flex flex-col gap-4">
          <LogoField
            logo={logo}
            uploading={uploading || saving}
            fileRef={fileRef}
            onPick={onUploadLogo}
            onRemove={onRemoveLogo}
          />
          <FormGrid>
            <Field label="שם העסק">
              <input className="field-input" value={form.businessName} maxLength={200}
                onChange={(e) => set("businessName", e.target.value)} placeholder="שם העסק הציבורי" />
            </Field>
            <Field label="סלוגן">
              <input className="field-input" value={form.slogan} maxLength={300}
                onChange={(e) => set("slogan", e.target.value)} placeholder="משפט תיאור קצר (אופציונלי)" />
            </Field>
          </FormGrid>
        </div>
      </SettingsCard>

      {/* Property identity */}
      <SettingsCard icon="hotel" title="זהות הנכס / מקום האירוח">
        <FormGrid>
          <Field label="שם הנכס / מקום האירוח">
            <input className="field-input" value={form.propertyName} maxLength={200}
              onChange={(e) => set("propertyName", e.target.value)} placeholder="השם הציבורי של מקום האירוח" />
          </Field>
          <Field label="כותרת משנה לנכס">
            <input className="field-input" value={form.propertySubtitle} maxLength={200}
              onChange={(e) => set("propertySubtitle", e.target.value)} placeholder="אופציונלי" />
          </Field>
          <Field label="סוג מקום האירוח">
            <select className="field-input" value={form.propertyType} onChange={(e) => set("propertyType", e.target.value)}>
              {PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>{PROPERTY_TYPE_LABELS[t] ?? t}</option>
              ))}
            </select>
          </Field>
        </FormGrid>
      </SettingsCard>

      {/* Public contact */}
      <SettingsCard icon="phone" title="פרטי קשר ציבוריים">
        <FormGrid>
          <Field label="דוא״ל">
            <input className="field-input" dir="ltr" inputMode="email" value={form.email} maxLength={320}
              onChange={(e) => set("email", e.target.value)} placeholder="info@example.com" />
          </Field>
          <Field label="טלפון">
            <input className="field-input" dir="ltr" inputMode="tel" value={form.phone} maxLength={40}
              onChange={(e) => set("phone", e.target.value)} placeholder="+972…" />
          </Field>
          <Field label="אתר">
            <input className="field-input" dir="ltr" inputMode="url" value={form.website} maxLength={300}
              onChange={(e) => set("website", e.target.value)} placeholder="https://…" />
          </Field>
        </FormGrid>
      </SettingsCard>

      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={saving || !dirty} onClick={onSave}>
          <Icon name="check" size={20} />
          {saving ? "שומר…" : "שמירת פרטי העסק"}
        </button>
        {dirty && <span className="field-hint">יש שינויים שלא נשמרו</span>}
      </div>

      {/* Location (Google Maps) */}
      <SettingsCard icon="globe" title="מיקום">
        <LocationPicker
          profile={ctx.profile}
          googleMapsConfigured={ctx.googleMapsConfigured}
          isSuperAdmin={ctx.isSuperAdmin}
          onSaved={reload}
        />
      </SettingsCard>
    </div>
  );
}

function LogoField({
  logo,
  uploading,
  fileRef,
  onPick,
  onRemove,
}: {
  logo: string | null;
  uploading: boolean;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onPick: (f: File) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-hover/40">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="לוגו העסק" className="h-full w-full object-contain" />
        ) : (
          <Icon name="image" size={24} className="text-faint" />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-text2">לוגו העסק</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
            }}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="image" size={20} />
            {uploading ? "מעלה…" : logo ? "החלפת לוגו" : "העלאת לוגו"}
          </button>
          {logo && (
            <button type="button" className="btn btn-secondary" disabled={uploading} onClick={onRemove}>
              <Icon name="trash" size={20} />
              הסרה
            </button>
          )}
        </div>
        <p className="field-hint">PNG, JPG או WEBP · עד 15MB</p>
      </div>
    </div>
  );
}

function ChecklistCard({
  title,
  items,
  done,
}: {
  title: string;
  items: { key: string; label: string; present: boolean }[];
  done: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
      <div className="flex items-center gap-2">
        <Icon name={done ? "shield-check" : "warning"} size={17} className={done ? "text-status-success" : "text-status-warning"} />
        <p className="text-sm font-bold text-ink">{title}</p>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-1.5 text-xs font-semibold">
            <Icon name={i.present ? "check" : "close"} size={13.5} className={i.present ? "text-status-success" : "text-faint"} />
            <span className={i.present ? "text-text2" : "text-faint"}>{i.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
