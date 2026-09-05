"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { Field, FormGrid } from "./controls";
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
//
// Layout per the approved design (D175): the saved location as a 4-column
// summary on a tinted surface, the Google Maps link + place search on one row,
// the 340px map with its drag hint, the collapsed "מיקום ידני מתקדם" accordion
// (coordinates for super_admin, the postal code + the canonical time zone for
// everyone) and ONE primary "שמירת מיקום" at the bottom. That button saves
// whatever is pending: a selected place / dragged marker, a manual override, or
// a postal code on its own.

const BROWSER_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;

type SdkStatus = "idle" | "loading" | "ready" | "error";
type Pending = { place: NormalizedPlace; source: LocationSource } | null;
type ManualForm = { lat: string; lng: string; postal: string };

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
  const [manual, setManual] = useState<ManualForm>({ lat: "", lng: "", postal: profile.postalCode ?? "" });
  const [manualConfirm, setManualConfirm] = useState(false);
  const [saving, startSave] = useTransition();

  // Re-sync the postal input when a save changes the canonical value underneath
  // it (a Google place that carried a postal_code, or our own save coming back).
  const [lastSavedPostal, setLastSavedPostal] = useState(profile.postalCode ?? "");
  if ((profile.postalCode ?? "") !== lastSavedPostal) {
    setLastSavedPostal(profile.postalCode ?? "");
    setManual((m) => ({ ...m, postal: profile.postalCode ?? "" }));
  }

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
      setManual((m) => ({ ...m, lat: "", lng: "" }));
      await onSaved();
    });
  }

  function discardPending() {
    setPending(null);
    setResolvedAddress(null);
    if (savedCenter) markerRef.current?.setPosition(savedCenter); // snap back to the saved location
  }

  // A postal code typed while a place / marker move is pending rides along with
  // it: the pending place is what "שמירת מיקום" saves, so the code is merged into
  // it here instead of being saved separately.
  function onPostalChange(v: string) {
    setManual((m) => ({ ...m, postal: v }));
    const t = v.trim();
    setPending((p) => (p ? { ...p, place: { ...p.place, postalCode: t === "" ? null : t } } : p));
  }

  function onManualSave() {
    const lat = Number(manual.lat.trim());
    const lng = Number(manual.lng.trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast.error("קואורדינטות לא תקינות");
    const postal = manual.postal.trim();
    saveLocation(
      { ...emptyPlace(), latitude: lat, longitude: lng, postalCode: postal === "" ? null : postal },
      "manual_override",
    );
  }

  // The postal code alone — the one field Google does not always return — writes
  // the Business Profile directly; /channels never asks for it again.
  function onPostalSave() {
    startSave(async () => {
      const res = await saveBusinessProfileAction({ postalCode: manual.postal.trim() });
      if (!res.success) {
        toast.error(res.error ?? "אירעה שגיאה");
        return;
      }
      toast.success("המיקום נשמר");
      await onSaved();
    });
  }

  const coordsTyped = manual.lat.trim() !== "" || manual.lng.trim() !== "";
  const postalDirty = manual.postal.trim() !== (profile.postalCode ?? "");
  const unsaved = !!pending || coordsTyped || postalDirty;

  const linkTarget = pending?.place ?? profile;
  const mapsHref = googleMapsLink({
    placeId: linkTarget.googlePlaceId,
    latitude: linkTarget.latitude,
    longitude: linkTarget.longitude,
  });
  const fromGoogle =
    profile.locationSource === "google_place" || profile.locationSource === "google_marker_adjustment";

  return (
    <div className="bp-loc">
      {/* Saved canonical location — rendered from the profile alone, so a Maps
          failure or an unconfirmed edit can never blank or replace it. The postal
          code shown here is the ONE canonical source the channel reads zip_code
          from; it is edited in the accordion below. */}
      <div className="bp-sum">
        <Cell label="כתובת מלאה" value={profile.formattedAddress} />
        <Cell label="עיר" value={profile.city} />
        <Cell label="מדינה" value={profile.country ?? profile.countryCode} />
        <Cell label="מיקוד" value={profile.postalCode} />
        <Cell label="אזור זמן" value={profile.timezone} mono />
        <Cell label="קו רוחב" value={profile.latitude !== null ? String(profile.latitude) : null} mono />
        <Cell label="קו אורך" value={profile.longitude !== null ? String(profile.longitude) : null} mono />
        <Cell label="מקור המיקום" value={sourceLabel(profile.locationSource)} ok={fromGoogle} />
      </div>

      <div className="bp-loc-acts">
        {mapsHref && (
          <a href={mapsHref} target="_blank" rel="noopener noreferrer" className="bp-maps-link">
            <Icon name="open-in-new" size={17} />
            פתיחה ב-Google Maps
          </a>
        )}
        {googleMapsConfigured ? (
          // The autocomplete host must always exist while configured — Google's
          // widget is appended into it once the places library has actually loaded.
          <div className="bp-search" role="search" aria-label="חיפוש כתובת ב-Google Maps">
            <Icon name="search" size={20} />
            <div ref={acHostRef} className="bp-search-host" />
          </div>
        ) : (
          <p className="rounded-lg bg-status-warning-050 px-3 py-2 text-xs font-semibold text-status-warning">
            Google Maps אינו מוגדר. הוסף מפתח Google Maps מוגבל כדי לאפשר חיפוש כתובת וקואורדינטות אוטומטיות.
          </p>
        )}
      </div>
      {googleMapsConfigured && status === "loading" && <p className="field-hint">טוען את Google Maps…</p>}

      {status === "error" && sdkError && (
        <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
          {sdkError.message}
          <span className="mx-1 font-mono text-[12px] opacity-70">[{sdkError.code}]</span>
        </p>
      )}

      {/* Rendered only when there is a location to show, never merely hidden:
          a Map initialized inside a display:none container mis-sizes its tiles.
          .bp-map carries the explicit 340px height; the flex-column parent
          cannot collapse it. */}
      {center && (
        <>
          <div ref={mapHostRef} className="bp-map" />
          <p className="bp-map-note">
            <Icon name="pan-tool" size={17} />
            גרירת הסמן מכוונת את המיקום המדויק של הבניין — השינוי לא נשמר עד לחיצה על ״שמירת מיקום״.
          </p>
        </>
      )}

      {/* Pending selection / marker adjustment — nothing is persisted until saved. */}
      {pending && pendingCenter && (
        <div className="bp-pending">
          <div className="bp-pending-hd">
            <span>{pending.source === "google_place" ? "מיקום נבחר" : "התאמת סמן"}</span>
            <span className="bp-status warn">ממתין לשמירה</span>
            <button type="button" className="btn btn-tertiary ms-auto" disabled={saving} onClick={discardPending}>
              ביטול
            </button>
          </div>
          <dl>
            <dt>כתובת</dt>
            <dd>{pending.place.formattedAddress ?? "—"}</dd>
            <dt>עיר</dt>
            <dd>{pending.place.city ?? "—"}</dd>
            <dt>מיקוד</dt>
            <dd>{pending.place.postalCode ?? "לא הוחזר מ-Google — ניתן להזין ב״מיקום ידני מתקדם״"}</dd>
            <dt>קואורדינטות</dt>
            <dd className="bp-mono" dir="ltr">
              {pendingCenter.lat}, {pendingCenter.lng}
            </dd>
            {pending.source === "google_marker_adjustment" && (
              <>
                <dt>כתובת לפי הסמן</dt>
                <dd>{resolvedAddress ?? "לא זוהתה כתובת עבור הנקודה שנבחרה"}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {/* Advanced manual location — collapsed by default. The postal code and the
          canonical time zone are here for every operator; the coordinate
          override stays super_admin-only and, once typed, demands the explicit
          confirmation the server requires (§6). */}
      <div className={`bp-acc${manualOpen ? " open" : ""}`}>
        <button
          type="button"
          className="bp-acc-hd"
          aria-expanded={manualOpen}
          aria-controls="bp-manual"
          onClick={() => setManualOpen((v) => !v)}
        >
          <Icon name="edit" size={20} />
          מיקום ידני מתקדם
          <Icon name="chevron" size={20} className="bp-acc-chev" />
        </button>
        {manualOpen && (
          <div id="bp-manual" className="bp-acc-bd">
            <FormGrid>
              {isSuperAdmin && (
                <>
                  <Field label="קו רוחב">
                    <input
                      className="field-input bp-mono"
                      dir="ltr"
                      inputMode="decimal"
                      value={manual.lat}
                      onChange={(e) => setManual((m) => ({ ...m, lat: e.target.value }))}
                      placeholder="‎-90 עד 90"
                    />
                  </Field>
                  <Field label="קו אורך">
                    <input
                      className="field-input bp-mono"
                      dir="ltr"
                      inputMode="decimal"
                      value={manual.lng}
                      onChange={(e) => setManual((m) => ({ ...m, lng: e.target.value }))}
                      placeholder="‎-180 עד 180"
                    />
                  </Field>
                </>
              )}
              <Field label="מיקוד">
                <input
                  className="field-input"
                  dir="ltr"
                  value={manual.postal}
                  maxLength={40}
                  onChange={(e) => onPostalChange(e.target.value)}
                  placeholder="לדוגמה: 3303210"
                />
              </Field>
              <Field label="אזור זמן">
                <select className="field-input bp-mono" value={profile.timezone} disabled aria-describedby="bp-tz-hint">
                  <option value={profile.timezone}>{profile.timezone}</option>
                </select>
              </Field>
            </FormGrid>
            <p id="bp-tz-hint" className="field-hint">
              המיקוד מתמלא מ-Google כשקיים ועשוי לכלול אותיות במדינות מסוימות; שמירתו מעדכנת מיד את מוכנות
              הערוצים. אזור הזמן הקנוני נקבע ברמת הארגון ואינו נערך כאן.
            </p>
            {isSuperAdmin && coordsTyped && (
              <>
                <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
                  Google Maps הוא המקור המועדף למיקום. דריסה ידנית מבטלת את המיקום שנבחר ב-Google — יש להזין
                  קואורדינטות מדויקות ולאשר במפורש.
                </p>
                <label className="flex items-center gap-2 text-xs font-semibold text-text2">
                  <input
                    type="checkbox"
                    checked={manualConfirm}
                    onChange={(e) => setManualConfirm(e.target.checked)}
                  />
                  אני מאשר/ת דריסה ידנית של המיקום
                </label>
              </>
            )}
          </div>
        )}
      </div>

      {/* ONE primary save. Which action it runs follows what is pending: a
          selected place / dragged marker first, then a typed coordinate override,
          then the postal code on its own. */}
      <div className="bp-save-row">
        {pending ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => saveLocation(pending.place, pending.source)}
          >
            <Icon name="check" size={20} />
            {saving ? "שומר…" : "שמירת מיקום"}
          </button>
        ) : coordsTyped ? (
          <button type="button" className="btn btn-primary" disabled={saving || !manualConfirm} onClick={onManualSave}>
            <Icon name="check" size={20} />
            {saving ? "שומר…" : "שמירת מיקום"}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={saving || !postalDirty} onClick={onPostalSave}>
            <Icon name="check" size={20} />
            {saving ? "שומר…" : "שמירת מיקום"}
          </button>
        )}
        {unsaved && <span className="field-hint">יש שינויים שלא נשמרו</span>}
      </div>
    </div>
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
  if (s === "google_place") return "נבחר ב-Google";
  if (s === "google_marker_adjustment") return "סומן והותאם ב-Google";
  if (s === "manual_override") return "דריסה ידנית";
  return null;
}

// One summary cell: 13.5px/700 label over a 15px/700 value. Technical values
// (time zone, coordinates) are monospace and LTR; an empty value prints "—" in
// the reference's faint tint; a Google-sourced origin reads green.
function Cell({
  label,
  value,
  mono,
  ok,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  ok?: boolean;
}) {
  const empty = !value;
  const cls =
    "bp-sum-v" +
    (empty ? " empty" : "") +
    (mono && !empty ? " ltr bp-mono" : "") +
    (ok && !empty ? " ok" : "");
  return (
    <div className="bp-sum-cell">
      <span className="bp-sum-k">{label}</span>
      <span className={cls} title={value ?? undefined}>
        {value || "—"}
      </span>
    </div>
  );
}
