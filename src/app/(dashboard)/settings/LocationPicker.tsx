"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { Field } from "@/components/reservations/BookingPanel";
import {
  normalizeGooglePlace,
  placeHasCoordinates,
  googleMapsLink,
  type NormalizedPlace,
} from "@/lib/business/google-place";
import type { BusinessProfile, LocationSource } from "@/lib/business/profile";
import { saveBusinessLocationAction } from "./business-actions";

// Google Maps is the PRIMARY location workflow (Place Autocomplete New). When no
// browser key is configured it degrades to a clear message + the super_admin
// manual-coordinate fallback. Coordinates always come from a selected Google
// place, a confirmed marker move, or an explicitly confirmed manual entry —
// never fabricated. Raw Google responses are never stored (only normalized
// fields via normalizeGooglePlace, shared with the check script).

const BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

// ---- minimal typed surface of the Maps JS SDK (no `any`) ----
type PlaceJSON = Parameters<typeof normalizeGooglePlace>[0];
interface PlaceObj {
  fetchFields(opts: { fields: string[] }): Promise<unknown>;
  toJSON(): PlaceJSON;
}
type GmpSelectEvent = { placePrediction: { toPlace(): PlaceObj } };
interface GoogleMapsApi {
  places: { PlaceAutocompleteElement: new (opts?: Record<string, unknown>) => HTMLElement };
}
declare global {
  interface Window {
    google?: { maps?: GoogleMapsApi };
  }
}

