// ============================================================
// Canonical Business Profile — PURE logic (no IO, no secrets, no fetch).
// Separates three identities that were previously conflated on tenants.name:
//   • APPLICATION identity  = "GuestHub" (the PMS product) — NEVER produced here.
//   • BUSINESS identity      = the operator's public business (businessName…).
//   • PROPERTY identity      = the public accommodation (propertyName…).
// Canonical currency + timezone always come from the tenant and are never
// overwritten or fabricated. Missing values are reported missing, never guessed.
// Channex CONSUMES this profile (buildChannexUpdatePayload) — it is not a source
// of truth. Exported pure so scripts/check-business-profile.mjs can assert it
// without a DB, a socket, or a Google key.
// ============================================================

export type LocationSource = "google_place" | "google_marker_adjustment" | "manual_override";
export const LOCATION_SOURCES: LocationSource[] = [
  "google_place",
  "google_marker_adjustment",
  "manual_override",
];

// Channex-supported property types (staging). Kept as a closed set so the UI
// offers a dropdown and the server rejects anything else.
export const PROPERTY_TYPES = [
  "apartment",
  "hotel",
  "hostel",
  "guest_house",
  "bed_and_breakfast",
  "villa",
  "resort",
  "motel",
  "boutique_hotel",
  "cottage",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
const DEFAULT_PROPERTY_TYPE: PropertyType = "apartment";

// The tenant's canonical, non-negotiable values. `fallbackName` (tenants.name)
// is used ONLY as a guest-facing DISPLAY fallback — never as canonical business/
// property identity, and it is never the literal application name "GuestHub".
export type BusinessTenant = {
  tenantId: string;
  currency: string;
  timezone: string;
  fallbackName: string;
};

// What is persisted in tenants.settings->'business_profile' (jsonb). Every field
// optional; absence = "not provided" (never a default).
export type StoredBusinessProfile = {
  businessName?: string | null;
  slogan?: string | null;
  logo?: string | null; // served URL reference, e.g. /uploads/logos/<tid>/<uuid>.png
  propertyName?: string | null;
  propertySubtitle?: string | null;
  propertyType?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  googlePlaceId?: string | null;
  formattedAddress?: string | null;
  country?: string | null; // display name, e.g. "ישראל" / "Israel"
  countryCode?: string | null; // ISO-3166-1 alpha-2, upper, e.g. "IL"
  city?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationVerifiedAt?: string | null;
  locationSource?: LocationSource | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

// Resolved profile handed to the UI + consumers. Raw identity fields stay null
// when unset (so /channels can show "incomplete"); publicBusinessName/
// publicPropertyName carry the guest-facing display fallback.
export type BusinessProfile = {
  businessName: string | null;
  slogan: string | null;
  logo: string | null;
  propertyName: string | null;
  propertySubtitle: string | null;
  propertyType: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  googlePlaceId: string | null;
  formattedAddress: string | null;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  street: string | null;
  streetNumber: string | null;
  postalCode: string | null;
  currency: string; // canonical (tenant)
  timezone: string; // canonical (tenant)
  latitude: number | null;
  longitude: number | null;
  locationVerifiedAt: string | null;
  locationSource: LocationSource | null;
  updatedAt: string | null;
  // guest-facing display — never the application name
  publicBusinessName: string;
  publicPropertyName: string;
};

function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function cleanNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function resolveBusinessProfile(
  tenant: BusinessTenant,
  stored: StoredBusinessProfile | null | undefined,
): BusinessProfile {
  const s = stored ?? {};
  const businessName = cleanStr(s.businessName);
  const propertyName = cleanStr(s.propertyName);
  return {
    businessName,
    slogan: cleanStr(s.slogan),
    logo: cleanStr(s.logo),
    propertyName,
    propertySubtitle: cleanStr(s.propertySubtitle),
    propertyType: cleanStr(s.propertyType) ?? DEFAULT_PROPERTY_TYPE,
    email: cleanStr(s.email),
    phone: cleanStr(s.phone),
    website: cleanStr(s.website),
    googlePlaceId: cleanStr(s.googlePlaceId),
    formattedAddress: cleanStr(s.formattedAddress),
    country: cleanStr(s.country),
    countryCode: cleanStr(s.countryCode),
    city: cleanStr(s.city),
    street: cleanStr(s.street),
    streetNumber: cleanStr(s.streetNumber),
    postalCode: cleanStr(s.postalCode),
    currency: tenant.currency,
    timezone: tenant.timezone,
    latitude: cleanNum(s.latitude),
    longitude: cleanNum(s.longitude),
    locationVerifiedAt: cleanStr(s.locationVerifiedAt),
    locationSource: cleanStr(s.locationSource) as LocationSource | null,
    updatedAt: cleanStr(s.updatedAt),
    // fallback chain never reaches the app name — tenants.name is a real name.
    publicBusinessName: businessName ?? tenant.fallbackName,
    publicPropertyName: propertyName ?? businessName ?? tenant.fallbackName,
  };
}

// ---- completion vs channel readiness (§10) ----
export type ProfileCheckItem = { key: string; label: string; present: boolean };
export type BusinessProfileStatus = {
  // enough to consider the business identity "set" (NOT a save gate — saving a
  // partial profile is allowed)
  businessComplete: boolean;
  businessItems: ProfileCheckItem[];
  // enough to later connect Booking.com/Expedia
  channelReady: boolean;
  channelItems: ProfileCheckItem[];
};

export function computeBusinessProfileStatus(p: BusinessProfile): BusinessProfileStatus {
  const businessItems: ProfileCheckItem[] = [
    { key: "businessName", label: "שם העסק", present: !!p.businessName },
    { key: "propertyName", label: "שם הנכס", present: !!p.propertyName },
  ];
  const channelItems: ProfileCheckItem[] = [
    { key: "propertyName", label: "שם הנכס", present: !!p.propertyName },
    { key: "email", label: "דוא״ל ציבורי", present: !!p.email },
    { key: "phone", label: "טלפון", present: !!p.phone },
    { key: "countryCode", label: "מדינה", present: !!p.countryCode },
    { key: "city", label: "עיר", present: !!p.city },
    { key: "address", label: "כתובת מלאה", present: !!p.formattedAddress },
    { key: "postalCode", label: "מיקוד", present: !!p.postalCode },
    { key: "timezone", label: "אזור זמן", present: !!p.timezone },
    { key: "latitude", label: "קו רוחב", present: p.latitude !== null },
    { key: "longitude", label: "קו אורך", present: p.longitude !== null },
    { key: "propertyType", label: "סוג נכס", present: !!p.propertyType },
  ];
  return {
    businessComplete: businessItems.every((i) => i.present),
    businessItems,
    channelReady: channelItems.every((i) => i.present),
    channelItems,
  };
}

// ---- Channex external title (§13) ----
// External Staging title = "<property_name> (Staging)". The suffix is external-
// only and is NEVER stored back into the canonical property name.
const STAGING_SUFFIX = " (Staging)";
export function channexStagingTitle(propertyName: string): string {
  return `${propertyName}${STAGING_SUFFIX}`;
}

// ---- Channex PUT payload (§13/§14) ----
// Consumes the canonical Business Profile. Only Channex-supported profile fields.
// Returns null when there is no canonical property name to build a title from
// (we never fabricate one and never blank the existing external title).
export function buildChannexUpdatePayload(
  p: BusinessProfile,
): { property: Record<string, unknown> } | null {
  if (!p.propertyName) return null;
  const attrs: Record<string, unknown> = {
    title: channexStagingTitle(p.propertyName),
    currency: p.currency,
    property_type: p.propertyType,
  };
  if (p.timezone) attrs.timezone = p.timezone;
  if (p.email) attrs.email = p.email;
  if (p.phone) attrs.phone = p.phone;
  if (p.website) attrs.website = p.website;
  if (p.countryCode) attrs.country = p.countryCode; // Channex expects ISO alpha-2
  if (p.city) attrs.city = p.city;
  if (p.formattedAddress) attrs.address = p.formattedAddress;
  if (p.postalCode) attrs.zip_code = p.postalCode;
  if (p.latitude !== null) attrs.latitude = String(p.latitude);
  if (p.longitude !== null) attrs.longitude = String(p.longitude);
  return { property: attrs };
}

// Honest before/after for the update confirmation modal. Compares the fields we
// actually retain in the mapping snapshot against the proposed payload; keys the
// snapshot doesn't carry are reported with from=null so the UI shows "(לא ידוע)".
export type ChannexFieldChange = { key: string; from: unknown; to: unknown };
const SNAPSHOT_KEY: Record<string, string> = {
  title: "title",
  currency: "currency",
  property_type: "property_type",
  timezone: "timezone",
  country: "country",
  city: "city",
  address: "address",
  zip_code: "zip_code",
  email: "email",
  phone: "phone",
  website: "website",
  latitude: "latitude",
  longitude: "longitude",
};
export function diffChannexUpdate(
  snapshot: Record<string, unknown> | null,
  proposed: Record<string, unknown>,
): ChannexFieldChange[] {
  const snap = snapshot ?? {};
  const out: ChannexFieldChange[] = [];
  for (const [key, to] of Object.entries(proposed)) {
    const from = snap[SNAPSHOT_KEY[key] ?? key] ?? null;
    if (String(from ?? "") !== String(to ?? "")) out.push({ key, from, to });
  }
  return out;
}

// ---- input validation (§10) ----
// Server-authoritative. Returns a cleaned patch of ONLY the provided keys (blank
// string clears a field to null; absent key is untouched) or a Hebrew error.
export type BusinessProfileInput = Partial<
  Record<
    | "businessName"
    | "slogan"
    | "propertyName"
    | "propertySubtitle"
    | "propertyType"
    | "email"
    | "phone"
    | "website",
    string | null
  >
>;

const MAX = {
  businessName: 200,
  slogan: 300,
  propertyName: 200,
  propertySubtitle: 200,
  email: 320,
  phone: 40,
  website: 300,
  address: 500,
  city: 120,
  country: 120,
  street: 200,
  streetNumber: 40,
  postalCode: 40,
  placeId: 300,
} as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[+()\-\s0-9]{4,40}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{1,300}$/;

// trim + cap; "" (explicit clear) → null; absent → undefined (leave untouched)
function field(v: string | null | undefined, cap: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, cap);
}

export type ValidatedPatch = { ok: true; patch: StoredBusinessProfile } | { ok: false; error: string };

export function validateBusinessProfileInput(input: BusinessProfileInput): ValidatedPatch {
  const patch: StoredBusinessProfile = {};
  const set = <K extends keyof StoredBusinessProfile>(k: K, v: StoredBusinessProfile[K] | undefined) => {
    if (v !== undefined) patch[k] = v;
  };

  set("businessName", field(input.businessName, MAX.businessName));
  set("slogan", field(input.slogan, MAX.slogan));
  set("propertyName", field(input.propertyName, MAX.propertyName));
  set("propertySubtitle", field(input.propertySubtitle, MAX.propertySubtitle));

  if (input.propertyType !== undefined) {
    const pt = (input.propertyType ?? "").trim();
    if (pt !== "" && !PROPERTY_TYPES.includes(pt as PropertyType))
      return { ok: false, error: "סוג נכס לא תקין" };
    patch.propertyType = pt === "" ? null : pt;
  }

  const email = field(input.email, MAX.email);
  if (email !== undefined) {
    if (email !== null && !EMAIL_RE.test(email)) return { ok: false, error: "כתובת דוא״ל אינה תקינה" };
    patch.email = email;
  }
  const phone = field(input.phone, MAX.phone);
  if (phone !== undefined) {
    if (phone !== null && !PHONE_RE.test(phone)) return { ok: false, error: "מספר טלפון אינו תקין" };
    patch.phone = phone;
  }
  const website = field(input.website, MAX.website);
  if (website !== undefined) {
    if (website !== null && !isHttpUrl(website)) return { ok: false, error: "כתובת אתר אינה תקינה (http/https)" };
    patch.website = website;
  }
  return { ok: true, patch };
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---- location validation (§5/§6) ----
export type LocationInput = {
  source: LocationSource;
  latitude: number | null;
  longitude: number | null;
  googlePlaceId?: string | null;
  formattedAddress?: string | null;
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  street?: string | null;
  streetNumber?: string | null;
  postalCode?: string | null;
};

export function validateLocationInput(input: LocationInput): ValidatedPatch {
  if (!LOCATION_SOURCES.includes(input.source)) return { ok: false, error: "מקור מיקום לא תקין" };
  const lat = input.latitude;
  const lng = input.longitude;
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng))
    return { ok: false, error: "יש לבחור מיקום עם קואורדינטות תקינות" };
  if (lat < -90 || lat > 90) return { ok: false, error: "קו רוחב חייב להיות בין -90 ל-90" };
  if (lng < -180 || lng > 180) return { ok: false, error: "קו אורך חייב להיות בין -180 ל-180" };

  const patch: StoredBusinessProfile = { latitude: lat, longitude: lng, locationSource: input.source };

  if (input.googlePlaceId != null && input.googlePlaceId !== "") {
    if (!PLACE_ID_RE.test(input.googlePlaceId)) return { ok: false, error: "מזהה מקום של Google אינו תקין" };
    patch.googlePlaceId = input.googlePlaceId;
  } else if (input.source === "manual_override") {
    patch.googlePlaceId = null; // manual coords are not tied to a Google place
  }

  if (input.countryCode != null && input.countryCode !== "") {
    if (!/^[A-Za-z]{2}$/.test(input.countryCode)) return { ok: false, error: "קוד מדינה חייב להיות שתי אותיות (ISO-2)" };
    patch.countryCode = input.countryCode.toUpperCase();
  }
  const opt = (v: string | null | undefined, cap: number) => (v == null ? undefined : field(v, cap));
  const setIf = <K extends keyof StoredBusinessProfile>(k: K, v: StoredBusinessProfile[K] | undefined) => {
    if (v !== undefined) patch[k] = v;
  };
  setIf("formattedAddress", opt(input.formattedAddress, MAX.address));
  setIf("country", opt(input.country, MAX.country));
  setIf("city", opt(input.city, MAX.city));
  setIf("street", opt(input.street, MAX.street));
  setIf("streetNumber", opt(input.streetNumber, MAX.streetNumber));
  setIf("postalCode", opt(input.postalCode, MAX.postalCode));
  return { ok: true, patch };
}
