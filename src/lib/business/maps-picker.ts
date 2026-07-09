// ============================================================
// Google Maps picker lifecycle — browser-only, but DEPENDENCY-INJECTED so every
// rule below is asserted by scripts/check-maps-picker.mjs without a browser.
//
// The D61 defect this module exists to prevent:
//   The bootstrap script was loaded with `loading=async&libraries=places,...`
//   and the code resolved on `script.onload`. At that moment `google.maps`
//   exists and `google.maps.importLibrary` is a function, but
//   `google.maps.places` is STILL UNDEFINED — the library chunks arrive later.
//   `new google.maps.places.PlaceAutocompleteElement()` therefore threw
//   "Cannot read properties of undefined (reading 'PlaceAutocompleteElement')",
//   which a bare .catch() converted into a generic "load failed" banner.
//
// Rule: after the bootstrap resolves, a library is usable ONLY once
// `await google.maps.importLibrary(name)` has resolved. Never read
// `google.maps.<library>` off the namespace directly.
// ============================================================

import { MapsError } from "./maps-errors";
import { normalizeGooglePlace, placeHasCoordinates, type NormalizedPlace } from "./google-place";

// ---- minimal typed surface of the Maps JS SDK (no `any`) ----
export type LatLngLiteral = { lat: number; lng: number };

export interface PlaceObj {
  fetchFields(opts: { fields: string[] }): Promise<unknown>;
  toJSON(): Parameters<typeof normalizeGooglePlace>[0];
}
export type GmpSelectEvent = { placePrediction?: { toPlace(): PlaceObj } | null };

// The widget IS an HTMLElement (a custom element). Typed as such so a real
// container accepts it; the check script passes structural fakes at runtime.
export type AutocompleteElement = HTMLElement;
export type AutocompleteHost = HTMLElement;
export interface PlacesLibrary {
  PlaceAutocompleteElement: new (opts?: Record<string, unknown>) => AutocompleteElement;
}
export interface MapObj {
  setCenter(p: LatLngLiteral): void;
  setZoom(z: number): void;
}
export interface MarkerObj {
  setPosition(p: LatLngLiteral): void;
  addListener(type: string, cb: (e: { latLng?: { lat(): number; lng(): number } | null }) => void): void;
  setMap(m: MapObj | null): void;
}
export interface MapsLibrary {
  Map: new (container: Element, opts: Record<string, unknown>) => MapObj;
}
export interface MarkerLibrary {
  Marker: new (opts: Record<string, unknown>) => MarkerObj;
}
export interface GeocodingLibrary {
  Geocoder: new () => {
    geocode(req: { location: LatLngLiteral }): Promise<{ results: Array<Parameters<typeof normalizeGooglePlace>[0]> }>;
  };
}
export interface MapsNamespace {
  importLibrary(name: string): Promise<unknown>;
}

// The exact field set §3 requires. Requested together in ONE fetchFields call.
export const REQUIRED_PLACE_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "addressComponents",
] as const;

export const BUILDING_ZOOM = 18;

declare global {
  interface Window {
    google?: { maps?: MapsNamespace };
    __ghMapsReady?: () => void;
  }
}

// ---- bootstrap ----
// Resolves ONLY when Google invokes our callback, at which point
// `google.maps.importLibrary` is guaranteed present. No `libraries=` param: a
// library in the URL is a *hint*, not a guarantee that it is loaded on `onload`
// (that assumption is precisely what broke D61). The key is interpolated into
// the URL, so this URL must never be logged — see scrubSecrets().
let bootstrap: Promise<MapsNamespace> | null = null;

export function loadMapsApi(browserKey: string): Promise<MapsNamespace> {
  if (bootstrap) return bootstrap;
  bootstrap = new Promise<MapsNamespace>((resolve, reject) => {
    const existing = window.google?.maps;
    if (existing && typeof existing.importLibrary === "function") return resolve(existing);

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: browserKey,
      v: "weekly",
      loading: "async",
      language: "he",
      region: "IL",
      callback: "__ghMapsReady",
    });
    window.__ghMapsReady = () => {
      const maps = window.google?.maps;
      if (maps && typeof maps.importLibrary === "function") resolve(maps);
      else reject(mapsErr("MAPS_SCRIPT_LOAD_FAILED", new Error("importLibrary missing after callback")));
    };
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => {
      bootstrap = null; // allow a retry after a transient network failure
      reject(mapsErr("MAPS_SCRIPT_LOAD_FAILED", new Error("script network error")));
    };
    document.head.appendChild(script);
  });
  return bootstrap;
}

// ---- library imports: each failure gets its own code ----
async function importLib<T>(maps: MapsNamespace, name: string, code: Parameters<typeof mapsErr>[0]): Promise<T> {
  try {
    const lib = await maps.importLibrary(name);
    if (!lib || typeof lib !== "object") throw new Error(`empty library: ${name}`);
    return lib as T;
  } catch (e) {
    throw mapsErr(code, e);
  }
}
const mapsErr = (code: ConstructorParameters<typeof MapsError>[0], cause?: unknown) => new MapsError(code, cause);

