"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { Field } from "@/components/reservations/BookingPanel";
import { googleMapsLink, type NormalizedPlace } from "@/lib/business/google-place";
import { sanitizeMapsError, type SanitizedMapsError } from "@/lib/business/maps-errors";
import {
  loadMapsApi,
  importPlaces,
  importMaps,
  importMarker,
  importGeocoding,
  mountAutocomplete,
  renderMap,
  renderMarker,
  reverseGeocode,
  type LatLngLiteral,
  type MapObj,
  type MarkerObj,
  type GeocodingLibrary,
} from "@/lib/business/maps-picker";
import type { BusinessProfile, LocationSource } from "@/lib/business/profile";
import { saveBusinessLocationAction, saveBusinessProfileAction } from "./business-actions";

// Google Maps is the PRIMARY location workflow (Place Autocomplete New).
// Coordinates always come from a selected Google place, a CONFIRMED marker move,
// or an explicitly confirmed manual entry — never fabricated, never auto-saved.
// Raw Google responses are never stored (only normalized fields). The saved
// canonical location is rendered independently of the SDK, so a Maps failure can
// never blank or replace it.

const BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

type SdkStatus = "idle" | "loading" | "ready" | "error";
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
  const mapHostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapObj | null>(null);
  const markerRef = useRef<MarkerObj | null>(null);
  const geocoderRef = useRef<GeocodingLibrary | null>(null);

  const [status, setStatus] = useState<SdkStatus>("idle");
  const [sdkError, setSdkError] = useState<SanitizedMapsError | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ lat: "", lng: "" });
  const [manualConfirm, setManualConfirm] = useState(false);
  const [saving, startSave] = useTransition();

  const savedCenter: LatLngLiteral | null =
    profile.latitude !== null && profile.longitude !== null
      ? { lat: profile.latitude, lng: profile.longitude }
      : null;
  const pendingCenter: LatLngLiteral | null =
    pending && pending.place.latitude !== null && pending.place.longitude !== null
      ? { lat: pending.place.latitude, lng: pending.place.longitude }
      : null;
  const center = pendingCenter ?? savedCenter;

  const reportError = useCallback((e: unknown, fallback: Parameters<typeof sanitizeMapsError>[1]) => {
    const safe = sanitizeMapsError(e, fallback);
    // sanitized category + message only — never the key, the script URL or a body
    console.error(`[maps:${safe.code}]`, safe.detail);
    setSdkError(safe);
    return safe;
  }, []);

  // Move the marker → PENDING adjustment. Dragging never saves; the operator must
  // confirm. The reverse-geocoded address is shown separately and never silently
  // replaces the address of the selected Google place.
  const onMarkerDragEnd = useCallback(
    (at: LatLngLiteral) => {
      setResolvedAddress(null);
      setPending((prev) => {
        const base: NormalizedPlace = prev?.place ?? profileAsPlace(profile);
        return {
          place: { ...base, latitude: at.lat, longitude: at.lng },
          source: "google_marker_adjustment",
        };
      });
      const geo = geocoderRef.current;
      if (!geo) return;
      void reverseGeocode(geo, at).then((p) => setResolvedAddress(p?.formattedAddress ?? null));
    },
    [profile],
  );

  // Bootstrap the SDK, then mount the autocomplete. Strict Mode double-invokes
  // this effect: `cancelled` aborts the late async continuation and
  // mountAutocomplete refuses to append a second widget to the same host.
  useEffect(() => {
    if (!googleMapsConfigured || !BROWSER_KEY) return;
    let cancelled = false;
    let unmountAc: (() => void) | null = null;
    setStatus("loading");
    setSdkError(null);

    void (async () => {
      try {
        const maps = await loadMapsApi(BROWSER_KEY);
        const [places] = await Promise.all([importPlaces(maps), importMaps(maps), importMarker(maps)]);
        if (cancelled) return;
        if (!acHostRef.current) throw new Error("autocomplete host missing");

        unmountAc = mountAutocomplete({
          host: acHostRef.current,
          places,
          onSelect: (place) => {
            setResolvedAddress(null);
            setPending({ place, source: "google_place" });
          },
          onError: (e) => {
            const safe = sanitizeMapsError(e, "PLACE_SELECTION_FAILED");
            console.error(`[maps:${safe.code}]`, safe.detail);
            toast.error(safe.message);
          },
        });
        if (cancelled) return;
        setStatus("ready");

        // geocoding is advisory (marker adjustment only) — never blocks readiness
        importGeocoding(maps).then(
          (g) => !cancelled && (geocoderRef.current = g),
          () => {},
        );
      } catch (e) {
        if (!cancelled) {
          reportError(e, "MAPS_SCRIPT_LOAD_FAILED");
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      unmountAc?.();
    };
  }, [googleMapsConfigured, reportError]);

  // Create/update the map + draggable marker whenever there is a center to show.
  // When the center disappears the container unmounts with it, so the map and
  // marker handles must be dropped — otherwise the next render would centre a
  // map that is no longer in the document.
  useEffect(() => {
    if (!center) {
      mapRef.current = null;
      markerRef.current = null;
      return;
    }
    if (status !== "ready") return;
    try {
      const maps = window.google?.maps;
      if (!maps) return;
      void Promise.all([importMaps(maps), importMarker(maps)]).then(([mapsLib, markerLib]) => {
        if (!mapHostRef.current) return;
        if (!mapRef.current) mapRef.current = renderMap(mapsLib, mapHostRef.current, center);
        else mapRef.current.setCenter(center);
        if (!markerRef.current) markerRef.current = renderMarker(markerLib, mapRef.current, center, onMarkerDragEnd);
        else markerRef.current.setPosition(center);
      });
    } catch (e) {
      reportError(e, "MAP_RENDER_FAILED");
    }
  }, [status, center?.lat, center?.lng, onMarkerDragEnd, reportError]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setResolvedAddress(null);
      setManualOpen(false);
      setManualConfirm(false);
      setManual({ lat: "", lng: "" });
      await onSaved();
    });
  }

  function discardPending() {
    setPending(null);
    setResolvedAddress(null);
    if (savedCenter) markerRef.current?.setPosition(savedCenter); // snap back to the saved location
  }

  function onManualSave() {
    const lat = Number(manual.lat.trim());
    const lng = Number(manual.lng.trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast.error("קואורדינטות לא תקינות");
    saveLocation({ ...emptyPlace(), latitude: lat, longitude: lng }, "manual_override");
  }

  const linkTarget = pending?.place ?? profile;
  const mapsHref = googleMapsLink({
    placeId: linkTarget.googlePlaceId,
    latitude: linkTarget.latitude,
    longitude: linkTarget.longitude,
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Saved canonical location — rendered from the profile alone, so a Maps
          failure or an unconfirmed edit can never blank or replace it. The postal
          code sits with the address fields (after street/number, before
          city/country) and is the ONE canonical source Channex reads zip_code from. */}
      <div className="grid gap-x-4 gap-y-1.5 rounded-xl border border-line bg-hover/30 p-4 text-sm sm:grid-cols-2">
        <Row label="כתובת מלאה" value={profile.formattedAddress} span />
        <Row label="רחוב" value={profile.street} />
        <Row label="מספר בית" value={profile.streetNumber} />
        <div className="sm:col-span-2">
          <PostalCodeField postalCode={profile.postalCode} onSaved={onSaved} />
        </div>
        <Row label="עיר" value={profile.city} />
        <Row label="מדינה" value={profile.country ?? profile.countryCode} />
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

      {!googleMapsConfigured ? (
        <p className="rounded-lg bg-status-warning-050 px-3 py-2 text-xs font-semibold text-status-warning">
          Google Maps אינו מוגדר. הוסף מפתח Google Maps מוגבל כדי לאפשר חיפוש כתובת וקואורדינטות אוטומטיות.
        </p>
      ) : (
        <>
          {/* The autocomplete host must always exist while configured — the widget
              is appended into it once the places library has actually loaded.
              relative + z-30 keeps Google's dropdown above the following cards. */}
          <Field label="כתובת / חיפוש ב-Google Maps">
            <div className="relative z-30">
              <div ref={acHostRef} className="w-full [&_gmp-place-autocomplete]:w-full" />
              {status === "loading" && (
                <p className="mt-1 text-xs font-semibold text-faint">טוען את Google Maps…</p>
              )}
            </div>
          </Field>

          {status === "error" && sdkError && (
            <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
              {sdkError.message}
              <span className="mx-1 font-mono text-[10px] opacity-70">[{sdkError.code}]</span>
            </p>
          )}

          {/* Rendered only when there is a location to show, never merely hidden:
              a Map initialized inside a display:none container mis-sizes its tiles.
              Explicit non-zero height; the flex-column parent cannot collapse it. */}
          {center && (
            <>
              <div ref={mapHostRef} className="h-72 w-full shrink-0 overflow-hidden rounded-xl border border-line" />
              <p className="text-xs font-medium text-faint">
                גרור את הסמן כדי לתקן את המיקום המדויק של הבניין. שינוי אינו נשמר עד לאישור.
              </p>
            </>
          )}
        </>
      )}

      {/* Pending selection / marker adjustment — nothing is persisted until confirmed. */}
      {pending && pendingCenter && (
        <div className="flex flex-col gap-3 rounded-xl border border-brand/40 bg-brand/5 p-4">
          <h4 className="text-sm font-bold text-ink">
            {pending.source === "google_place" ? "מיקום נבחר — ממתין לאישור" : "התאמת סמן — ממתינה לאישור"}
          </h4>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm">
            <Dt>כתובת</Dt>
            <Dd className="col-span-2">{pending.place.formattedAddress ?? "—"}</Dd>
            <Dt>עיר</Dt>
            <Dd className="col-span-2">{pending.place.city ?? "—"}</Dd>
            <Dt>מיקוד</Dt>
            <Dd className="col-span-2">
              {pending.place.postalCode ?? "לא הוחזר מ-Google — ניתן להזין ידנית לאחר השמירה"}
            </Dd>
            <Dt>קואורדינטות</Dt>
            <Dd className="col-span-2 font-mono text-xs" dir="ltr">
              {pendingCenter.lat}, {pendingCenter.lng}
            </Dd>
            {pending.source === "google_marker_adjustment" && (
              <>
                <Dt>כתובת לפי הסמן</Dt>
                <Dd className="col-span-2 text-xs">
                  {resolvedAddress ?? "לא זוהתה כתובת עבור הנקודה שנבחרה"}
                </Dd>
              </>
            )}
          </dl>
          <div className="flex gap-2">
            <button
              className="bw-btn bw-btn-primary"
              disabled={saving}
              onClick={() => saveLocation(pending.place, pending.source)}
            >
              <Icon name="check" size={15} />
              אישור ושמירת המיקום
            </button>
            <button className="bw-btn" disabled={saving} onClick={discardPending}>
              ביטול
            </button>
          </div>
        </div>
      )}

      {/* Advanced manual fallback — super_admin only, collapsed, never the main flow. */}
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
                Google Maps הוא המקור המועדף למיקום. דריסה ידנית מבטלת את המיקום שנבחר ב-Google — יש להזין
                קואורדינטות מדויקות ולאשר במפורש.
              </p>
              <div className="bw-grid2">
                <Field label="קו רוחב (-90..90)">
                  <input
                    className="bw-fld"
                    dir="ltr"
                    inputMode="decimal"
                    value={manual.lat}
                    onChange={(e) => setManual((m) => ({ ...m, lat: e.target.value }))}
                  />
                </Field>
                <Field label="קו אורך (-180..180)">
                  <input
                    className="bw-fld"
                    dir="ltr"
                    inputMode="decimal"
                    value={manual.lng}
                    onChange={(e) => setManual((m) => ({ ...m, lng: e.target.value }))}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-text2">
                <input
                  type="checkbox"
                  checked={manualConfirm}
                  onChange={(e) => setManualConfirm(e.target.checked)}
                />
                אני מאשר/ת דריסה ידנית של המיקום
              </label>
              <button
                className="bw-btn bw-btn-primary w-fit"
                disabled={saving || !manualConfirm}
                onClick={onManualSave}
              >
                <Icon name="check" size={15} />
                שמירת מיקום ידני
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The canonical postal code, always visible and always editable. Google fills it
// automatically when a selected place carries a postal_code component; when it
// does not (or returns a partial one) the operator types it here. Saving writes
// the Business Profile immediately — /channels never asks for it again.
function PostalCodeField({
  postalCode,
  onSaved,
}: {
  postalCode: string | null;
  onSaved: () => Promise<void> | void;
}) {
  const [value, setValue] = useState(postalCode ?? "");
  const [saving, startSave] = useTransition();
  // Re-sync when a Google place selection changes the saved value underneath us.
  const [lastSaved, setLastSaved] = useState(postalCode ?? "");
  if ((postalCode ?? "") !== lastSaved) {
    setLastSaved(postalCode ?? "");
    setValue(postalCode ?? "");
  }
  const dirty = value.trim() !== (postalCode ?? "");

  function save() {
    startSave(async () => {
      const res = await saveBusinessProfileAction({ postalCode: value.trim() });
      if (!res.success) {
        toast.error(res.error ?? "אירעה שגיאה");
        return;
      }
      toast.success("המיקוד נשמר");
      await onSaved();
    });
  }

  return (
    <Field label="מיקוד">
      <div className="flex items-center gap-2">
        <input
          className="bw-fld"
          value={value}
          maxLength={40}
          onChange={(e) => setValue(e.target.value)}
          placeholder="לדוגמה 6688101"
        />
        <button className="bw-btn shrink-0" disabled={saving || !dirty} onClick={save}>
          <Icon name="check" size={15} />
          {saving ? "שומר…" : "שמירה"}
        </button>
      </div>
      <p className="bw-hint">
        מתמלא אוטומטית מ-Google כשקיים. ניתן לערוך ידנית — מיקוד עשוי לכלול אותיות במדינות מסוימות.
      </p>
    </Field>
  );
}

const emptyPlace = (): NormalizedPlace => ({
  googlePlaceId: null,
  formattedAddress: null,
  country: null,
  countryCode: null,
  city: null,
  street: null,
  streetNumber: null,
  postalCode: null,
  latitude: null,
  longitude: null,
});

// The already-saved location as a place, so a marker drag on a previously saved
// property keeps its address/place id while only the coordinates change.
const profileAsPlace = (p: BusinessProfile): NormalizedPlace => ({
  googlePlaceId: p.googlePlaceId,
  formattedAddress: p.formattedAddress,
  country: p.country,
  countryCode: p.countryCode,
  city: p.city,
  street: p.street,
  streetNumber: p.streetNumber,
  postalCode: p.postalCode,
  latitude: p.latitude,
  longitude: p.longitude,
});

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
      <p className="truncate font-semibold text-text2" title={value ?? undefined}>
        {value || "—"}
      </p>
    </div>
  );
}
const Dt = ({ children }: { children: React.ReactNode }) => <dt className="text-faint">{children}</dt>;
const Dd = ({
  children,
  className = "",
  dir,
}: {
  children: React.ReactNode;
  className?: string;
  dir?: "ltr" | "rtl";
}) => (
  <dd dir={dir} className={`font-semibold text-text2 ${className}`}>
    {children}
  </dd>
);