let sdkPromise: Promise<GoogleMapsApi> | null = null;
function loadSdk(): Promise<GoogleMapsApi> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<GoogleMapsApi>((resolve, reject) => {
    if (window.google?.maps) return resolve(window.google.maps);
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      BROWSER_KEY ?? "",
    )}&libraries=places,marker,geocoding&loading=async&language=he&region=IL`;
    s.async = true;
    s.onload = () => (window.google?.maps ? resolve(window.google.maps) : reject(new Error("maps unavailable")));
    s.onerror = () => reject(new Error("maps script failed"));
    document.head.appendChild(s);
  });
  return sdkPromise;
}

type Pending = { place: NormalizedPlace; source: LocationSource } | null;

export function LocationPicker({
  profile,
  googleMapsConfigured,
  isSuperAdmin,
  onSaved,
}: {
  profile: BusinessProfile;
  googleMapsConfigured: boolean;
  isSuperAdmin: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const acHostRef = useRef<HTMLDivElement>(null);
  const [sdkError, setSdkError] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ lat: "", lng: "" });
  const [manualConfirm, setManualConfirm] = useState(false);
  const [saving, startSave] = useTransition();

  // Mount the New Place Autocomplete when Maps is configured.
  useEffect(() => {
    if (!googleMapsConfigured || !BROWSER_KEY) return;
    let cancelled = false;
    loadSdk()
      .then((maps) => {
        if (cancelled || !acHostRef.current) return;
        const el = new maps.places.PlaceAutocompleteElement();
        el.style.width = "100%";
        acHostRef.current.innerHTML = "";
        acHostRef.current.appendChild(el);
        el.addEventListener("gmp-select", (e: Event) => {
          const { placePrediction } = e as unknown as GmpSelectEvent;
          void (async () => {
            try {
              const place = placePrediction.toPlace();
              await place.fetchFields({ fields: ["id", "formattedAddress", "addressComponents", "location"] });
              const norm = normalizeGooglePlace(place.toJSON());
              if (!placeHasCoordinates(norm)) {
                toast.error("לתוצאה שנבחרה אין קואורדינטות");
                return;
              }
              setPending({ place: norm, source: "google_place" });
            } catch {
              toast.error("שליפת פרטי המקום נכשלה");
            }
          })();
        });
      })
      .catch(() => !cancelled && setSdkError(true));
    return () => {
      cancelled = true;
    };
  }, [googleMapsConfigured]);

  function saveLocation(place: NormalizedPlace, source: LocationSource) {
    startSave(async () => {
      const res = await saveBusinessLocationAction({
        source,
        confirmed: true,
        latitude: place.latitude,
        longitude: place.longitude,
        googlePlaceId: place.googlePlaceId,
        formattedAddress: place.formattedAddress,
        country: place.country,
        countryCode: place.countryCode,
        city: place.city,
        street: place.street,
        streetNumber: place.streetNumber,
        postalCode: place.postalCode,
      });
      if (!res.success) {
        toast.error(res.error ?? "אירעה שגיאה");
        return;
      }
      toast.success("המיקום נשמר");
      setPending(null);
      setManualOpen(false);
      setManualConfirm(false);
      setManual({ lat: "", lng: "" });
      await onSaved();
    });
  }

  function onManualSave() {
    const lat = Number(manual.lat.trim());
    const lng = Number(manual.lng.trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast.error("קואורדינטות לא תקינות");
    saveLocation(
      {
        latitude: lat,
        longitude: lng,
        googlePlaceId: null,
        formattedAddress: null,
        country: null,
        countryCode: null,
        city: null,
        street: null,
        streetNumber: null,
        postalCode: null,
      },
      "manual_override",
    );
  }

  const mapsHref = googleMapsLink({
    placeId: profile.googlePlaceId,
    latitude: profile.latitude,
    longitude: profile.longitude,
  });

  return (
    <div className="flex flex-col gap-4">
      {/* current saved location */}
      <div className="grid gap-x-4 gap-y-1.5 rounded-xl border border-line bg-hover/30 p-4 text-sm sm:grid-cols-2">
        <Row label="כתובת מלאה" value={profile.formattedAddress} span />
        <Row label="עיר" value={profile.city} />
        <Row label="מדינה" value={profile.country ?? profile.countryCode} />
        <Row label="מיקוד" value={profile.postalCode} />
        <Row label="אזור זמן (קנוני)" value={profile.timezone} />
        <Row label="קו רוחב" value={profile.latitude !== null ? String(profile.latitude) : null} />
        <Row label="קו אורך" value={profile.longitude !== null ? String(profile.longitude) : null} />
        <Row label="מקור המיקום" value={sourceLabel(profile.locationSource)} />
      </div>
      {mapsHref && (
        <a href={mapsHref} target="_blank" rel="noopener noreferrer" className="bw-btn w-fit">
          <Icon name="globe" size={15} />
          פתיחה ב-Google Maps
        </a>
      )}

      {/* Google autocomplete OR not-configured message */}
      {googleMapsConfigured && !sdkError ? (
        <Field label="כתובת / חיפוש ב-Google Maps">
          <div ref={acHostRef} className="w-full [&_gmp-place-autocomplete]:w-full" />
        </Field>
      ) : (
        <p className="rounded-lg bg-status-warning-050 px-3 py-2 text-xs font-semibold text-status-warning">
          {sdkError
            ? "טעינת Google Maps נכשלה. בדוק את מפתח הדפדפן המורשה או נסה שוב."
            : "Google Maps אינו מוגדר. הוסף מפתח Google Maps מוגבל כדי לאפשר חיפוש כתובת וקואורדינטות אוטומטיות."}
        </p>
      )}

      {/* Manual advanced fallback — super_admin only */}
      {isSuperAdmin && (
        <div className="rounded-xl border border-line">
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-bold text-ink"
          >
            <span className="flex items-center gap-2">
              <Icon name="edit" size={15} className="text-muted" />
              מיקום ידני מתקדם
            </span>
            <Icon name={manualOpen ? "arrow-up" : "arrow-down"} size={15} className="text-faint" />
          </button>
          {manualOpen && (
            <div className="flex flex-col gap-3 border-t border-line p-4">
              <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
                דריסה ידנית של המיקום שנבחר ב-Google. יש להזין קואורדינטות מדויקות ולאשר במפורש.
              </p>
              <div className="bw-grid2">
                <Field label="קו רוחב (-90..90)">
                  <input className="bw-fld" dir="ltr" inputMode="decimal" value={manual.lat}
                    onChange={(e) => setManual((m) => ({ ...m, lat: e.target.value }))} placeholder="32.0853" />
                </Field>
                <Field label="קו אורך (-180..180)">
                  <input className="bw-fld" dir="ltr" inputMode="decimal" value={manual.lng}
                    onChange={(e) => setManual((m) => ({ ...m, lng: e.target.value }))} placeholder="34.7818" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-text2">
                <input type="checkbox" checked={manualConfirm} onChange={(e) => setManualConfirm(e.target.checked)} />
                אני מאשר/ת דריסה ידנית של המיקום
              </label>
              <button className="bw-btn bw-btn-primary w-fit" disabled={saving || !manualConfirm} onClick={onManualSave}>
                <Icon name="check" size={15} />
                שמירת מיקום ידני
              </button>
            </div>
          )}
        </div>
      )}

      {/* confirm a Google-selected place before saving */}
      {pending && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" dir="rtl" onClick={() => setPending(null)}>
          <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-ink">אישור מיקום</h3>
            <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm">
              <Dt>כתובת</Dt><Dd className="col-span-2">{pending.place.formattedAddress ?? "—"}</Dd>
              <Dt>עיר</Dt><Dd className="col-span-2">{pending.place.city ?? "—"}</Dd>
              <Dt>מדינה</Dt><Dd className="col-span-2">{pending.place.country ?? pending.place.countryCode ?? "—"}</Dd>
              <Dt>קואורדינטות</Dt><Dd className="col-span-2 font-mono text-xs">{pending.place.latitude}, {pending.place.longitude}</Dd>
            </dl>
            <div className="flex justify-end gap-2">
              <button className="bw-btn" onClick={() => setPending(null)}>ביטול</button>
              <button className="bw-btn bw-btn-primary" disabled={saving} onClick={() => saveLocation(pending.place, pending.source)}>
                <Icon name="check" size={15} />
                שמירת המיקום
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function sourceLabel(s: LocationSource | null): string | null {
  if (s === "google_place") return "בחירה מ-Google";
  if (s === "google_marker_adjustment") return "התאמת סמן ב-Google";
  if (s === "manual_override") return "דריסה ידנית";
  return null;
}

function Row({ label, value, span }: { label: string; value: string | null | undefined; span?: boolean }) {
  return (
    <div className={span ? "sm:col-span-2" : ""}>
      <p className="text-xs font-medium text-faint">{label}</p>
      <p className="truncate font-semibold text-text2" title={value ?? undefined}>{value || "—"}</p>
    </div>
  );
}
const Dt = ({ children }: { children: React.ReactNode }) => <dt className="text-faint">{children}</dt>;
const Dd = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <dd className={`font-semibold text-text2 ${className}`}>{children}</dd>
);
