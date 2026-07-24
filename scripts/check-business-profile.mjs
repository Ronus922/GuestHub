// Runnable checks for the canonical Business Profile logic (D61): compile the
// PURE modules with tsc, import them, assert. Covers identity separation
// (GuestHub is never a default business/property name), no fabrication,
// validation, and the Google place normalizer (new + legacy shapes, no
// invented coordinates).
// Usage: node scripts/check-business-profile.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "biz-prof-"));
execSync(
  `pnpm exec tsc src/lib/business/profile.ts src/lib/business/google-place.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const p = require(join(out, "profile.js"));
const g = require(join(out, "google-place.js"));

const tenant = { tenantId: "t1", currency: "ILS", timezone: "Asia/Jerusalem", fallbackName: "גינות הים · תל אביב" };

// ============================================================
// identity — GuestHub is never a default business/property name
// ============================================================
const empty = p.resolveBusinessProfile(tenant, null);
assert.equal(empty.businessName, null, "business name is NOT fabricated");
assert.equal(empty.propertyName, null, "property name is NOT fabricated");
assert.notEqual(empty.publicBusinessName, "GuestHub", "app name is never the business fallback");
assert.equal(empty.publicBusinessName, tenant.fallbackName, "display fallback is the tenant name");
assert.equal(empty.currency, "ILS", "canonical currency reused");
assert.equal(empty.timezone, "Asia/Jerusalem", "canonical timezone reused");
assert.equal(empty.propertyType, "apartment", "property_type default");

// business name and property name are independent
const both = p.resolveBusinessProfile(tenant, { businessName: "בית מלון הים", propertyName: "מגדל הים" });
assert.equal(both.businessName, "בית מלון הים");
assert.equal(both.propertyName, "מגדל הים");
assert.notEqual(both.businessName, both.propertyName, "identities are independent");
// property display falls back to business name, then tenant name — never app name
assert.equal(
  p.resolveBusinessProfile(tenant, { businessName: "רק עסק" }).publicPropertyName,
  "רק עסק",
  "property display falls back to business name",
);

// ============================================================
// status — completion vs channel readiness
// ============================================================
assert.equal(p.computeBusinessProfileStatus(empty).businessComplete, false, "empty → not complete");
const full = p.resolveBusinessProfile(tenant, {
  businessName: "עסק", propertyName: "נכס", email: "a@b.co", phone: "+972500000000",
  countryCode: "IL", city: "תל אביב", formattedAddress: "רוטשילד 1, תל אביב", postalCode: "6688101",
  latitude: 32.08, longitude: 34.78,
});
const st = p.computeBusinessProfileStatus(full);
assert.equal(st.businessComplete, true, "business+property present → complete");
assert.equal(st.channelReady, true, "all channel fields present → channel ready");

// ============================================================
// validation
// ============================================================
assert.equal(p.validateBusinessProfileInput({ email: "bad" }).ok, false, "bad email rejected");
assert.equal(p.validateBusinessProfileInput({ website: "ftp://x" }).ok, false, "non-http url rejected");
assert.equal(p.validateBusinessProfileInput({ propertyType: "castle" }).ok, false, "unknown property type rejected");
assert.equal(p.validateBusinessProfileInput({ phone: "!!!" }).ok, false, "bad phone rejected");
const okv = p.validateBusinessProfileInput({ businessName: "  X  ", email: "a@b.co", propertyType: "villa" });
assert.equal(okv.ok, true);
assert.equal(okv.patch.businessName, "X", "trimmed");
assert.equal(okv.patch.email, "a@b.co");
// blank string clears to null; absent key untouched
assert.equal(p.validateBusinessProfileInput({ businessName: "" }).patch.businessName, null, "blank clears to null");
assert.ok(!("propertyName" in p.validateBusinessProfileInput({ businessName: "x" }).patch), "absent key untouched");

// ---- postal code: canonical, editable, trimmed text (NOT numeric-only) ----
const pc = (v) => p.validateBusinessProfileInput({ postalCode: v });
assert.equal(pc(" 3508107 ").patch.postalCode, "3508107", "postal code trimmed");
assert.equal(pc("SW1A 1AA").patch.postalCode, "SW1A 1AA", "letters allowed (UK) — never numeric-only");
assert.equal(pc("K1A 0B1").patch.postalCode, "K1A 0B1", "letters allowed (Canada)");
assert.equal(pc("1012 AB").patch.postalCode, "1012 AB", "letters allowed (Netherlands)");
assert.equal(pc("").patch.postalCode, null, "blank clears the postal code to null");
assert.equal(pc("x".repeat(80)).patch.postalCode.length, 40, "postal code capped at 40 chars");
assert.equal(pc("6688101").ok, true, "a valid postal code saves without error");
assert.ok(!("postalCode" in p.validateBusinessProfileInput({ businessName: "x" }).patch), "absent postal code is untouched");
// the profile save action is the ONE write path the postal field uses
const bizActions = readFileSync("src/app/(dashboard)/settings/business-actions.ts", "utf8");
assert.ok(bizActions.includes("validateBusinessProfileInput"), "postal code goes through the canonical validator");
const picker = readFileSync("src/app/(dashboard)/settings/LocationPicker.tsx", "utf8");
assert.ok(picker.includes("saveBusinessProfileAction({ postalCode:"), "postal code saves to the Business Profile immediately");
assert.ok(/streetNumber[\s\S]{0,400}PostalCodeField[\s\S]{0,400}label="עיר"/.test(picker), "postal field sits after street/number and before city/country");
assert.ok(!/type="number"|inputMode="numeric"/.test(picker.slice(picker.indexOf("function PostalCodeField"))), "postal input is text, not numeric-only");

// location validation
assert.equal(p.validateLocationInput({ source: "google_place", latitude: null, longitude: null }).ok, false, "no coords → error");
assert.equal(p.validateLocationInput({ source: "google_place", latitude: 91, longitude: 0 }).ok, false, "lat out of range");
assert.equal(p.validateLocationInput({ source: "google_place", latitude: 0, longitude: 181 }).ok, false, "lng out of range");
assert.equal(p.validateLocationInput({ source: "bogus", latitude: 0, longitude: 0 }).ok, false, "bad source");
const locv = p.validateLocationInput({ source: "google_place", latitude: 32.08, longitude: 34.78, countryCode: "il", googlePlaceId: "ChIJ_abc-123", city: "תל אביב" });
assert.equal(locv.ok, true);
assert.equal(locv.patch.countryCode, "IL", "country code upper-cased");
assert.equal(locv.patch.locationSource, "google_place");
assert.equal(locv.patch.latitude, 32.08);
assert.equal(p.validateLocationInput({ source: "google_place", latitude: 0, longitude: 0, googlePlaceId: "bad id!" }).ok, false, "bad place id rejected");

// ============================================================
// google place normalizer — no fabrication, both shapes
// ============================================================
const newShape = {
  id: "ChIJ123",
  formattedAddress: "Rothschild Blvd 1, Tel Aviv-Yafo, Israel",
  location: { lat: () => 32.06, lng: () => 34.77 },
  addressComponents: [
    { types: ["country"], longText: "Israel", shortText: "il" },
    { types: ["locality"], longText: "Tel Aviv-Yafo", shortText: "TLV" },
    { types: ["route"], longText: "Rothschild Blvd" },
    { types: ["street_number"], longText: "1" },
    { types: ["postal_code"], longText: "6688101" },
  ],
};
const n1 = g.normalizeGooglePlace(newShape);
assert.equal(n1.googlePlaceId, "ChIJ123");
assert.equal(n1.countryCode, "IL", "country short code upper");
assert.equal(n1.country, "Israel");
assert.equal(n1.city, "Tel Aviv-Yafo");
assert.equal(n1.street, "Rothschild Blvd");
assert.equal(n1.postalCode, "6688101");
assert.equal(n1.latitude, 32.06, "lat from location() callable");
assert.equal(n1.longitude, 34.77, "lng from location() callable");
assert.equal(g.placeHasCoordinates(n1), true);

const legacyShape = {
  place_id: "P2",
  formatted_address: "Somewhere",
  geometry: { location: { lat: 40, lng: -70 } },
  address_components: [{ types: ["country"], long_name: "United States", short_name: "US" }],
};
const n2 = g.normalizeGooglePlace(legacyShape);
assert.equal(n2.googlePlaceId, "P2");
assert.equal(n2.countryCode, "US");
assert.equal(n2.latitude, 40);
assert.equal(n2.longitude, -70);
assert.equal(n2.city, null, "missing city is NOT fabricated");

const nEmpty = g.normalizeGooglePlace(null);
assert.equal(nEmpty.latitude, null, "no place → no coordinates fabricated");
assert.equal(g.placeHasCoordinates(nEmpty), false);

assert.ok(g.googleMapsLink({ latitude: 1, longitude: 2 }).includes("1,2"), "maps link from coords");
assert.ok(g.googleMapsLink({ placeId: "X", latitude: 1, longitude: 2 }).includes("query_place_id=X"), "maps link prefers place id");
assert.equal(g.googleMapsLink({}), null, "no coords/place → no link");

// ============================================================
// sidebar account-card identity line (formatPropertyIdentity)
// ============================================================
const identity = (stored) => p.formatPropertyIdentity(p.resolveBusinessProfile(tenant, stored));
const CANON = { propertyName: "מגדל הים", city: "חיפה" };

assert.equal(identity(CANON), "מגדל הים - חיפה", "property + city joined with a plain hyphen");
assert.ok(identity(CANON).includes(" - "), "separator is exactly space-hyphen-space");
assert.ok(!identity(CANON).includes(" · "), "middle-dot separator is never used");
assert.equal(identity({ ...CANON, businessName: "בית מלון הים" }), "מגדל הים - חיפה", "property beats business");
assert.equal(identity({ propertyName: "מגדל הים" }), "מגדל הים", "no city → no dangling separator");
assert.ok(!identity({ propertyName: "מגדל הים" }).includes("-"), "absent city renders no hyphen at all");
assert.equal(identity({ businessName: "בית מלון הים", city: "חיפה" }), "בית מלון הים - חיפה", "business + city when no property");
assert.equal(identity({ businessName: "בית מלון הים" }), "בית מלון הים", "business alone when no property/city");
assert.equal(identity({ propertyName: "  מגדל הים  ", city: "  חיפה  " }), "מגדל הים - חיפה", "values trimmed");
assert.equal(identity({ propertyName: "   ", city: "חיפה" }), p.IDENTITY_NOT_SET, "whitespace-only name + city → not-set, never a bare city");

// never the tenant/app identity
assert.equal(identity(null), p.IDENTITY_NOT_SET, "empty profile → neutral Hebrew fallback");
assert.equal(p.IDENTITY_NOT_SET, "פרופיל העסק לא הוגדר");
assert.notEqual(identity(null), tenant.fallbackName, "tenants.name is NOT the public identity");
assert.notEqual(identity(null), "GuestHub", "app name is never the property fallback");
assert.ok(!identity(CANON).includes("GuestHub"), "app name never appended");
assert.ok(!identity(CANON).includes("(Staging)"), "external title/suffix never displayed");

// tenant isolation: the formatter is pure — same tenant object, different stored
// profiles never bleed. The accessor is tenant-scoped by argument (asserted below).
assert.equal(identity({ propertyName: "נכס א" }), "נכס א");
assert.equal(identity({ propertyName: "נכס ב" }), "נכס ב", "no state retained between calls");

// ============================================================
// wiring — the sidebar reuses the canonical accessor, nothing else
// ============================================================
const src = (f) => readFileSync(f, "utf8");
const sidebar = src("src/components/layout/Sidebar.tsx");
const layout = src("src/app/(dashboard)/layout.tsx");
const store = src("src/lib/business/store.ts");
const section = src("src/app/(dashboard)/settings/BusinessProfileSection.tsx");

assert.ok(!sidebar.includes("actor.tenantName"), "sidebar no longer renders tenants.name");
assert.ok(!/מגדל הים|חיפה/.test(sidebar), "identity is not hardcoded in the sidebar");
assert.ok(sidebar.includes("propertyIdentity"), "sidebar renders the server-formatted identity");
assert.ok(/actor\.fullName \?\? actor\.username/.test(sidebar), "line 1 is still the authenticated user name");

assert.ok(layout.includes("getBusinessProfile(actor.tenantId)"), "layout reads the canonical accessor, tenant-scoped");
assert.ok(layout.includes("formatPropertyIdentity"), "layout uses the shared formatter");
assert.ok(!/getBusinessProfile\((?!actor\.tenantId)/.test(layout), "no unscoped profile read");

assert.ok(/SELECT[\s\S]*WHERE id = \$\{tenantId\}/.test(store), "accessor filters by the tenant id it is given");
assert.ok(!/^(const|let|var)\s+\w+\s*(:|=)\s*(new Map|\{\})/m.test(store), "no module-level profile cache (no cross-tenant bleed)");

assert.ok(section.includes("router.refresh()"), "save refreshes the router so the layout re-renders");
assert.ok(/async function reload\(\)[\s\S]{0,400}router\.refresh\(\)/.test(section), "refresh happens on every save path (identity/logo/location funnel through reload)");

// ============================================================
// formatPropertyIdentity — the ONE dashboard identity line (settings header,
// sidebar): canonical values only, " - " separator, honest not-set fallback.
// The internal tenants.name label must never surface through it.
// ============================================================
const fpi = (propertyName, businessName, city) =>
  p.formatPropertyIdentity({ propertyName, businessName, city });
assert.equal(fpi("מגדל הים", "בית מלון הים", "חיפה"), "מגדל הים - חיפה", "property + city");
assert.equal(fpi("מגדל הים", "בית מלון הים", null), "מגדל הים", "property without city — no dangling separator");
assert.equal(fpi(null, "בית מלון הים", "חיפה"), "בית מלון הים - חיפה", "business + city when property absent");
assert.equal(fpi(null, "בית מלון הים", null), "בית מלון הים", "business alone");
assert.equal(fpi("  מגדל הים  ", null, "  חיפה  "), "מגדל הים - חיפה", "whitespace trimmed");
assert.equal(fpi(null, null, null), p.IDENTITY_NOT_SET, "empty names → honest not-set line");
assert.equal(fpi(null, null, "חיפה"), p.IDENTITY_NOT_SET, "bare city never rendered without a name");
assert.equal(fpi("", "   ", "חיפה"), p.IDENTITY_NOT_SET, "blank strings behave as empty");
assert.ok(!fpi("מגדל הים", null, "חיפה").includes(" · "), "no middle-dot separator");
assert.ok(!fpi(null, null, null).includes("GuestHub"), "no application-name fallback");
assert.ok(!fpi("מגדל הים", null, "חיפה").includes("(Staging)"), "no external staging suffix");

// the settings page header renders THIS formatter — never actor.tenantName
const settingsPage = readFileSync("src/app/(dashboard)/settings/page.tsx", "utf8");
assert.ok(settingsPage.includes("formatPropertyIdentity"), "settings page uses the shared formatter");
assert.ok(!settingsPage.includes("actor.tenantName"), "settings page never passes the internal tenant label");
assert.ok(settingsPage.includes("IDENTITY_NOT_SET"), "settings page falls back to the honest not-set line");
const settingsShell = readFileSync("src/app/(dashboard)/settings/SettingsShell.tsx", "utf8");
assert.ok(!settingsShell.includes("tenantName"), "settings shell has no tenantName prop");
assert.ok(settingsShell.includes("propertyIdentity"), "settings shell renders the canonical identity line");
assert.ok(!sidebar.includes("tenantName"), "sidebar never reads the internal tenant label");
// the internal label must not even reach the CLIENT PAYLOAD: the streamed
// ActorContext excludes it (only the formatted identity crosses to the client)
const actorLib = readFileSync("src/lib/auth/actor.ts", "utf8");
const actorCtxBlock = actorLib.slice(actorLib.indexOf("export type ActorContext"), actorLib.indexOf("AuthorizationError"));
assert.ok(!actorCtxBlock.includes("tenantName"), "ActorContext (client payload) excludes the internal tenant label");
const toCtxBlock = actorLib.slice(actorLib.indexOf("export function toActorContext"));
assert.ok(!toCtxBlock.slice(0, 500).includes("tenantName"), "toActorContext never serializes the internal tenant label");
// Settings header and Sidebar consume the SAME formatter output (one identity)
assert.ok(layout.includes("formatPropertyIdentity") && settingsPage.includes("formatPropertyIdentity"),
  "settings and sidebar derive the identical canonical identity");

console.log("check-business-profile: all assertions passed ✓");
