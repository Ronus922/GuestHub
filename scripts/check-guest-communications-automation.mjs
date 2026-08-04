import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = mkdtempSync(join(process.cwd(), "node_modules/.cache/check-guest-communications-automation-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
const tsconfig = join(out, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    module: "esnext", target: "es2022", moduleResolution: "bundler", skipLibCheck: true,
    baseUrl: process.cwd(), paths: { "@/*": ["src/*"] }, rootDir: join(process.cwd(), "src/lib"), outDir: out,
  },
  files: [join(process.cwd(), "src/lib/communications/automation.ts")],
}));
execSync(`pnpm exec tsc --project ${tsconfig}`, { stdio: "inherit" });

const automationPath = join(out, "communications/automation.js");
let source = readFileSync(automationPath, "utf8")
  .replace('import "server-only";\n', "")
  .replace('"@/lib/db"', '"./test-db.js"')
  .replace('"@/lib/business/store"', '"./test-support.js"')
  .replace('"@/lib/settings"', '"./test-support.js"')
  .replace('"@/lib/check-in-check-out"', '"./test-support.js"')
  .replace('"@/lib/dates"', '"./test-support.js"')
  .replaceAll('"./schedule"', '"./test-support.js"')
  .replaceAll('"./schemas"', '"./schemas.js"')
  .replaceAll('"./renderer"', '"./renderer.js"')
  .replaceAll('"./variables"', '"./variables.js"')
  .replaceAll('"./outbox"', '"./outbox.js"')
  .replaceAll('"./triggers"', '"./triggers.js"')
  .replaceAll('"./conditions"', '"./conditions.js"')
  .replaceAll('"@/lib/phone"', '"../phone.js"')
  .replaceAll('"./types"', '"./types.js"');
writeFileSync(automationPath, source);
for (const file of ["schemas.js", "renderer.js", "variables.js", "styles.js", "triggers.js", "conditions.js"]) {
  const path = join(out, `communications/${file}`);
  if (!readFileSync(path, "utf8")) continue;
  let emitted = readFileSync(path, "utf8")
    .replaceAll('"./types"', '"./types.js"')
    .replaceAll('"./schemas"', '"./schemas.js"')
    .replaceAll('"./variables"', '"./variables.js"')
    .replaceAll('"./styles"', '"./styles.js"')
    .replaceAll('"./triggers"', '"./triggers.js"')
    .replaceAll('"@/lib/phone"', '"../phone.js"')
    .replaceAll('"@/lib/colors"', '"../colors.js"');
  writeFileSync(path, emitted);
}

// D114 call-site integrity — the semantic core must stay in place: conditions
// are evaluated with a scope whose guest flag means "deliverable guest leg".
// A revert to an unscoped matcher must fail loudly here, not only behaviorally.
assert.match(source, /guestIsRecipient:\s*recipientConfig\.guest\s*&&\s*guestAddress\s*!==\s*null/,
  "automation.ts must scope conditions by the deliverable guest leg (D114)");
assert.doesNotMatch(source, /function matchesConditions/,
  "the unscoped local matcher must not come back — conditions.ts owns evaluation (D114)");
