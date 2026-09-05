"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { PROPERTY_TYPES, type ProfileCheckItem } from "@/lib/business/profile";
import { Field, FormGrid, SettingsCard } from "./controls";
import {
  getBusinessProfileContextAction,
  saveBusinessProfileAction,
  removeBusinessLogoAction,
  type BusinessProfileContext,
} from "./business-actions";
import { LocationPicker } from "./LocationPicker";

// פרופיל העסק — approved design "הגדרות - פרופיל העסק.dc.html" (D175): a compact
// dismissible banner, ONE readiness card split into two columns with a status
// pill each, uniform titled cards (icon square + title + subtitle), the blue
// primary "שמירת פרטי העסק" after the contact card, and the location card.
// Canonical Business/Property identity, separate from the GuestHub application
// brand. Identity + contact save through saveBusinessProfileAction; logo through
// /api/branding/logo; location through LocationPicker. Nothing here prefills
// "GuestHub" or an invented name — empty fields stay empty.

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

export function BusinessProfileSection({
  initial,
  showBanner = true,
}: {
  initial: BusinessProfileContext;
  /** the identity note above the readiness card — a display setting; the
   *  operator can also dismiss it for the session */
  showBanner?: boolean;
}) {
  const [ctx, setCtx] = useState(initial);
  const [form, setForm] = useState<IdentityForm>(toForm(initial));
  const [logo, setLogo] = useState<string | null>(initial.profile.logo);
  const [uploading, setUploading] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(showBanner);
  const [saving, startSave] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(ctx));

  // Every save path (identity, logo, location) funnels through here. The action's
  // revalidatePath("/settings") only covers the page — the dashboard LAYOUT, which
  // renders the sidebar account card, is above it and is not re-rendered by a
  // Server Action. router.refresh() refetches the whole tree, so the sidebar picks
  // up the new property identity with no logout, hard refresh or redeploy.
  // The readiness card re-computes from the reloaded context, so a postal code
  // saved in the location card flips its pill on the same round-trip.
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
    <div className="bp" dir="rtl">
      {/* Identity note — GuestHub is the application, not the business */}
      {bannerOpen && (
        <div className="bp-banner" role="note">
          <Icon name="info" size={20} />
          <p>
            GuestHub הוא שם מערכת הניהול בלבד. כאן מגדירים את זהות העסק והנכס הציבורית — השם שמופיע
            ללקוחות, במסמכים, בהודעות ובחיבור לערוצי הזמנות.
          </p>
          <button
            type="button"
            className="icon-btn"
            aria-label="סגירת ההודעה"
            onClick={() => setBannerOpen(false)}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
      )}

      {/* completion + channel readiness — one card, two columns, a pill each */}
      <section className="card bp-ready" aria-label="מוכנות פרופיל העסק">
        <ReadinessColumn
          icon="verified"
          tone="ok"
          title="פרטי עסק בסיסיים"
          items={status.businessItems}
          done={status.businessComplete}
          doneLabel="תקין"
        />
        <ReadinessColumn
          icon="crown"
          tone="warn"
          title="מוכנות לחיבור ערוצים (Booking/Expedia)"
          items={status.channelItems}
          done={status.channelReady}
          doneLabel="מוכן לחיבור"
          twoColumns
        />
      </section>

      {/* Business identity */}
      <SettingsCard
        icon="building"
        title="זהות העסק"
        subtitle="השם והלוגו של העסק כפי שמופיעים ללקוחות, במסמכים ובהודעות"
      >
        <div className="flex flex-col gap-4">
          <LogoField
            logo={logo}
            initials={initials(ctx.profile.publicBusinessName)}
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
      <SettingsCard
        icon="hotel"
        title="זהות הנכס / מקום האירוח"
        subtitle="השם והסוג של מקום האירוח כפי שיוצגו לאורחים ולערוצי ההזמנות"
      >
        <FormGrid>
          <Field label="שם הנכס">
            <input className="field-input" value={form.propertyName} maxLength={200}
              onChange={(e) => set("propertyName", e.target.value)} placeholder="השם הציבורי של מקום האירוח" />
          </Field>
          <Field label="כותרת משנה">
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

      {/* Public contact — email + phone on one row, the website full width */}
      <SettingsCard
        icon="phone"
        title="פרטי קשר ציבוריים"
        subtitle="אמצעי הקשר שמוצגים לאורחים ומועברים לערוצי ההזמנות"
      >
        <FormGrid>
          <Field label="דוא״ל">
            <input className="field-input" dir="ltr" inputMode="email" value={form.email} maxLength={320}
              onChange={(e) => set("email", e.target.value)} placeholder="info@example.com" />
          </Field>
          <Field label="טלפון">
            <input className="field-input" dir="ltr" inputMode="tel" value={form.phone} maxLength={40}
              onChange={(e) => set("phone", e.target.value)} placeholder="+972…" />
          </Field>
          <Field label="אתר" full>
            <input className="field-input" dir="ltr" inputMode="url" value={form.website} maxLength={300}
              onChange={(e) => set("website", e.target.value)} placeholder="https://…" />
          </Field>
        </FormGrid>
      </SettingsCard>

      <div className="bp-save-row">
        <button type="button" className="btn btn-primary" disabled={saving || !dirty} onClick={onSave}>
          <Icon name="check" size={20} />
          {saving ? "שומר…" : "שמירת פרטי העסק"}
        </button>
        {dirty && <span className="field-hint">יש שינויים שלא נשמרו</span>}
      </div>

      {/* Location (Google Maps) — its own save, its own API call */}
      <SettingsCard
        icon="location"
        title="מיקום"
        subtitle="כתובת, קואורדינטות ואזור זמן של הנכס — מקור אחד לכל הערוצים"
      >
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