export const importPlaces = (m: MapsNamespace) =>
  importLib<PlacesLibrary>(m, "places", "PLACES_LIBRARY_INIT_FAILED");
export const importMaps = (m: MapsNamespace) => importLib<MapsLibrary>(m, "maps", "MAPS_LIBRARY_INIT_FAILED");
export const importMarker = (m: MapsNamespace) => importLib<MarkerLibrary>(m, "marker", "MARKER_RENDER_FAILED");
export const importGeocoding = (m: MapsNamespace) =>
  importLib<GeocodingLibrary>(m, "geocoding", "GEOCODING_FAILED");

// ---- place selection: gmp-select → toPlace() → fetchFields() → normalized ----
// Never trusts the event to carry a populated place. A place without real
// coordinates is rejected, never saved, and never back-filled with a guess.
export async function resolveSelectedPlace(ev: GmpSelectEvent): Promise<NormalizedPlace> {
  const prediction = ev?.placePrediction;
  if (!prediction || typeof prediction.toPlace !== "function") throw mapsErr("PLACE_SELECTION_FAILED");

  let place: PlaceObj;
  try {
    place = prediction.toPlace();
    await place.fetchFields({ fields: [...REQUIRED_PLACE_FIELDS] });
  } catch (e) {
    throw mapsErr("PLACE_DETAILS_FAILED", e);
  }

  const normalized = normalizeGooglePlace(place.toJSON());
  if (!placeHasCoordinates(normalized)) throw mapsErr("PLACE_WITHOUT_LOCATION");
  return normalized;
}

// ---- autocomplete widget: created once per host, cleanly torn down ----
// React Strict Mode double-invokes effects. The host guard makes a second mount
// a no-op instead of appending a duplicate widget, and cleanup detaches the
// listener AND removes the element so a remount starts from an empty host.
const mounted = new WeakMap<AutocompleteHost, AutocompleteElement>();

export function mountAutocomplete(opts: {
  host: AutocompleteHost;
  places: PlacesLibrary;
  onSelect: (place: NormalizedPlace) => void;
  onError: (e: unknown) => void;
}): () => void {
  const { host, places, onSelect, onError } = opts;
  if (mounted.has(host)) return () => {}; // already mounted — never append twice

  let el: AutocompleteElement;
  try {
    el = new places.PlaceAutocompleteElement();
    el.style.width = "100%";
  } catch (e) {
    onError(mapsErr("AUTOCOMPLETE_WIDGET_INIT_FAILED", e));
    return () => {};
  }

  // `gmp-select` is the current event. The legacy `gmp-placeselect` / the legacy
  // `place_changed` + PlaceResult shape are NOT used anywhere.
  const listener = (e: Event) => {
    void resolveSelectedPlace(e as unknown as GmpSelectEvent).then(onSelect, onError);
  };
  el.addEventListener("gmp-select", listener);
  host.appendChild(el);
  mounted.set(host, el);

  return () => {
    el.removeEventListener("gmp-select", listener);
    el.remove();
    mounted.delete(host);
  };
}

// ---- map + marker ----
// ponytail: classic google.maps.Marker, not AdvancedMarkerElement. Advanced
// markers require a Cloud-configured mapId, and §6 forbids inventing new Google
// Cloud configuration to unblock the basic picker. Upgrade to
// AdvancedMarkerElement if/when a real mapId exists in the tenant config.
export function renderMap(mapsLib: MapsLibrary, container: Element | null, center: LatLngLiteral): MapObj {
  if (!container) throw mapsErr("MAP_CONTAINER_MISSING");
  try {
    return new mapsLib.Map(container, {
      center,
      zoom: BUILDING_ZOOM,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
  } catch (e) {
    throw mapsErr("MAP_RENDER_FAILED", e);
  }
}

export function renderMarker(
  markerLib: MarkerLibrary,
  map: MapObj,
  position: LatLngLiteral,
  onDragEnd: (p: LatLngLiteral) => void,
): MarkerObj {
  try {
    const marker = new markerLib.Marker({ map, position, draggable: true });
    marker.addListener("dragend", (e) => {
      const lat = e.latLng?.lat();
      const lng = e.latLng?.lng();
      if (typeof lat === "number" && typeof lng === "number") onDragEnd({ lat, lng });
    });
    return marker;
  } catch (e) {
    throw mapsErr("MARKER_RENDER_FAILED", e);
  }
}

// Reverse geocode a dragged marker. The resolved address is shown SEPARATELY for
// the operator to confirm — it never silently overwrites the selected Google
// address, and a geocoding failure never invalidates the coordinates.
export async function reverseGeocode(lib: GeocodingLibrary, at: LatLngLiteral): Promise<NormalizedPlace | null> {
  try {
    const { results } = await new lib.Geocoder().geocode({ location: at });
    const first = results?.[0];
    return first ? normalizeGooglePlace(first) : null;
  } catch {
    return null; // GEOCODING_FAILED is advisory — coordinates stay valid
  }
}