writeFileSync(join(out, "communications/test-support.js"), `
export const getBusinessProfile = async () => ({
  publicPropertyName: "GuestHub Test", formattedAddress: "Test 1", phone: "03-0000000",
  email: "property@example.test", latitude: null, longitude: null, logo: null,
});
export const getTenantCheckInCheckOutSettings = async () => ({});
export const resolveStaySchedule = () => ({ arrival: { check_in_from: "15:00" }, departure: { check_out_until: "11:00" } });
export const resolveCommunicationStaySchedule = async () => ({ checkIn: "15:00", checkOut: "11:00" });
export const nightsBetween = () => 2;
`);
writeFileSync(join(out, "communications/test-db.js"), `
export const state = {
  reservation: null, automations: [], version: null, channel: null, waChannel: null, siblingByLang: null,
  settings: null,
  deliveryKeys: new Set(), insertions: [], attention: [],
};
const queryText = (strings) => strings.join("?");
export const sql = (strings, ...values) => {
  const text = queryText(strings);
  if (text.includes("FROM guesthub.reservations r")) return Promise.resolve(state.reservation ? [state.reservation] : []);
  if (text.includes("FROM guesthub.tenants t")) return Promise.resolve(state.waChannel ? [state.waChannel] : []);
  // the quiet-hours/owner-recipients settings SELECT — matched by its column list
  // because the outbound INSERT also mentions communication_settings (max_attempts)
  if (text.includes("SELECT quiet_hours")) return Promise.resolve(state.settings ? [state.settings] : []);
  if (text.includes("FROM guesthub.communication_automations")) return Promise.resolve(state.automations);
  // guest-language sibling lookup (FROM message_templates cfg JOIN … language = $target)
  if (text.includes("guesthub.message_templates cfg")) {
    const lang = values.find((v) => v === "he" || v === "en");
    const sib = state.siblingByLang ? state.siblingByLang[lang] : null;
    return Promise.resolve(sib ? [sib] : []);
  }
  if (text.includes("FROM guesthub.message_template_versions")) return Promise.resolve(state.version ? [state.version] : []);
  if (text.includes("FROM guesthub.messaging_provider_connections")) return Promise.resolve(state.channel ? [state.channel] : []);
  if (text.includes("UPDATE guesthub.communication_automations")) {
    state.attention.push(values.find((value) => typeof value === "string" && value.length > 10));
    return Promise.resolve([]);
  }
  if (text.includes("INSERT INTO guesthub.outbound_messages")) {
    const key = values.find((value) => typeof value === "string" && value.startsWith("automation:"));
    if (state.deliveryKeys.has(key)) return Promise.resolve([]);
    // keep the statement text: 'queued' / 'skipped' are SQL literals, not bound
    // values, and the whole point of these assertions is which one was written
    state.deliveryKeys.add(key); state.insertions.push({ key, values, text });
    return Promise.resolve([{ id: "delivery-" + state.insertions.length }]);
  }
  return { then(resolve) { resolve([]); } };
};
sql.json = (value) => value;
export const reset = () => {
  state.deliveryKeys.clear(); state.insertions.length = 0; state.attention.length = 0;
  state.siblingByLang = null; state.waChannel = null; state.settings = null;
};
`);

const { prepareDeliveriesForEvent } = await import(automationPath);
const db = await import(join(out, "communications/test-db.js"));
let checks = 0;
const ok = (name) => { process.stdout.write(`  ✓ ${name}\n`); checks += 1; };

const baseReservation = {
  id: "reservation-1", tenant_id: "tenant-1", booking_origin: "back_office", status: "confirmed",
  is_test: false, guest_communication_opt_out: false, external_booking_id: null,
  channel_connection_id: null, ota_name: null, reservation_number: "GH-100",
  created_at: "2026-07-14T12:00:00.000Z", check_in: "2026-08-01", check_out: "2026-08-03",
  adults: 2, children: 0, infants: 0, total_price: 1000, paid_amount: 200, balance: 800,
  currency: "ILS", cancellation_policy_snapshot: null, guest_id: "guest-1",
  guest_first_name: "נועה", guest_last_name: "בדיקה", guest_full_name: "נועה בדיקה",
  guest_email: "noa@example.test", guest_phone: "0500000000", source_label: "ידנית",
  room_numbers: "101", room_types: "סטודיו", room_floors: "1",
};
const baseAutomation = {
  id: "automation-1", tenant_id: "tenant-1", channel: "email", template_id: "template-1",
  template_version_policy: "latest_published", locked_template_version_id: null,
  timing_config: { mode: "immediate", quietHours: "bypass" },
  source_filters: { include: ["back_office", "direct_website"] },
  conditions: { logic: "all", items: [
    { field: "reservation.status", operator: "equals", value: "confirmed" },
    { field: "guest.email", operator: "exists" },
    { field: "reservation.is_test", operator: "equals", value: false },
    { field: "reservation.is_cancelled", operator: "equals", value: false },
  ] },
  exclusion_rules: { guestCommunicationOptOut: true, ota: true }, recipient_config: { type: "primary_guest" },
};
const version = {
  id: "version-1", template_id: "template-1", sender_display_name: "GuestHub Test",
  reply_to_behavior: "channel_default", reply_to_address: null,
  subject: "אישור {{reservation.number}}", preheader: "אישור הזמנה",
  content: { schemaVersion: 1, blocks: [
    { id: "hello", type: "text", enabled: true, condition: "always", data: { text: "שלום {{guest.first_name}}" } },
  ] },
};
const eventFor = (source = "back_office", id = "event-1") => ({
  id, tenant_id: "tenant-1", event_type: "reservation.confirmed", reservation_id: "reservation-1",
  source, payload: {}, attempt_count: 1, max_attempts: 10,
});
const configure = (reservation = baseReservation) => {
  db.reset(); db.state.reservation = reservation; db.state.automations = [baseAutomation];
  db.state.version = version; db.state.channel = { sender_name: "GuestHub Test", reply_to: "reply@example.test" };
};

