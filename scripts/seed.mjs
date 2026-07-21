// GuestHub Phase-1 seed (PROJECT_OVERVIEW §20).
// Run: pnpm db:seed   (node --env-file=.env.local scripts/seed.mjs)
//
// Idempotent: truncates the guesthub schema, recreates the 5 Supabase auth users,
// and regenerates all domain data. Only touches the `guesthub` schema + its own auth users.
//
// super_admin bootstrap: the `admin` user (admin@ginot.co.il) is part of this seed —
// after any DB reset/reseed, run `pnpm db:seed` and log in as admin / SEED_PASSWORD.
// This is the only sanctioned way to (re)create a super_admin: the seed runs server-side
// with SUPABASE_SERVICE_ROLE_KEY from .env.local; there is no signup or client-side path.
import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4 });

const ADMIN = process.env.SUPABASE_ADMIN_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEED_PASSWORD = "Guesthub!2026";
// Isolated test envs have no shared GoTrue. SEED_SKIP_AUTH=1 mints a local,
// deterministic mock auth identity per email instead of calling the auth admin
// API — satisfies "test-only/mocked auth", never touches a real auth server.
const SKIP_AUTH = process.env.SEED_SKIP_AUTH === "1";
const localAuthId = (email) => {
  const h = createHash("sha1").update(`guesthub-test:${email}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// ---------- helpers ----------
const authHeaders = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  "Content-Type": "application/json",
};

async function findAuthUserByEmail(email) {
  const res = await fetch(
    `${ADMIN}/auth/v1/admin/users?per_page=200`,
    { headers: authHeaders },
  );
  if (!res.ok) throw new Error(`list users failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const users = Array.isArray(body) ? body : body.users ?? [];
  return users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
}

async function upsertAuthUser(email, meta) {
  const existing = await findAuthUserByEmail(email);
  if (existing) {
    await fetch(`${ADMIN}/auth/v1/admin/users/${existing.id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
  }
  const res = await fetch(`${ADMIN}/auth/v1/admin/users`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      email,
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: meta,
    }),
  });
  if (!res.ok) throw new Error(`create user ${email} failed: ${res.status} ${await res.text()}`);
  const user = await res.json();
  return user.id;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};
const overlaps = (aIn, aOut, bIn, bOut) => aIn < bOut && aOut > bIn;

// ---------- destructive-seed safety guard (fail-closed) ----------
// This seed TRUNCATEs the whole guesthub schema. Running it against production
// wipes real data — that is exactly what deleted the owner user r@bios.co.il on
// 2026-07-04. The guard refuses to run unless the target is explicitly an
// approved disposable dev/test DB. Default (no env) = BLOCKED.
export const PROD_MARKERS = ["bios-vps", "guesthub.bios.co.il", "db.bios.co.il"];

// Parse a libpq URL into safe identifiers only — never returns the password.
export function parseDbTarget(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || "?",
      port: u.port || "?",
      db: u.pathname.replace(/^\//, "") || "?",
      user: decodeURIComponent(u.username) || "?",
    };
  } catch {
    return { host: "?", port: "?", db: "?", user: "?" };
  }
}

// Pure: given an env object, decide whether a destructive reseed is permitted.
// Fail-closed — every condition must hold or it returns { ok: false, reasons }.
export function evaluateSeedGuard(env) {
  const url = env.DATABASE_URL || "";
  const target = parseDbTarget(url);
  const hay = `${url} ${env.NEXT_PUBLIC_APP_URL || ""} ${env.SUPABASE_ADMIN_URL || ""}`.toLowerCase();
  const reasons = [];
  if (env.NODE_ENV === "production") reasons.push("NODE_ENV=production");
  const marker = PROD_MARKERS.find((m) => hay.includes(m.toLowerCase()));
  if (marker) reasons.push(`known production marker present: "${marker}"`);
  if (env.ALLOW_DESTRUCTIVE_SEED !== "1") reasons.push("missing explicit opt-in: ALLOW_DESTRUCTIVE_SEED=1");
  if (!["development", "test"].includes(env.SEED_ENV || "")) {
    reasons.push('missing dev/test marker: SEED_ENV must be "development" or "test"');
  }
  return { ok: reasons.length === 0, reasons, target };
}

// Enforce the guard. Prints only safe identifiers. Calls exit(1) (before any
// TRUNCATE) when blocked. `exit` is injectable so tests can assert without dying.
export function assertSafeToSeed(env = process.env, exit = (c) => process.exit(c)) {
  const { ok, reasons, target } = evaluateSeedGuard(env);
  console.log(`seed target → host=${target.host} port=${target.port} db=${target.db} user=${target.user}`);
  if (!ok) {
    console.error("✗ DESTRUCTIVE SEED BLOCKED (fail-closed) — refusing to TRUNCATE:");
    for (const r of reasons) console.error(`  - ${r}`);
    console.error('Run only against a disposable dev/test DB with: ALLOW_DESTRUCTIVE_SEED=1 SEED_ENV=development (non-production target).');
    exit(1);
    return false; // reached only when a test injects a non-terminating exit
  }
  console.log("✓ seed guard passed — destructive reseed permitted.");
  return true;
}

// ---------- owner application account ----------
// The hotel owner (r@bios.co.il) is NOT one of the 5 role users and is NOT a
// seeded auth user: it ADOPTS a pre-existing shared Google identity (DECISIONS
// D28), which the seed must never create or modify. But the TRUNCATE drops its
// guesthub.users MAPPING row, so the seed must re-create that mapping every run —
// otherwise a reseed locks the owner out (the 2026-07-04 incident).
export const OWNER_AUTH_USER_ID = "d94e462c-0eda-4edd-8e7c-3458b9277e2d";
export const OWNER = { username: "ronen", full_name: "Ronen Meshulam", email: "r@bios.co.il", phone: null };

// Build the owner guesthub.users row from the freshly-generated tenant + role ids.
// Derives tenant_id/role_id from the seeded records — never hardcodes generated ids.
export function ownerUserRow(tenantId, superAdminRoleId) {
  if (!tenantId || !superAdminRoleId) {
    throw new Error("ownerUserRow: tenantId and superAdminRoleId are required (derive from seeded records)");
  }
  return {
    tenant_id: tenantId,
    auth_user_id: OWNER_AUTH_USER_ID,
    username: OWNER.username,
    full_name: OWNER.full_name,
    email: OWNER.email,
    phone: OWNER.phone,
    role_id: superAdminRoleId,
    allow_google_auth: true, // owner logs in via Google — D29 /auth/callback gate requires this
    is_active: true,
  };
}

// ---------- seed ----------
async function main() {
  assertSafeToSeed(); // fail-closed — exits before any TRUNCATE unless target is an approved dev/test DB
  console.log("→ truncating guesthub schema…");
  await sql.unsafe(`TRUNCATE
    guesthub.tenants, guesthub.roles, guesthub.permissions, guesthub.role_permissions,
    guesthub.users, guesthub.user_permission_overrides,
    guesthub.areas, guesthub.room_types, guesthub.rooms, guesthub.guests,
    guesthub.lookup_items, guesthub.reservations, guesthub.reservation_rooms, guesthub.rates,
    guesthub.sellable_units, guesthub.sellable_unit_rooms,
    guesthub.pricing_plans, guesthub.pricing_plan_rates,
    guesthub.payments, guesthub.housekeeping_tasks, guesthub.audit_logs,
    guesthub.bulk_rate_update_logs, guesthub.bulk_rate_update_items
    RESTART IDENTITY CASCADE`);

  // --- tenant ---
  const [tenant] = await sql`
    INSERT INTO guesthub.tenants ${sql({
      name: "גינות הים · תל אביב",
      slug: "ginot-hayam",
      timezone: "Asia/Jerusalem",
      currency: "ILS",
    })} RETURNING id`;
  const tenantId = tenant.id;

  // --- roles ---
  const roleDefs = [
    { key: "super_admin", name: "מנהל-על", description: "גישה מלאה לכל המערכת" },
    { key: "admin", name: "אדמין", description: "ניהול מלא של הנכס" },
    { key: "manager", name: "מנהל המלון", description: "ניהול תפעולי ועסקי" },
    { key: "receptionist", name: "פקיד קבלה", description: "הזמנות, אורחים, תשלומים" },
    { key: "staff", name: "איש צוות", description: "תפעול בסיסי" },
    { key: "cleaner", name: "עובד ניקיון", description: "משימות ניקיון בלבד" },
    { key: "maintenance", name: "עובד תחזוקה", description: "משימות תחזוקה בלבד" },
  ];
  const roles = await sql`
    INSERT INTO guesthub.roles ${sql(
      roleDefs.map((r) => ({ ...r, tenant_id: tenantId, is_system: true })),
      "tenant_id", "name", "key", "description", "is_system",
    )} RETURNING id, key`;
  const roleId = Object.fromEntries(roles.map((r) => [r.key, r.id]));

  // --- permissions (global catalog) ---
  const permDefs = [
    ["dashboard.view", "צפייה בדשבורד", "dashboard"],
    ["calendar.view", "צפייה ביומן", "calendar"],
    ["reservations.view", "צפייה בהזמנות", "reservations"],
    ["reservations.create", "יצירת הזמנה", "reservations"],
    ["reservations.edit", "עריכת הזמנה", "reservations"],
    ["reservations.cancel", "ביטול הזמנה", "reservations"],
    ["reservations.delete", "מחיקת הזמנה", "reservations"],
    ["guests.view", "צפייה באורחים", "guests"],
    ["guests.create", "יצירת אורח", "guests"],
    ["guests.edit", "עריכת אורח", "guests"],
    ["guests.delete", "מחיקת אורח", "guests"],
    ["rooms.view", "צפייה בחדרים", "rooms"],
    ["rooms.create", "יצירת חדר", "rooms"],
    ["rooms.edit", "עריכת חדר", "rooms"],
    ["rooms.delete", "מחיקת חדר", "rooms"],
    ["rates.view", "צפייה במחירים", "rates"],
    ["rates.edit", "עריכת מחירים", "rates"],
    ["rates.bulk_update", "עדכון מחירים קבוצתי", "rates"],
    // Rate Plans phase (see db/migrations/016_rate_plans.sql)
    ["rate_plans.view", "צפייה בתוכניות תמחור", "rates"],
    ["rate_plans.create", "יצירת תוכניות תמחור", "rates"],
    ["rate_plans.edit", "עריכת תוכניות תמחור", "rates"],
    ["rate_plans.delete", "ארכוב ומחיקת תוכניות תמחור", "rates"],
    ["pricing.simulate", "שימוש בסימולטור התמחור", "rates"],
    ["payments.view", "צפייה בתשלומים", "payments"],
    ["payments.create", "רישום תשלום", "payments"],
    ["payments.refund", "החזר תשלום", "payments"],
    ["housekeeping.view", "צפייה בניקיון", "housekeeping"],
    ["housekeeping.manage", "ניהול משימות ניקיון", "housekeeping"],
    ["housekeeping.my_tasks", "המשימות שלי", "housekeeping"],
    ["users.view", "צפייה במשתמשים", "users"],
    ["users.create", "יצירת משתמש", "users"],
    ["users.edit", "עריכת משתמש", "users"],
    ["users.delete", "מחיקת משתמש", "users"],
    ["roles.view", "צפייה בתפקידים", "roles"],
    ["roles.edit", "עריכת תפקידים והרשאות", "roles"],
    ["lookups.view", "צפייה בערכי מערכת", "settings"],
    ["lookups.edit", "עריכת ערכי מערכת", "settings"],
    ["settings.edit", "עריכת הגדרות", "settings"],
    ["reports.view", "צפייה בדוחות", "reports"],
    ["audit.view", "צפייה בלוג פעילות", "system"],
    // Phase 2 — staff / permissions management (see db/migrations/001_phase2_permissions.sql)
    ["staff.view", "צפייה בעובדים", "staff"],
    ["staff.create", "יצירת עובד", "staff"],
    ["staff.update", "עריכת עובד", "staff"],
    ["staff.disable", "השבתה/הפעלה של עובד", "staff"],
    ["permissions.view", "צפייה במטריצת ההרשאות", "permissions"],
    ["permissions.update", "עדכון הרשאות לתפקיד", "permissions"],
  ];
  const perms = await sql`
    INSERT INTO guesthub.permissions ${sql(
      permDefs.map(([key, description, category]) => ({ key, description, category })),
      "key", "description", "category",
    )} RETURNING id, key`;
  const permId = Object.fromEntries(perms.map((p) => [p.key, p.id]));
  const allKeys = perms.map((p) => p.key);

  // role → permission keys
  const grants = {
    super_admin: allKeys,
    admin: allKeys,
    manager: allKeys, // full nav visible for the proof
    receptionist: [
      "dashboard.view", "calendar.view",
      "reservations.view", "reservations.create", "reservations.edit", "reservations.cancel",
      "guests.view", "guests.create", "guests.edit",
      "rooms.view", "rates.view", "rate_plans.view",
      "payments.view", "payments.create",
      "housekeeping.view",
    ],
    staff: ["dashboard.view", "calendar.view", "reservations.view", "guests.view", "rooms.view", "housekeeping.view"],
    cleaner: ["housekeeping.my_tasks"],
    maintenance: ["housekeeping.my_tasks"],
  };
  const rpRows = [];
  for (const [rk, keys] of Object.entries(grants)) {
    for (const k of keys) rpRows.push({ role_id: roleId[rk], permission_id: permId[k] });
  }
  await sql`INSERT INTO guesthub.role_permissions ${sql(rpRows, "role_id", "permission_id")}`;

  // --- users (5, one per key role incl. super_admin) + Supabase auth ---
  const userDefs = [
    { username: "admin", full_name: "מנהל-על", email: "admin@ginot.co.il", role: "super_admin", phone: "050-1000000" },
    { username: "manager", full_name: "מנהל המלון", email: "manager@ginot.co.il", role: "manager", phone: "050-1000001" },
    { username: "reception", full_name: "פקידת קבלה", email: "reception@ginot.co.il", role: "receptionist", phone: "050-1000002" },
    { username: "staff", full_name: "איש צוות", email: "staff@ginot.co.il", role: "staff", phone: "050-1000003" },
    { username: "cleaner", full_name: "עובד ניקיון", email: "cleaner@ginot.co.il", role: "cleaner", phone: "050-1000004" },
    { username: "maintenance", full_name: "עובד תחזוקה", email: "maintenance@ginot.co.il", role: "maintenance", phone: "050-1000005" },
  ];
  const userRows = [];
  for (const u of userDefs) {
    const authId = SKIP_AUTH
      ? localAuthId(u.email)
      : await upsertAuthUser(u.email, { full_name: u.full_name, tenant: "ginot-hayam" });
    userRows.push({
      tenant_id: tenantId, auth_user_id: authId, username: u.username,
      full_name: u.full_name, email: u.email, phone: u.phone,
      role_id: roleId[u.role], allow_google_auth: false, is_active: true,
    });
    console.log(`  ✓ auth user ${u.email}`);
  }
  const users = await sql`
    INSERT INTO guesthub.users ${sql(userRows,
      "tenant_id", "auth_user_id", "username", "full_name", "email", "phone",
      "role_id", "allow_google_auth", "is_active")} RETURNING id, username`;
  const managerId = users.find((u) => u.username === "manager").id;
  const cleanerUserId = users.find((u) => u.username === "cleaner").id;

  // --- owner mapping (adopts the existing shared Google identity; NO auth user created) ---
  await sql`
    INSERT INTO guesthub.users ${sql([ownerUserRow(tenantId, roleId.super_admin)],
      "tenant_id", "auth_user_id", "username", "full_name", "email", "phone",
      "role_id", "allow_google_auth", "is_active")}`;
  console.log(`  ✓ owner mapping ${OWNER.email} → super_admin (adopts existing Google identity ${OWNER_AUTH_USER_ID}, no auth user created)`);

  // --- lookup_items ---
  const lookups = [
    ["reservation_statuses", "draft", "טיוטה", "#6B7385"],
    ["reservation_statuses", "confirmed", "מאושרת", "#2540C8"],
    ["reservation_statuses", "checked_in", "צ׳ק-אין", "#16A34A"],
    ["reservation_statuses", "checked_out", "צ׳ק-אאוט", "#475569"],
    ["reservation_statuses", "cancelled", "מבוטלת", "#DC2626"],
    ["reservation_statuses", "no_show", "לא הגיע", "#EA9314"],
    ["reservation_statuses", "blocked", "חסימה", "#475569"],
    ["payment_statuses", "unpaid", "לא שולם", "#DC2626"],
    ["payment_statuses", "partial", "שולם חלקית", "#EA9314"],
    ["payment_statuses", "paid", "שולם", "#16A34A"],
    ["payment_statuses", "refunded", "הוחזר", "#64748B"],
    ["payment_statuses", "failed", "נכשל", "#E11D48"],
    ["payment_methods", "cash", "מזומן", null],
    ["payment_methods", "credit_card", "כרטיס אשראי", null],
    ["payment_methods", "bank_transfer", "העברה בנקאית", null],
    ["payment_methods", "bit", "ביט", null],
    ["payment_methods", "cheque", "צ׳ק", null],
    ["booking_sources", "direct", "ישיר", "#2540C8"],
    ["booking_sources", "phone", "טלפון", "#6B7385"],
    ["booking_sources", "walk_in", "מזדמן", "#16A34A"],
    ["booking_sources", "booking_com", "Booking.com", "#003580"],
    ["booking_sources", "airbnb", "Airbnb", "#FF5A5F"],
    ["booking_sources", "expedia", "Expedia", "#FBC02D"],
    ["room_statuses", "available", "פנוי", "#16A34A"],
    ["room_statuses", "inactive", "לא פעיל", "#94A3B8"],
    ["room_statuses", "out_of_order", "מושבת", "#DC2626"],
    ["room_statuses", "maintenance", "בתחזוקה", "#EA9314"],
    ["guest_types", "regular", "רגיל", "#6B7385"],
    ["guest_types", "vip", "VIP", "#7C3AED"],
    ["guest_types", "corporate", "עסקי", "#2540C8"],
    ["guest_types", "blocked", "חסום", "#DC2626"],
    ["currencies", "ILS", "₪ שקל", null],
    ["currencies", "USD", "$ דולר", null],
    ["currencies", "EUR", "€ אירו", null],
    ["languages", "he", "עברית", null],
    ["languages", "en", "אנגלית", null],
    ["languages", "ru", "רוסית", null],
    ["languages", "ar", "ערבית", null],
    ["languages", "fr", "צרפתית", null],
    ["cancellation_policies", "flexible", "גמישה", "#16A34A"],
    ["cancellation_policies", "moderate", "בינונית", "#EA9314"],
    ["cancellation_policies", "strict", "נוקשה", "#DC2626"],
  ];
  const lookupRows = lookups.map(([category, key, label, color], i) => ({
    tenant_id: tenantId, category, key, label, color, sort_order: i,
  }));
  const lookupItems = await sql`
    INSERT INTO guesthub.lookup_items ${sql(lookupRows,
      "tenant_id", "category", "key", "label", "color", "sort_order")} RETURNING id, category, key`;
  const sourceItems = lookupItems.filter((l) => l.category === "booking_sources");

  // --- areas ---
  const areas = await sql`
    INSERT INTO guesthub.areas ${sql([
      { tenant_id: tenantId, name: "בניין ראשי", description: "הבניין המרכזי מול הים", sort_order: 0 },
      { tenant_id: tenantId, name: "אגף הבריכה", description: "יחידות גן סביב הבריכה", sort_order: 1 },
    ], "tenant_id", "name", "description", "sort_order")} RETURNING id, name`;
  const areaMain = areas[0].id;
  const areaPool = areas[1].id;

  // --- room_types ---
  const roomTypeDefs = [
    { name: "סטודיו", base_price: 450, max_occupancy: 2, max_adults: 2, max_children: 1, queen_beds: 1, sofa_beds: 0 },
    { name: "דירת חדר שינה", base_price: 680, max_occupancy: 4, max_adults: 2, max_children: 2, queen_beds: 1, sofa_beds: 1 },
    { name: "סוויטה משפחתית", base_price: 980, max_occupancy: 6, max_adults: 4, max_children: 2, queen_beds: 2, sofa_beds: 1, cribs: 1 },
  ];
  const roomTypes = await sql`
    INSERT INTO guesthub.room_types ${sql(
      roomTypeDefs.map((rt) => ({ tenant_id: tenantId, description: null, max_infants: 1, single_beds: 0, double_beds: 0, cribs: 0, sofa_beds: 0, ...rt })),
      "tenant_id", "name", "description", "base_price", "max_occupancy", "max_adults",
      "max_children", "max_infants", "single_beds", "double_beds", "queen_beds", "sofa_beds", "cribs",
    )} RETURNING id, name, base_price, max_occupancy, max_adults, max_children`;
  const basePriceByType = Object.fromEntries(roomTypes.map((r) => [r.id, Number(r.base_price)]));

  // --- rooms (14, all available + active) ---
  const roomRows = [];
  let n = 0;
  for (let floor = 1; floor <= 3; floor++) {
    for (let k = 1; k <= 3; k++) {
      const rt = roomTypes[(n) % 3];
      roomRows.push({
        tenant_id: tenantId, area_id: areaMain, room_type_id: rt.id,
        room_number: `${floor}0${k}`, floor: String(floor), name: `${rt.name} ${floor}0${k}`,
        status: "available", is_active: true,
        max_occupancy: rt.max_occupancy, max_adults: rt.max_adults, max_children: rt.max_children,
        max_infants: 1, single_beds: 0, double_beds: 0, queen_beds: 1, sofa_beds: 0, cribs: 0,
      });
      n++;
    }
  }
  // pool wing units
  for (let k = 1; k <= 5; k++) {
    const rt = roomTypes[k % 3];
    roomRows.push({
      tenant_id: tenantId, area_id: areaPool, room_type_id: rt.id,
      room_number: `G${k}`, floor: "0", name: `יחידת גן G${k}`,
      status: "available", is_active: true,
      max_occupancy: rt.max_occupancy, max_adults: rt.max_adults, max_children: rt.max_children,
      max_infants: 1, single_beds: 0, double_beds: 0, queen_beds: 1, sofa_beds: 0, cribs: 0,
    });
  }
  // Every seeded room stays available + active. Non-sellable states — inactive,
  // out_of_order, room_closures, stop_sell — must come from REAL operational facts
  // entered by staff, never from the seed. Fixture state masquerading as a business
  // rule is exactly how a not-sellable "G4" reached production; the seed must not
  // encode it. rooms.status may be available|inactive|out_of_order (§0.5), but the
  // seed only ever assigns `available`.

  const rooms = await sql`
    INSERT INTO guesthub.rooms ${sql(roomRows,
      "tenant_id", "area_id", "room_type_id", "room_number", "floor", "name", "status", "is_active",
      "max_occupancy", "max_adults", "max_children", "max_infants",
      "single_beds", "double_beds", "queen_beds", "sofa_beds", "cribs")}
    RETURNING id, room_type_id, status, is_active, room_number`;
  const sellableRooms = rooms.filter((r) => r.status === "available" && r.is_active);

  // --- guests (20, incl. VIP + blocked) ---
  const firstNames = ["דוד", "מיכל", "יוסי", "נועה", "אבי", "רות", "עמית", "שירה", "רון", "טל", "גיל", "ליאת", "אורי", "דנה", "יעל", "משה", "חן", "עדי", "ניר", "מאיה"];
  const lastNames = ["כהן", "לוי", "מזרחי", "פרץ", "ביטון", "אברהם", "פרידמן", "שפירא", "אזולאי", "דהן", "גבאי", "בן דוד", "רוזן", "חדד", "מלכה", "סבן", "אוחיון", "נחום", "ברק", "טל"];
  const guestRows = [];
  for (let i = 0; i < 20; i++) {
    const fn = firstNames[i], ln = lastNames[i];
    guestRows.push({
      tenant_id: tenantId, first_name: fn, last_name: ln, full_name: `${fn} ${ln}`,
      phone: `05${randInt(0, 8)}-${randInt(1000000, 9999999)}`,
      email: `guest${i + 1}@example.com`,
      id_number: String(randInt(200000000, 399999999)),
      country: "ישראל", city: pick(["תל אביב", "חיפה", "ירושלים", "באר שבע", "נתניה"]),
      language: "he",
      is_vip: i < 3, is_blocked: i === 19,
      notes: i < 3 ? "אורח VIP — יחס מועדף" : i === 19 ? "אורח חסום — אי-תשלום בעבר" : null,
    });
  }
  const guests = await sql`
    INSERT INTO guesthub.guests ${sql(guestRows,
      "tenant_id", "first_name", "last_name", "full_name", "phone", "email", "id_number",
      "country", "city", "language", "is_vip", "is_blocked", "notes")} RETURNING id, is_vip, is_blocked`;
  const bookableGuests = guests.filter((g) => !g.is_blocked);

  // --- reservations (§20: 30-40, current month ±1, overlaps, all statuses) ---
  const today = new Date("2026-07-03T00:00:00Z");
  const windowStart = addDays(today, -28);
  const occupancy = new Map(sellableRooms.map((r) => [r.id, []]));

  function freeRoom(ci, co) {
    const shuffled = [...sellableRooms].sort(() => Math.random() - 0.5);
    return shuffled.find((r) =>
      occupancy.get(r.id).every(([bi, bo]) => !overlaps(ci, co, bi, bo)),
    );
  }

  const resReturned = [];
  let resNo = 1001;
  const target = 36;
  let attempts = 0;
  while (resReturned.length < target && attempts < target * 6) {
    attempts++;
    const startOffset = randInt(0, 84); // ~12 weeks from windowStart
    const ci = addDays(windowStart, startOffset);
    const nights = randInt(1, 7);
    const co = addDays(ci, nights);

    // status by time position
    let status;
    if (co <= today) status = pick(["checked_out", "checked_out", "cancelled"]);
    else if (ci <= today && co > today) status = pick(["checked_in", "confirmed"]);
    else status = pick(["confirmed", "confirmed", "cancelled", "draft"]);

    const blocking = status === "confirmed" || status === "checked_in";
    let room;
    if (blocking) {
      room = freeRoom(ci, co);
      if (!room) continue; // no free room in range → skip
      occupancy.get(room.id).push([ci, co]);
    } else {
      room = pick(sellableRooms); // cancelled/checked_out/draft may overlap freely
    }

    const guest = pick(bookableGuests);
    const basePrice = basePriceByType[room.room_type_id];
    const priceTotal = basePrice * nights;
    const adults = randInt(1, 2), children = randInt(0, 2);

    // payment posture
    let paid = 0;
    if (status === "checked_out") paid = priceTotal;
    else if (status === "checked_in") paid = Math.round(priceTotal * pick([0.5, 1]));
    else if (status === "confirmed") paid = Math.round(priceTotal * pick([0, 0.3, 0.5]));
    const balance = priceTotal - paid;
    const source = pick(sourceItems);

    resReturned.push({
      _room: room, _ci: ci, _co: co, _nights: nights, _rate: basePrice,
      _adults: adults, _children: children, _paid: paid, _status: status,
      row: {
        tenant_id: tenantId, reservation_number: String(resNo++),
        primary_guest_id: guest.id, source_id: source.id, status,
        check_in: iso(ci), check_out: iso(co), adults, children, infants: 0,
        total_price: priceTotal, paid_amount: paid, balance,
        is_vip: guest.is_vip, currency: "ILS", created_by: managerId,
      },
    });
  }

  // Guarantee at least 2 explicit overlaps: cancelled reservation over a confirmed one.
  const confirmedSamples = resReturned.filter((r) => r._status === "confirmed").slice(0, 2);
  for (const c of confirmedSamples) {
    const guest = pick(bookableGuests);
    const basePrice = basePriceByType[c._room.room_type_id];
    const priceTotal = basePrice * c._nights;
    resReturned.push({
      _room: c._room, _ci: c._ci, _co: c._co, _nights: c._nights, _rate: basePrice,
      _adults: 1, _children: 0, _paid: 0, _status: "cancelled",
      row: {
        tenant_id: tenantId, reservation_number: String(resNo++),
        primary_guest_id: guest.id, source_id: pick(sourceItems).id, status: "cancelled",
        check_in: iso(c._ci), check_out: iso(c._co), adults: 1, children: 0, infants: 0,
        total_price: priceTotal, paid_amount: 0, balance: priceTotal,
        is_vip: false, currency: "ILS", created_by: managerId,
      },
    });
  }

  const insertedRes = await sql`
    INSERT INTO guesthub.reservations ${sql(resReturned.map((r) => r.row),
      "tenant_id", "reservation_number", "primary_guest_id", "source_id", "status",
      "check_in", "check_out", "adults", "children", "infants",
      "total_price", "paid_amount", "balance", "is_vip", "currency", "created_by")}
    RETURNING id, reservation_number`;
  const resIdByNo = Object.fromEntries(insertedRes.map((r) => [r.reservation_number, r.id]));

  // --- reservation_rooms + payments + checkout housekeeping tasks ---
  const rrRows = [];
  const payRows = [];
  const hkRows = [];
  for (const r of resReturned) {
    const resId = resIdByNo[r.row.reservation_number];
    rrRows.push({
      tenant_id: tenantId, reservation_id: resId, room_id: r._room.id,
      check_in: r.row.check_in, check_out: r.row.check_out,
      adults: r._adults, children: r._children, infants: 0,
      rate_per_night: r._rate, price_total: r._rate * r._nights,
    });
    if (r._paid > 0) {
      payRows.push({
        tenant_id: tenantId, reservation_id: resId, amount: r._paid,
        method: pick(["cash", "credit_card", "bank_transfer", "bit"]),
        // D52: a captured payment ROW is always 'paid'. Whether the reservation
        // is fully/partly paid is DERIVED from the ledger, not stored per row —
        // 'partial' is a reservation state, never a payment-row status.
        status: "paid",
        paid_at: new Date(r.row.check_in + "T10:00:00Z"),
        reference: `RCPT-${r.row.reservation_number}`,
      });
    }
    // checkout today or within the last 3 days → room dirty until cleaned (§12 auto task)
    const daysSinceCheckout = Math.round(
      (today.getTime() - Date.parse(r.row.check_out + "T00:00:00Z")) / 86400000,
    );
    if (
      r._status !== "cancelled" && r._status !== "draft" &&
      daysSinceCheckout >= 0 && daysSinceCheckout <= 3
    ) {
      hkRows.push({
        tenant_id: tenantId, room_id: r._room.id, reservation_id: resId,
        checkout_time: new Date(r.row.check_out + "T11:00:00Z"),
        status: "pending", assigned_to: cleanerUserId, priority: "normal",
      });
    }
  }
  await sql`INSERT INTO guesthub.reservation_rooms ${sql(rrRows,
    "tenant_id", "reservation_id", "room_id", "check_in", "check_out",
    "adults", "children", "infants", "rate_per_night", "price_total")}`;
  if (payRows.length)
    await sql`INSERT INTO guesthub.payments ${sql(payRows,
      "tenant_id", "reservation_id", "amount", "method", "status", "paid_at", "reference")}`;
  if (hkRows.length)
    await sql`INSERT INTO guesthub.housekeeping_tasks ${sql(hkRows,
      "tenant_id", "room_id", "reservation_id", "checkout_time", "status", "assigned_to", "priority")}`;

  // --- Sellable Units + base pricing plans (§0.1/§0.4): one SU per room ---
  const suRows = rooms.map((r) => ({
    tenant_id: tenantId, code: r.room_number,
    name: `יחידה ${r.room_number}`, room_type_id: r.room_type_id,
    is_pooled: false, is_active: true,
  }));
  const sus = await sql`INSERT INTO guesthub.sellable_units ${sql(suRows,
    "tenant_id", "code", "name", "room_type_id", "is_pooled", "is_active")}
    RETURNING id, code, room_type_id`;
  const suByCode = Object.fromEntries(sus.map((s) => [s.code, s]));

  const memberRows = rooms.map((r) => ({
    tenant_id: tenantId, sellable_unit_id: suByCode[r.room_number].id, room_id: r.id,
  }));
  await sql`INSERT INTO guesthub.sellable_unit_rooms ${sql(memberRows,
    "tenant_id", "sellable_unit_id", "room_id")}`;

  const planRows = sus.map((s) => ({
    tenant_id: tenantId, sellable_unit_id: s.id, code: "base",
    name: "מחיר בסיס", is_base: true, is_active: true,
  }));
  const plans = await sql`INSERT INTO guesthub.pricing_plans ${sql(planRows,
    "tenant_id", "sellable_unit_id", "code", "name", "is_base", "is_active")}
    RETURNING id, sellable_unit_id`;
  const planBySu = Object.fromEntries(plans.map((p) => [p.sellable_unit_id, p.id]));

  // --- canonical commercial rates (PARTIAL — many dates fall back to base_price) ---
  const ppRateRows = [];
  const rateUnits = sus.slice(0, 4); // only some units get explicit rates
  for (const su of rateUnits) {
    const base = basePriceByType[su.room_type_id];
    for (let off = -10; off <= 30; off++) {
      if (Math.random() < 0.55) continue; // ~55% of dates left without an explicit rate
      const d = addDays(today, off);
      const dow = d.getUTCDay(); // 5=Fri,6=Sat weekend uplift
      const factor = dow === 5 || dow === 6 ? 1.25 : 1.0;
      ppRateRows.push({
        tenant_id: tenantId, sellable_unit_id: su.id, pricing_plan_id: planBySu[su.id],
        date: iso(d), price: Math.round(base * factor),
        min_stay_arrival: dow === 5 ? 2 : null, min_stay_through: null, max_stay: null,
        stop_sell: false, closed_to_arrival: false, closed_to_departure: false,
      });
    }
  }
  await sql`INSERT INTO guesthub.pricing_plan_rates ${sql(ppRateRows,
    "tenant_id", "sellable_unit_id", "pricing_plan_id", "date", "price",
    "min_stay_arrival", "min_stay_through", "max_stay",
    "stop_sell", "closed_to_arrival", "closed_to_departure")}`;

  // --- report ---
  const counts = {};
  for (const t of [
    "tenants", "roles", "permissions", "role_permissions", "users", "areas", "room_types",
    "rooms", "guests", "lookup_items", "reservations", "reservation_rooms",
    "sellable_units", "sellable_unit_rooms", "pricing_plans", "pricing_plan_rates",
    "payments", "housekeeping_tasks",
  ]) {
    const [{ c }] = await sql.unsafe(`SELECT count(*)::int AS c FROM guesthub.${t}`);
    counts[t] = c;
  }
  console.log("\n✓ seed complete:");
  console.table(counts);
  console.log(`\nlogin: admin / manager / reception / staff / cleaner  ·  password: ${SEED_PASSWORD}`);

  await sql.end();
}

// Only auto-run when invoked directly (node scripts/seed.mjs) — importing this
// module (e.g. from the regression tests) must not execute the destructive seed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    console.error("SEED FAILED:", e);
    await sql.end();
    process.exit(1);
  });
}
