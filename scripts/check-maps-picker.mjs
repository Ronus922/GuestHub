// Runnable checks for the Business Profile Google Maps picker (D62), same pattern
// as check-business-profile.mjs: compile the PURE/injected modules with tsc,
// import them, assert against fake Google libraries — no browser, no key, no network.
//
// The D61 defect these checks lock down: the picker resolved on `script.onload`
// and read `google.maps.places` directly, which is UNDEFINED at that moment when
// the bootstrap uses `loading=async`. The library must be obtained via
// `await importLibrary("places")`. Everything below asserts the repaired
// lifecycle, the current (non-deprecated) Places event/API surface, that nothing
// is fabricated or auto-saved, and that the browser key never leaks.
//
// Usage: node scripts/check-maps-picker.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "maps-picker-"));
execSync(
  `pnpm exec tsc src/lib/business/maps-picker.ts src/lib/business/maps-errors.ts src/lib/business/google-place.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const picker = require(join(out, "maps-picker.js"));
const errors = require(join(out, "maps-errors.js"));

// Structural assertions must read CODE, not prose: both files document the D61
// defect in comments that legitimately name the very APIs we forbid.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const PICKER_SRC = stripComments(readFileSync("src/lib/business/maps-picker.ts", "utf8"));
const COMPONENT_SRC = stripComments(readFileSync("src/app/(dashboard)/settings/LocationPicker.tsx", "utf8"));
const FAKE_KEY = "AIzaSyFAKEKEYFORTESTS_not_a_real_key_000";

let passed = 0;

// ============================================================
// fakes — the minimum Google surface the picker touches
// ============================================================
const TLV = { lat: 32.0853, lng: 34.7818 };

function fakePlaceJSON(over = {}) {
  return {
    id: "ChIJmxRbFHZMHRUR8Cy9G0Qkyhc",
    formattedAddress: "הירקון 99, תל אביב-יפו",
    location: { lat: TLV.lat, lng: TLV.lng },
    addressComponents: [
      { types: ["street_number"], longText: "99", shortText: "99" },
      { types: ["route"], longText: "הירקון", shortText: "הירקון" },
      { types: ["locality"], longText: "תל אביב-יפו", shortText: "תל אביב-יפו" },
      { types: ["country"], longText: "ישראל", shortText: "IL" },
    ],
    ...over,
  };
}

// A PlaceAutocompleteElement stand-in that records listeners + removal.
function makeFakePlacesLib(spy) {
  return {
    PlaceAutocompleteElement: class {
      constructor() {
        spy.constructed++;
        this.style = { width: "" };
        this.listeners = new Map();
        this.removed = false;
        spy.last = this;
      }
      addEventListener(type, cb) {
        this.listeners.set(type, cb);
        spy.added.push(type);
      }
      removeEventListener(type) {
        this.listeners.delete(type);
        spy.removed.push(type);
      }
      remove() {
        this.removed = true;
      }
      emit(type, ev) {
        const cb = this.listeners.get(type);
        if (!cb) throw new Error(`no listener for ${type}`);
        cb(ev);
      }
    },
  };
}
const makeHost = () => ({ children: [], appendChild(el) { this.children.push(el); } });
const selectEvent = (json, opts = {}) => ({
  placePrediction: {
    toPlace: () => ({
      fetchFields: async (o) => {
        opts.onFetch?.(o);
        if (opts.throwOnFetch) throw new Error("upstream 500");
      },
      toJSON: () => json,
    }),
  },
});
const tick = () => new Promise((r) => setImmediate(r));

// ============================================================
// 1. library init goes through importLibrary — never off the namespace
// ============================================================
const calls = [];
const fakeMaps = {
  importLibrary: async (name) => {
    calls.push(name);
    if (name === "places") return makeFakePlacesLib({ constructed: 0, added: [], removed: [] });
    if (name === "maps") return { Map: class {} };
    if (name === "marker") return { Marker: class {} };
    if (name === "geocoding") return { Geocoder: class {} };
    throw new Error("unknown library");
  },
};

await (async () => {
  await picker.importPlaces(fakeMaps);
  await picker.importMaps(fakeMaps);
  await picker.importMarker(fakeMaps);
  await picker.importGeocoding(fakeMaps);
  assert.deepEqual(calls, ["places", "maps", "marker", "geocoding"], "all four libraries imported via importLibrary");
  passed += 4;
})();

// a failing importLibrary maps to the right code, not a generic failure
await (async () => {
  const boom = { importLibrary: async () => { throw new Error("network"); } };
  await assert.rejects(() => picker.importPlaces(boom), (e) => e.code === "PLACES_LIBRARY_INIT_FAILED");
  await assert.rejects(() => picker.importMaps(boom), (e) => e.code === "MAPS_LIBRARY_INIT_FAILED");
  passed += 2;
})();

// the regression itself: a namespace whose `.places` is undefined must not be
// silently trusted — importLibrary is the ONLY accessor in the module.
assert.ok(
  !/google\.maps\.places|maps\.places\.PlaceAutocompleteElement/.test(PICKER_SRC),
  "picker never reads google.maps.places directly",
);
assert.ok(/importLibrary\(/.test(PICKER_SRC), "picker calls importLibrary");
passed += 2;

// the bootstrap must not claim libraries via the URL (that was the false guarantee)
assert.ok(!/libraries=/.test(PICKER_SRC), "bootstrap URL carries no libraries= param");
assert.ok(/callback:\s*"__ghMapsReady"/.test(PICKER_SRC), "bootstrap resolves via Google's callback");
passed += 2;

// ============================================================
// 2. widget mounted exactly once; Strict Mode remount does not duplicate
// ============================================================
{
  const spy = { constructed: 0, added: [], removed: [] };
  const places = makeFakePlacesLib(spy);
  const host = makeHost();
  const cleanup = picker.mountAutocomplete({ host, places, onSelect: () => {}, onError: () => {} });
  assert.equal(host.children.length, 1, "widget appended exactly once");
  assert.equal(spy.constructed, 1);

  // second mount on the same host (Strict Mode double-invoke) → no duplicate
  picker.mountAutocomplete({ host, places, onSelect: () => {}, onError: () => {} });
  assert.equal(host.children.length, 1, "strict-mode remount does not duplicate the widget");
  assert.equal(spy.constructed, 1, "no second element constructed");

  // cleanup removes the listener AND the element
  cleanup();
  assert.deepEqual(spy.removed, ["gmp-select"], "cleanup removes the gmp-select listener");
  assert.equal(spy.last.removed, true, "cleanup removes the element from the DOM");

  // after cleanup the host is reusable
  picker.mountAutocomplete({ host, places, onSelect: () => {}, onError: () => {} });
  assert.equal(spy.constructed, 2, "host is mountable again after cleanup");
  passed += 7;
}

// listener is on the CURRENT event; the legacy one is nowhere
{
  const spy = { constructed: 0, added: [], removed: [] };
  const host = makeHost();
  picker.mountAutocomplete({ host, places: makeFakePlacesLib(spy), onSelect: () => {}, onError: () => {} });
  assert.deepEqual(spy.added, ["gmp-select"], "gmp-select is the only listener");
  passed++;
}
for (const legacy of ["gmp-placeselect", "AutocompleteService", "new google.maps.places.Autocomplete", "place_changed"]) {
  assert.ok(!PICKER_SRC.includes(legacy), `picker does not use legacy ${legacy}`);
  assert.ok(!COMPONENT_SRC.includes(legacy), `component does not use legacy ${legacy}`);
  passed += 2;
}

// ============================================================
// 3. selection: placePrediction.toPlace() → fetchFields(required) → normalized
// ============================================================
await (async () => {
  let requested = null;
  const place = await picker.resolveSelectedPlace(
    selectEvent(fakePlaceJSON(), { onFetch: (o) => (requested = o.fields) }),
  );
  assert.deepEqual(
    requested,
    ["id", "displayName", "formattedAddress", "location", "addressComponents"],
    "fetchFields requests exactly the required fields",
  );
  assert.equal(place.googlePlaceId, "ChIJmxRbFHZMHRUR8Cy9G0Qkyhc", "Google Place ID populated");
  assert.equal(place.latitude, TLV.lat, "latitude comes from the selected place");
  assert.equal(place.longitude, TLV.lng, "longitude comes from the selected place");
  assert.equal(place.city, "תל אביב-יפו", "normalized city");
  assert.equal(place.countryCode, "IL", "normalized country code");
  assert.equal(place.street, "הירקון", "normalized street");
  assert.equal(place.streetNumber, "99", "normalized street number");
  passed += 8;
})();

// missing optional components are reported missing, never fabricated
await (async () => {
  const noPostal = fakePlaceJSON({
    addressComponents: [{ types: ["locality"], longText: "אילת" }, { types: ["country"], longText: "ישראל", shortText: "IL" }],
  });
  const place = await picker.resolveSelectedPlace(selectEvent(noPostal));
  assert.equal(place.postalCode, null, "absent postal code stays null (not fabricated)");
  assert.equal(place.streetNumber, null, "absent street number stays null (not fabricated)");
  assert.equal(place.city, "אילת");
  passed += 3;
})();

// a place without a location is REJECTED and can never be saved
await (async () => {
  const noLoc = fakePlaceJSON({ location: undefined });
  await assert.rejects(
    () => picker.resolveSelectedPlace(selectEvent(noLoc)),
    (e) => e.code === "PLACE_WITHOUT_LOCATION",
    "place without coordinates is rejected",
  );
  passed++;
})();

// upstream detail failures are distinguished from selection failures
await (async () => {
  await assert.rejects(
    () => picker.resolveSelectedPlace(selectEvent(fakePlaceJSON(), { throwOnFetch: true })),
    (e) => e.code === "PLACE_DETAILS_FAILED",
  );
  await assert.rejects(() => picker.resolveSelectedPlace({}), (e) => e.code === "PLACE_SELECTION_FAILED");
  passed += 2;
})();

// the widget wires selection end-to-end: emitting gmp-select yields a normalized place
await (async () => {
  const spy = { constructed: 0, added: [], removed: [] };
  const host = makeHost();
  let selected = null;
  let errored = null;
  picker.mountAutocomplete({
    host,
    places: makeFakePlacesLib(spy),
    onSelect: (p) => (selected = p),
    onError: (e) => (errored = e),
  });
  spy.last.emit("gmp-select", selectEvent(fakePlaceJSON()));
  await tick();
  assert.equal(errored, null, "no error on a valid selection");
  assert.equal(selected.googlePlaceId, "ChIJmxRbFHZMHRUR8Cy9G0Qkyhc");
  assert.equal(selected.latitude, TLV.lat);

  // a location-less place reaches onError, never onSelect
  selected = null;
  spy.last.emit("gmp-select", selectEvent(fakePlaceJSON({ location: undefined })));
  await tick();
  assert.equal(selected, null, "location-less place never reaches onSelect");
  assert.equal(errored.code, "PLACE_WITHOUT_LOCATION");
  passed += 5;
})();

// ============================================================
// 4. map + marker use the selected coordinates; container is required
// ============================================================
{
  let mapOpts = null;
  const mapsLib = { Map: class { constructor(el, o) { mapOpts = o; this.el = el; } setCenter() {} setZoom() {} } };
  const map = picker.renderMap(mapsLib, { nodeName: "DIV" }, TLV);
  assert.deepEqual(mapOpts.center, TLV, "map centers on the selected place location");
  assert.equal(mapOpts.zoom, picker.BUILDING_ZOOM, "building-level zoom");
  assert.ok(picker.BUILDING_ZOOM >= 17, "zoom is building-level");
  assert.ok(map);

  assert.throws(() => picker.renderMap(mapsLib, null, TLV), (e) => e.code === "MAP_CONTAINER_MISSING");
  passed += 5;
}

{
  let markerOpts = null;
  let dragCb = null;
  const markerLib = {
    Marker: class {
      constructor(o) { markerOpts = o; }
      addListener(t, cb) { if (t === "dragend") dragCb = cb; }
      setPosition() {}
      setMap() {}
    },
  };
  let dragged = null;
  picker.renderMarker(markerLib, {}, TLV, (p) => (dragged = p));
  assert.deepEqual(markerOpts.position, TLV, "marker uses the selected coordinates");
  assert.equal(markerOpts.draggable, true, "marker is adjustable");

  // dragging reports new coordinates to the caller — it does NOT save
  dragCb({ latLng: { lat: () => 31.5, lng: () => 34.9 } });
  assert.deepEqual(dragged, { lat: 31.5, lng: 34.9 }, "dragend reports the new position");
  passed += 3;
}

// map container has an explicit non-zero height in the component
assert.ok(/ref=\{mapHostRef\}[\s\S]{0,220}h-72/.test(COMPONENT_SRC), "map container has an explicit height (h-72)");
passed++;

// ============================================================
// 5. marker movement requires confirmation; nothing auto-saves
// ============================================================
// A drag sets PENDING state with source google_marker_adjustment; the only call
// to saveBusinessLocationAction is inside saveLocation(), which is only reachable
// from an explicit onClick.
// Scope the assertion to the drag handler's own body, not the whole file.
const dragHandler = COMPONENT_SRC.slice(
  COMPONENT_SRC.indexOf("const onMarkerDragEnd"),
  COMPONENT_SRC.indexOf("useEffect(", COMPONENT_SRC.indexOf("const onMarkerDragEnd")),
);
assert.ok(dragHandler.length > 50, "found the marker drag handler");
assert.ok(/setPending\(/.test(dragHandler), "marker drag sets pending state");
assert.ok(/google_marker_adjustment/.test(dragHandler), "marker drag marks the source as an adjustment");
assert.ok(!/saveLocation\(/.test(dragHandler), "marker drag never calls saveLocation");
assert.ok(
  !/onSelect:[\s\S]{0,200}saveLocation\(/.test(COMPONENT_SRC),
  "selecting a place never auto-saves (no test selection is persisted)",
);
passed += 2;
const saveCallSites = COMPONENT_SRC.match(/saveLocation\(/g) ?? [];
assert.equal(saveCallSites.length, 3, "saveLocation is defined once and called only from the two confirm buttons");
assert.ok(/onClick=\{\(\) => saveLocation\(pending\.place, pending\.source\)\}/.test(COMPONENT_SRC), "confirm button saves");
assert.ok(/confirmed:\s*true/.test(COMPONENT_SRC), "server is always told the change was confirmed");
passed += 6;

// the saved location is rendered from `profile`, independent of SDK status, so a
// temporary Maps failure cannot blank or replace it
assert.ok(
  /value=\{profile\.formattedAddress\}/.test(COMPONENT_SRC),
  "saved address renders from the profile, not from SDK state",
);
assert.ok(
  !/status === "error"[\s\S]{0,200}profile\./.test(COMPONENT_SRC),
  "an SDK error does not gate the saved location block",
);
passed += 2;

// ============================================================
// 6. manual fallback: super_admin, collapsed, no placeholder coordinates
// ============================================================
assert.ok(/\{isSuperAdmin && \(/.test(COMPONENT_SRC), "manual fallback is super_admin-only");
assert.ok(/useState\(false\);?\s*\/\/?/.test(COMPONENT_SRC) || /const \[manualOpen, setManualOpen\] = useState\(false\)/.test(COMPONENT_SRC), "manual fallback starts collapsed");
assert.ok(/manualConfirm/.test(COMPONENT_SRC), "manual override requires explicit confirmation");
assert.ok(/Google Maps הוא המקור המועדף/.test(COMPONENT_SRC), "manual fallback states Google is preferred");
// D61 shipped Tel-Aviv coordinates as input placeholders — removable mistakes for real data
assert.ok(!/placeholder="32\.0853"/.test(COMPONENT_SRC), "no placeholder latitude that looks like real coordinates");
assert.ok(!/placeholder="34\.7818"/.test(COMPONENT_SRC), "no placeholder longitude that looks like real coordinates");
passed += 6;

// ============================================================
// 7. error taxonomy + secret hygiene
// ============================================================
assert.equal(errors.MAPS_ERROR_CODES.length, 11, "all 11 diagnostic codes exist");
for (const code of errors.MAPS_ERROR_CODES) {
  const msg = errors.mapsErrorMessage(code);
  assert.ok(msg && msg.length > 3, `${code} has a Hebrew message`);
  assert.ok(/[֐-׿]/.test(msg), `${code} message is Hebrew`);
}
passed += errors.MAPS_ERROR_CODES.length * 2;

// the key never survives sanitization, from any shape it could arrive in
const leaky = [
  `https://maps.googleapis.com/maps/api/js?key=${FAKE_KEY}&v=weekly`,
  `Failed to load ?key=${FAKE_KEY}`,
  `bare token ${FAKE_KEY} in a message`,
];
for (const text of leaky) {
  const scrubbed = errors.scrubSecrets(text);
  assert.ok(!scrubbed.includes(FAKE_KEY), `key scrubbed from: ${text.slice(0, 30)}…`);
  passed++;
}
{
  const safe = errors.sanitizeMapsError(
    new errors.MapsError("MAPS_SCRIPT_LOAD_FAILED", new Error(`GET https://maps.googleapis.com/maps/api/js?key=${FAKE_KEY} 403`)),
    "MAP_RENDER_FAILED",
  );
  assert.equal(safe.code, "MAPS_SCRIPT_LOAD_FAILED", "explicit code wins over the fallback");
  assert.ok(!safe.detail.includes(FAKE_KEY), "sanitized detail carries no key");
  assert.ok(!safe.message.includes(FAKE_KEY), "sanitized message carries no key");
  assert.ok(safe.detail.length <= 120, "detail is bounded");

  const unknown = errors.sanitizeMapsError(new Error("boom"), "MAP_RENDER_FAILED");
  assert.equal(unknown.code, "MAP_RENDER_FAILED", "unknown errors take the fallback code");
  passed += 5;
}