configure();
assert.deepEqual(await prepareDeliveriesForEvent(eventFor()), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions.length, 1);
assert.equal(db.state.insertions[0].values.includes("noa@example.test"), true);
ok("eligible confirmed back-office event creates one rendered delivery snapshot");

assert.deepEqual(await prepareDeliveriesForEvent(eventFor()), { created: 0, duplicates: 1, skipped: 0 });
assert.equal(db.state.insertions.length, 1);
ok("duplicate event preparation reuses the idempotency key and creates no second delivery");

configure({ ...baseReservation, booking_origin: "direct_website" });
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("direct_website", "event-direct")), { created: 1, duplicates: 0, skipped: 0 });
ok("future direct website origin is included without a public booking endpoint");

for (const [name, reservation, source = reservation.booking_origin] of [
  ["OTA origin", { ...baseReservation, booking_origin: "ota" }],
  ["external booking id", { ...baseReservation, external_booking_id: "BDC-1" }],
  ["channel connection", { ...baseReservation, channel_connection_id: "channel-1" }],
  ["OTA label", { ...baseReservation, ota_name: "Booking.com" }],
  ["draft", { ...baseReservation, status: "draft" }],
  ["cancelled", { ...baseReservation, status: "cancelled" }],
  ["test reservation", { ...baseReservation, is_test: true }],
  ["guest opt-out", { ...baseReservation, guest_communication_opt_out: true }],
  ["missing email", { ...baseReservation, guest_email: null }],
  ["invalid email", { ...baseReservation, guest_email: "not-an-email" }],
  ["spoofed event source", baseReservation, "direct_website"],
]) {
  configure(reservation);
  assert.deepEqual(await prepareDeliveriesForEvent(eventFor(source, `event-${name}`)), { created: 0, duplicates: 0, skipped: 1 }, name);
  // An excluded event still records ONE terminal row — that is how an operator
  // learns why a booking got no email. What must never exist is a QUEUED one:
  // a queued row is an email on its way to the guest.
  assert.equal(db.state.insertions.length, 1, name);
  const [recorded] = db.state.insertions;
  assert.match(recorded.text, /'skipped'/, `${name} must be recorded as skipped`);
  assert.equal(/'queued'/.test(recorded.text), false, `${name} must never be queued for sending`);
}
ok("OTA, external, draft, cancelled, test, opt-out, invalid recipient, and spoofed-source events are excluded — recorded as skipped, never queued");

configure(); db.state.version = null;
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-no-version")), { created: 0, duplicates: 0, skipped: 1 });
assert.equal(db.state.attention.length, 1);
configure(); db.state.channel = null;
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-no-channel")), { created: 0, duplicates: 0, skipped: 1 });
assert.equal(db.state.attention.length, 1);
ok("missing published version or tested email channel marks the automation for attention without delivery");

db.reset(); db.state.reservation = baseReservation; db.state.automations = [];
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-no-automation")), { created: 0, duplicates: 0, skipped: 0 });
ok("no active automation produces no delivery and no synthetic failure");

// ---- §10/§21 guest-language template selection ----
const enVersion = {
  ...version, id: "version-en", template_id: "template-en",
  subject: "Confirmation {{reservation.number}}", preheader: "Booking confirmation",
  content: { schemaVersion: 1, blocks: [
    { id: "hello", type: "text", enabled: true, condition: "always", data: { text: "Hello {{guest.first_name}}" } },
  ] },
};

// an English-speaking guest gets the published English sibling (same category)
configure({ ...baseReservation, guest_language: "en" });
db.state.siblingByLang = { en: enVersion };
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-en")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("version-en"), true, "the English sibling version was selected");
assert.equal(db.state.insertions[0].values.includes("Confirmation GH-100"), true, "the English subject was rendered");
ok("guest.language=en selects the published English sibling template (same category)");

// a Hebrew-speaking guest keeps the configured (Hebrew) template
configure({ ...baseReservation, guest_language: "he" });
db.state.siblingByLang = { en: enVersion }; // only an English sibling exists
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-he")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("version-1"), true, "the configured Hebrew version was used");
ok("guest.language=he uses the configured Hebrew template (no spurious override)");