// Up to two initials of the public business name, for the logo circle when no
// image is set. publicBusinessName always has a value (tenant fallback), and it
// is never the application name.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p.charAt(0)).join("") || "—";
}

function LogoField({
  logo,
  initials,
  uploading,
  fileRef,
  onPick,
  onRemove,
}: {
  logo: string | null;
  initials: string;
  uploading: boolean;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onPick: (f: File) => void;
  onRemove: () => void;
}) {
  return (
    <div className="bp-logo-row">
      <div className="bp-logo">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="לוגו העסק" />
        ) : (
          <span aria-hidden="true">{initials}</span>
        )}
      </div>
      <div className="bp-logo-acts">
        <div className="bp-logo-btns">
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
            <Icon name="photo-camera" size={20} />
            {uploading ? "מעלה…" : logo ? "החלפת לוגו" : "העלאת לוגו"}
          </button>
          {logo && (
            <button type="button" className="btn bp-btn-remove" disabled={uploading} onClick={onRemove}>
              הסרה
            </button>
          )}
        </div>
        <p className="bp-note">PNG, JPG או WEBP · עד 15MB</p>
      </div>
    </div>
  );
}

const missingLabel = (n: number) => (n === 1 ? "חסר שדה אחד" : `חסרים ${n} שדות`);

// One readiness column: icon + title + a status pill, then the field list.
// Present → check_circle in success green; missing → cancel in the reference's
// red with the label faded. The list icon is the reference's 18px, snapped by
// <Icon> to the §10 size 17.
function ReadinessColumn({
  icon,
  tone,
  title,
  items,
  done,
  doneLabel,
  twoColumns,
}: {
  icon: IconName;
  tone: "ok" | "warn";
  title: string;
  items: ProfileCheckItem[];
  done: boolean;
  doneLabel: string;
  twoColumns?: boolean;
}) {
  const missing = items.filter((i) => !i.present).length;
  return (
    <div className="bp-ready-col">
      <div className="bp-ready-hd">
        <Icon name={icon} size={20} className={tone} />
        <span className="bp-ready-t">{title}</span>
        <span className={`bp-status ${done ? "ok" : "warn"}`}>{done ? doneLabel : missingLabel(missing)}</span>
      </div>
      <ul className={`bp-ready-list${twoColumns ? " two" : ""}`}>
        {items.map((i) => (
          <li key={i.key} className={`bp-ready-item${i.present ? "" : " miss"}`}>
            <Icon name={i.present ? "check-circle" : "cancel"} size={17} />
            <span>{i.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
