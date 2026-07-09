// ============================================================
// Google Places → canonical location — PURE normalization (no IO, no SDK, no
// key). Turns a Google Place / Geocoder result into our Business Profile
// location fields. Tolerates both the new Places API shape
// (addressComponents[].{longText,shortText,types}) and the legacy shape
// (address_components[].{long_name,short_name,types}), and location as either
// {lat,lng} numbers or google.maps.LatLng-like {lat(),lng()} callables.
// Exported pure so the client picker AND scripts/check-business-profile.mjs use
// the exact same extraction — no coordinate is ever fabricated.
// ============================================================

export type NormalizedPlace = {
  googlePlaceId: string | null;
  formattedAddress: string | null;
  country: string | null; // display long name
  countryCode: string | null; // ISO alpha-2, upper
  city: string | null;
  street: string | null;
  streetNumber: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
};

type ComponentLike = {
  types?: string[];
  longText?: string | null;
  shortText?: string | null;
  long_name?: string | null;
  short_name?: string | null;
};

type PlaceLike = {
  id?: string | null;
  place_id?: string | null;
  placeId?: string | null;
  formattedAddress?: string | null;
  formatted_address?: string | null;
  addressComponents?: ComponentLike[] | null;
  address_components?: ComponentLike[] | null;
  location?: unknown;
  geometry?: { location?: unknown } | null;
};

const longOf = (c: ComponentLike) => c.longText ?? c.long_name ?? null;
const shortOf = (c: ComponentLike) => c.shortText ?? c.short_name ?? null;

function componentByType(components: ComponentLike[], type: string): ComponentLike | undefined {
  return components.find((c) => Array.isArray(c.types) && c.types.includes(type));
}

// google.maps.LatLng exposes lat()/lng() functions; the REST/JSON shape uses
// {lat,lng} or {latitude,longitude}. Read whichever is present, never invent.
function readLatLng(loc: unknown): { lat: number | null; lng: number | null } {
  if (!loc || typeof loc !== "object") return { lat: null, lng: null };
  const o = loc as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (typeof v === "function") {
      try {
        const r = (v as () => unknown)();
        return typeof r === "number" && Number.isFinite(r) ? r : null;
      } catch {
        return null;
      }
    }
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return {
    lat: num(o.lat) ?? num(o.latitude),
    lng: num(o.lng) ?? num(o.longitude),
  };
}

export function normalizeGooglePlace(place: PlaceLike | null | undefined): NormalizedPlace {
  const empty: NormalizedPlace = {
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
  };
  if (!place || typeof place !== "object") return empty;

  const components = place.addressComponents ?? place.address_components ?? [];
  const country = componentByType(components, "country");
  const cityComp =
    componentByType(components, "locality") ??
    componentByType(components, "postal_town") ??
    componentByType(components, "administrative_area_level_2");
  const route = componentByType(components, "route");
  const streetNumber = componentByType(components, "street_number");
  const postal = componentByType(components, "postal_code");

  const rawLoc = place.location ?? place.geometry?.location ?? null;
  const { lat, lng } = readLatLng(rawLoc);
  const cc = country ? shortOf(country) : null;

  return {
    googlePlaceId: place.id ?? place.place_id ?? place.placeId ?? null,
    formattedAddress: place.formattedAddress ?? place.formatted_address ?? null,
    country: country ? longOf(country) : null,
    countryCode: cc ? cc.toUpperCase() : null,
    city: cityComp ? longOf(cityComp) : null,
    street: route ? longOf(route) : null,
    streetNumber: streetNumber ? longOf(streetNumber) : null,
    postalCode: postal ? longOf(postal) : null,
    latitude: lat,
    longitude: lng,
  };
}

// A place is usable as a saved location only if it carries real coordinates.
export function placeHasCoordinates(p: NormalizedPlace): boolean {
  return p.latitude !== null && p.longitude !== null;
}

// Deep link to Google Maps for the "פתיחה ב-Google Maps" action. Prefers the
// place id (exact place) and falls back to coordinates. Pure string building —
// no key, safe to run with Maps unconfigured.
export function googleMapsLink(opts: {
  placeId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): string | null {
  if (opts.placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${opts.latitude ?? ""},${opts.longitude ?? ""}`,
    )}&query_place_id=${encodeURIComponent(opts.placeId)}`;
  }
  if (opts.latitude != null && opts.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${opts.latitude},${opts.longitude}`;
  }
  return null;
}