// no sibling in the guest's language → honest fallback to the configured template
configure({ ...baseReservation, guest_language: "en" });
db.state.siblingByLang = null; // no English sibling published
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-en-fallback")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("version-1"), true, "fell back to the configured template");
ok("no published sibling in the guest's language → honest fallback, never a fabricated translation");

// unknown/blank guest language → no override (configured template)
configure({ ...baseReservation, guest_language: "  " });
db.state.siblingByLang = { en: enVersion };
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-blanklang")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("version-1"), true, "blank language did not trigger a sibling lookup");
ok("unknown/blank guest.language never overrides the configured template");

// a LOCKED automation is an explicit choice — never language-overridden
configure({ ...baseReservation, guest_language: "en" });
db.state.automations = [{ ...baseAutomation, template_version_policy: "locked", locked_template_version_id: "version-1" }];
db.state.siblingByLang = { en: enVersion };
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-locked")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("version-1"), true, "locked policy kept its pinned version");
ok("a locked automation is never language-overridden (explicit operator choice)");

// ---- v2: WhatsApp automations ride the same preparation with their own recipient rules ----
const waAutomation = { ...baseAutomation, id: "automation-wa", channel: "whatsapp", template_id: "template-wa",
  conditions: { logic: "all", items: [
    { field: "reservation.status", operator: "equals", value: "confirmed" },
    { field: "reservation.is_test", operator: "equals", value: false },
  ] } };
const waVersion = { ...version, id: "version-wa", template_id: "template-wa", subject: "",
  reply_to_behavior: "none", preheader: null,
  content: { schemaVersion: 1, kind: "whatsapp_text", text: "שלום {{guest.first_name}}, הזמנה {{reservation.number}}" } };

db.reset(); db.state.reservation = baseReservation; db.state.automations = [waAutomation];
db.state.version = waVersion; db.state.waChannel = { provider: "green_api" };
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-wa")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("+972500000000"), true, "recipient must be the guest's E.164 phone");
assert.equal(db.state.insertions[0].values.includes("green_api"), true, "provider is the tenant's active WhatsApp provider");
assert.equal(db.state.insertions[0].values.some((v) => typeof v === "string" && v.includes("שלום נועה")), true,
  "the rendered text must interpolate without HTML escaping");
ok("a WhatsApp automation queues a real E.164 delivery through the active provider");

db.reset(); db.state.reservation = { ...baseReservation, guest_phone: null }; db.state.automations = [waAutomation];
db.state.version = waVersion; db.state.waChannel = { provider: "green_api" };
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-wa-nophone")), { created: 0, duplicates: 0, skipped: 1 });
assert.match(db.state.insertions[0].text, /'skipped'/);
ok("a guest without a phone gets a truthful skipped row, never a queued WhatsApp delivery");

db.reset(); db.state.reservation = baseReservation; db.state.automations = [waAutomation];
db.state.version = waVersion; db.state.waChannel = null;
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-wa-noprovider")), { created: 0, duplicates: 0, skipped: 1 });
assert.equal(db.state.attention.length, 1, "a disconnected WhatsApp provider flags the automation");
ok("no connected WhatsApp provider → attention + skip, nothing queued");

// a WhatsApp automation must never send an email-shaped template
db.reset(); db.state.reservation = baseReservation; db.state.automations = [waAutomation];
db.state.version = version; db.state.waChannel = { provider: "green_api" };
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-wa-mismatch")), { created: 0, duplicates: 0, skipped: 1 });
ok("a channel/template kind mismatch is refused with a skip, never sent");

// ---- v2: the cancellation trigger accepts ONLY cancelled reservations ----
const cancelAutomation = { ...baseAutomation, id: "automation-cancel",
  conditions: { logic: "all", items: [
    { field: "reservation.status", operator: "equals", value: "cancelled" },
    { field: "reservation.is_test", operator: "equals", value: false },
  ] } };
const cancelledEvent = (id) => ({ ...eventFor("back_office", id), event_type: "reservation.cancelled" });

