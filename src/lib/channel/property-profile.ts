// ============================================================
// Channex property PROFILE — pure logic (D60). No IO, no fetch, no secrets.
// Assembles the external Channex-property profile from CANONICAL GuestHub
// values (tenants.name / currency / timezone) plus operator-completed
// integration overrides stored in tenants.settings->'channex_profile'.
//
// Invariants:
//  • Canonical GuestHub values are the source of truth and are never
//    overwritten. Overrides only ADD integration-only fields that GuestHub
//    does not model (country/city/address/contact/geo/property_type).
//  • Missing values are reported as missing — never fabricated.
//  • Creating the Channex property needs only { title, currency }. Everything
//    else is "required before connecting live channels" and surfaced as a
//    readiness checklist.
// Exported pure so scripts/check-channex-properties.mjs can assert it without
// a DB or a live socket.
// ============================================================

export type TenantIdentity = {
  tenantId: string;
  name: string; // canonical GuestHub business/property name (tenants.name)
  currency: string; // canonical (tenants.currency, expected ILS)
  timezone: string; // canonical (tenants.timezone, expected Asia/Jerusalem)
};

// Operator-completed integration-only overrides (tenants.settings.channex_profile).
// Every field is optional; absence means "not provided", never a default value.
export type ChannexProfileOverrides = {
  title?: string | null;
  country?: string | null; // ISO-3166-1 alpha-2, e.g. "IL"
  city?: string | null;
  address?: string | null;
  zipCode?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  propertyType?: string | null; // default 'apartment'
};

export type ChannexProfile = {
  title: string;
  currency: string;
  timezone: string;
  country: string | null;
  city: string | null;
  address: string | null;
  zipCode: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  propertyType: string;
};

const DEFAULT_PROPERTY_TYPE = "apartment";

function cleanStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function cleanNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

// Merge canonical identity + overrides into the resolved profile. Canonical
// currency/timezone always win; title defaults to "<name> (Staging)" but an
// override title is honored; integration-only fields come solely from overrides.
export function resolveChannexProfile(
  tenant: TenantIdentity,
  overrides: ChannexProfileOverrides | null | undefined,
): ChannexProfile {
  const o = overrides ?? {};
  return {
    title: cleanStr(o.title) ?? `${tenant.name} (Staging)`,
    currency: tenant.currency,
    timezone: tenant.timezone,
    country: cleanStr(o.country),
    city: cleanStr(o.city),
    address: cleanStr(o.address),
    zipCode: cleanStr(o.zipCode),
    email: cleanStr(o.email),
    phone: cleanStr(o.phone),
    website: cleanStr(o.website),
    latitude: cleanNum(o.latitude),
    longitude: cleanNum(o.longitude),
    propertyType: cleanStr(o.propertyType) ?? DEFAULT_PROPERTY_TYPE,
  };
}

// ---- readiness ----
export type ReadinessItem = { key: string; label: string; present: boolean };
export type Readiness = {
  // A) minimum to CREATE the Channex property
  canCreate: boolean;
  createItems: ReadinessItem[];
  // B) required before connecting live OTA channels (Booking.com/Expedia)
  liveReady: boolean;
  liveItems: ReadinessItem[];
};

export function computeReadiness(p: ChannexProfile): Readiness {
  const createItems: ReadinessItem[] = [
    { key: "title", label: "שם הנכס (Title)", present: !!p.title },
    { key: "currency", label: "מטבע", present: !!p.currency },
  ];
  const liveItems: ReadinessItem[] = [
    { key: "email", label: "אימייל ליצירת קשר", present: !!p.email },
    { key: "phone", label: "טלפון ליצירת קשר", present: !!p.phone },
    { key: "country", label: "מדינה", present: !!p.country },
    { key: "city", label: "עיר", present: !!p.city },
    { key: "address", label: "כתובת", present: !!p.address },
    { key: "zipCode", label: "מיקוד", present: !!p.zipCode },
    { key: "timezone", label: "אזור זמן", present: !!p.timezone },
    { key: "latitude", label: "קו רוחב", present: p.latitude !== null },
    { key: "longitude", label: "קו אורך", present: p.longitude !== null },
    { key: "propertyType", label: "סוג נכס", present: !!p.propertyType },
  ];
  return {
    canCreate: createItems.every((i) => i.present),
    createItems,
    liveReady: liveItems.every((i) => i.present),
    liveItems,
  };
}

// ---- create payload (§6) ----
// Integration-safe Channex property settings. min_stay_type is "both" because
// GuestHub stores arrival-based AND stay-through-based minimum-stay values
// independently (src/lib/rates/service.ts min_stay_arrival + min_stay_through,
// mirrored in src/lib/rate-plans/service.ts and rates/effective-state.ts) — so
// the property must honor both models. No restriction/rate/availability VALUES
// are sent here; this only configures the property itself.
export function buildCreatePropertyPayload(p: ChannexProfile): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    title: p.title,
    currency: p.currency,
    property_type: p.propertyType,
    // integration-safe property settings (§6)
    state_length: 500,
    min_stay_type: "both",
    cut_off_days: 0,
    cut_off_time: "00:00:00",
    max_day_advance: null,
    allow_availability_autoupdate_on_confirmation: false,
    allow_availability_autoupdate_on_modification: false,
    allow_availability_autoupdate_on_cancellation: false,
  };
  // Only include optional profile fields when actually present — never send an
  // empty/fabricated value.
  if (p.timezone) attrs.timezone = p.timezone;
  if (p.country) attrs.country = p.country;
  if (p.city) attrs.city = p.city;
  if (p.address) attrs.address = p.address;
  if (p.zipCode) attrs.zip_code = p.zipCode;
  if (p.email) attrs.email = p.email;
  if (p.phone) attrs.phone = p.phone;
  if (p.website) attrs.website = p.website;
  if (p.latitude !== null) attrs.latitude = String(p.latitude);
  if (p.longitude !== null) attrs.longitude = String(p.longitude);
  return { property: attrs };
}

// ---- room preview (read-only) ----
// Numeric-first ordering of room numbers ("2" < "10" < "10A" < "b"): rooms with
// a leading integer sort by that integer; ties and non-numeric fall back to a
// locale compare. Pure so the ordering is asserted in the check script.
export type PreviewRoomInput = {
  id: string;
  room_number: string;
  area_name: string | null;
  floor: string | null;
  room_type_name: string | null;
  is_active: boolean;
  status: string;
  min_occupancy: number | null;
  max_occupancy: number;
  max_adults: number;
  max_children: number;
  max_infants: number;
};

function roomNumberKey(rn: string): [number, string] {
  const m = /^\s*(\d+)/.exec(rn ?? "");
  return [m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY, (rn ?? "").toString()];
}

export function sortRoomsForPreview<T extends { room_number: string }>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => {
    const [an, as] = roomNumberKey(a.room_number);
    const [bn, bs] = roomNumberKey(b.room_number);
    if (an !== bn) return an - bn;
    return as.localeCompare(bs, "en");
  });
}