// nothing in the picker or the component logs the key, the URL, or a raw error
assert.ok(!/console\.log/.test(PICKER_SRC) && !/console\.log/.test(COMPONENT_SRC), "no console.log");
assert.ok(!/console\.error\(\s*e\s*\)/.test(COMPONENT_SRC), "raw exception objects are never logged");
assert.ok(/sanitizeMapsError/.test(COMPONENT_SRC), "the component logs only sanitized errors");
assert.ok(!/script\.src/.test(COMPONENT_SRC), "the component never touches the keyed script URL");
// the browser key is read once, passed to the loader, and never rendered
const keyReads = COMPONENT_SRC.match(/NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY/g) ?? [];
assert.equal(keyReads.length, 1, "browser key is read exactly once");
assert.ok(!/\{BROWSER_KEY\}/.test(COMPONENT_SRC), "browser key is never rendered into the DOM");
passed += 6;

// ============================================================
// 8. reverse geocoding is advisory: failure never invalidates coordinates
// ============================================================
await (async () => {
  const good = { Geocoder: class { async geocode() { return { results: [fakePlaceJSON()] }; } } };
  const resolved = await picker.reverseGeocode(good, TLV);
  assert.equal(resolved.formattedAddress, "הירקון 99, תל אביב-יפו", "reverse geocode resolves an address");

  const bad = { Geocoder: class { async geocode() { throw new Error("OVER_QUERY_LIMIT"); } } };
  assert.equal(await picker.reverseGeocode(bad, TLV), null, "geocoding failure degrades to null, never throws");
  passed += 2;
})();

// the resolved address is shown separately and never overwrites the selection
assert.ok(/resolvedAddress/.test(COMPONENT_SRC), "reverse-geocoded address has its own state");
assert.ok(
  !/setPending[\s\S]{0,120}formattedAddress:\s*resolvedAddress/.test(COMPONENT_SRC),
  "reverse geocoding never overwrites the selected Google address",
);
passed += 2;

console.log(`check-maps-picker: all ${passed} assertions passed ✓`);