db.reset(); db.state.reservation = { ...baseReservation, status: "cancelled" };
db.state.automations = [cancelAutomation]; db.state.version = version;
db.state.channel = { sender_name: "GuestHub Test", reply_to: "reply@example.test" };
assert.deepEqual(await prepareDeliveriesForEvent(cancelledEvent("event-cancelled")), { created: 1, duplicates: 0, skipped: 0 });
ok("a cancellation automation queues for a CANCELLED reservation — the old confirmed-only gate is gone");

db.reset(); db.state.reservation = baseReservation; // still confirmed
db.state.automations = [cancelAutomation]; db.state.version = version;
db.state.channel = { sender_name: "GuestHub Test", reply_to: "reply@example.test" };
assert.deepEqual(await prepareDeliveriesForEvent(cancelledEvent("event-cancelled-early")), { created: 0, duplicates: 0, skipped: 1 });
assert.match(db.state.insertions[0].text, /'skipped'/);
ok("a cancellation event for a still-confirmed reservation is skipped, never queued");

// an unknown trigger type is refused outright
db.reset(); db.state.reservation = baseReservation; db.state.automations = [baseAutomation]; db.state.version = version;
assert.deepEqual(await prepareDeliveriesForEvent({ ...eventFor("back_office", "event-unknown"), event_type: "reservation.made_up" }),
  { created: 0, duplicates: 0, skipped: 1 });
assert.equal(db.state.insertions.length, 0, "an unknown trigger writes nothing");
ok("an event type outside the registry is dropped without touching outbound_messages");

// ---- v3 (065): owner recipients — fan-out, per-recipient dedupe, honest skips ----
const ownerSettings = {
  quiet_hours: null,
  owner_notification_emails: ["owner@example.test", "second@example.test"],
  owner_notification_phones: ["+972521111111"],
};
const configureOwner = (automation, settings = ownerSettings, reservation = baseReservation) => {
  db.reset(); db.state.reservation = reservation; db.state.automations = [automation];
  db.state.version = version; db.state.channel = { sender_name: "GuestHub Test", reply_to: "reply@example.test" };
  db.state.settings = settings;
};

const ownerAllAutomation = { ...baseAutomation, id: "automation-owner",
  recipient_config: { version: 2, guest: true, owner: { mode: "all" } } };
configureOwner(ownerAllAutomation);
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-owner-all")), { created: 3, duplicates: 0, skipped: 0 });
const ownerKeys = db.state.insertions.map((i) => i.key);
assert.equal(ownerKeys.includes("automation:automation-owner:event:event-owner-all"), true,
  "the guest row keeps the pre-065 key format — historical dedupe must survive");
assert.equal(ownerKeys.filter((k) => k.includes(":owner:")).length, 2, "one row per configured owner email");
assert.equal(db.state.insertions.every((i) => /'queued'/.test(i.text)), true, "all three are real queued deliveries");
ok("guest+owner(all) fans out to one row per recipient; the guest keeps the legacy idempotency key");

assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-owner-all")), { created: 0, duplicates: 3, skipped: 0 });
assert.equal(db.state.insertions.length, 3);
ok("re-firing the same event dedupes every recipient row independently");

const ownerSelectedAutomation = { ...baseAutomation, id: "automation-sel",
  recipient_config: { version: 2, guest: false,
    owner: { mode: "selected", addresses: ["owner@example.test", "deleted@example.test"] } } };
configureOwner(ownerSelectedAutomation);
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-owner-sel")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("owner@example.test"), true, "only the still-configured selection is sent");
assert.equal(db.state.insertions.some((i) => i.values.includes("noa@example.test")), false, "guest=false really means no guest leg");
ok("selected owner addresses intersect with the live settings list — deleted selections drop silently");

configureOwner(ownerAllAutomation, { quiet_hours: null, owner_notification_emails: [], owner_notification_phones: [] });
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-owner-empty")), { created: 1, duplicates: 0, skipped: 1 });
const emptySkip = db.state.insertions.find((i) => i.key.endsWith(":owner:none"));
assert.notEqual(emptySkip, undefined, "an owner leg with no configured addresses records a truthful skip row");
assert.match(emptySkip.text, /'skipped'/);
ok("owner enabled but no addresses configured → guest still sends, owner leg records no_owner_recipients");

// D114 — the REAL registry defaults (incl. guest.email exists) must not block
// the owner legs when the guest merely lacks an email: a guest-contact
// condition may gate only the guest's own leg. Before D114 this fixture had to
// strip the guest.email condition to pass — that workaround was the defect.
const ownerNoEmailGate = { ...ownerAllAutomation, id: "automation-owner-ng" };
configureOwner(ownerNoEmailGate, ownerSettings, { ...baseReservation, guest_email: null });
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-owner-noguest")), { created: 2, duplicates: 0, skipped: 1 });
assert.equal(db.state.insertions.filter((i) => /'queued'/.test(i.text)).length, 2, "both owner emails still go out");
assert.match(db.state.insertions.find((i) => !i.key.includes(":owner:")).text, /'skipped'/,
  "the guest leg records its missing-email skip without blocking the owner legs");
ok("a missing guest email skips only the guest leg — the owner legs still send (with the default guest.email condition present)");

// ---- D114: conditions are recipient- and channel-scoped ----
// The reservation-1053 defect: a WhatsApp owner-only automation carried the
// registry's guest.email-exists default and was skipped with conditions_not_met
// because the GUEST — who receives nothing on it — had no email.
const waOwnerOnly = { ...baseAutomation, id: "automation-wa-owner", channel: "whatsapp", template_id: "template-wa",
  recipient_config: { version: 2, guest: false, owner: { mode: "selected", addresses: ["+972521111111"] } } };
db.reset(); db.state.reservation = { ...baseReservation, guest_email: null };
db.state.automations = [waOwnerOnly]; db.state.version = waVersion;
db.state.waChannel = { provider: "green_api" }; db.state.settings = ownerSettings;
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-d114-owner")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("+972521111111"), true, "the owner leg must be queued");
assert.match(db.state.insertions[0].text, /'queued'/,
  "the guest.email default must never block an owner-only WhatsApp automation");
ok("D114: a guest-contact condition is not evaluated when the guest is not a recipient — owner-only WhatsApp sends");

// Channel-following: on WhatsApp the guest-contact condition means the PHONE.
const waGuestDefault = { ...baseAutomation, id: "automation-wa-guest", channel: "whatsapp", template_id: "template-wa",
  recipient_config: { version: 2, guest: true, owner: null } };
db.reset(); db.state.reservation = { ...baseReservation, guest_email: null };
db.state.automations = [waGuestDefault]; db.state.version = waVersion; db.state.waChannel = { provider: "green_api" };
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-d114-guest")), { created: 1, duplicates: 0, skipped: 0 });
assert.equal(db.state.insertions[0].values.includes("+972500000000"), true, "the guest's E.164 phone is the recipient");
ok("D114: the guest-contact condition follows the channel — a guest with a valid phone and no email still gets WhatsApp");

// A conditions_not_met skip carries its own evidence (D112) and displays the
// INTENDED recipient — while the dedupe identity (legacy idempotency_key +
// recipient_key 'guest') stays byte-identical.
const ownerOnlyBalance = { ...baseAutomation, id: "automation-owner-cond",
  conditions: { logic: "all", items: [
    { field: "reservation.status", operator: "equals", value: "confirmed" },
    { field: "payment.balance", operator: "greater_than", value: 100000 },
  ] },
  recipient_config: { version: 2, guest: false, owner: { mode: "selected", addresses: ["owner@example.test"] } } };
configureOwner(ownerOnlyBalance);
assert.deepEqual(await prepareDeliveriesForEvent(eventFor("back_office", "event-d114-evidence")), { created: 0, duplicates: 0, skipped: 1 });
const evidence = db.state.insertions[0];
assert.match(evidence.text, /'skipped'/);
assert.equal(evidence.key, "automation:automation-owner-cond:event:event-d114-evidence",
  "the skip row keeps the pre-065 dedupe key byte-identical");
assert.equal(evidence.values.includes("guest"), true, "recipient_key stays 'guest' — it participates in the 065 unique index");
assert.equal(evidence.values.includes("owner@example.test"), true, "the DISPLAYED address is the intended owner recipient");
assert.equal(evidence.values.includes("noa@example.test"), false, "the guest's address no longer masquerades as the recipient");
const detail = evidence.values.find((v) => typeof v === "string" && v.includes("תנאי האוטומציה לא התקיימו"));
assert.notEqual(detail, undefined, "the skip row carries the conditions_not_met label");
assert.match(detail, /payment\.balance greater_than 100000/, "the failing predicate is named in the evidence (D112)");
ok("D114/D112: conditions_not_met names the failing predicate and displays the intended recipient, dedupe identity untouched");

process.stdout.write(`\n✓ Guest Communications automation checks passed (${checks} groups)\n`);
