// ============================================================
// check:room-picker-window — the booking-panel room picker's window + honesty
// gate (docs/PRICING_AUDIT.md §יא, docs/LONG_STAY_FIX.md §G.2).
//
// The defect class this pins:
// 1. getAvailableRoomsAction kept a hardcoded 90-night refusal after D100 made
//    the quote window per-tenant (resolveMaxQuoteNights, default 400) — the
//    picker refused stays the engine priced happily.
// 2. StayEditor swallowed failures (`res.success && res.data`) on BOTH of its
//    fetches: the room list kept the PREVIOUS window's rows (free flags,
//    avg_price of other dates), and the quote kept the PREVIOUS range's ₪total
//    — a number that gets read aloud to a guest — with no error anywhere.
//
// Part A — static wiring: the action delegates to listAvailableRooms; the lib
//   takes its bound from resolveMaxQuoteNights (no second constant); StayEditor
//   routes fulfilled, failed AND rejected outcomes of BOTH fetches through the
//   pure reducers (roomsFromResult / quoteFromResult) and renders the errors.
//   The quote is stricter: any input change clears the displayed total BEFORE
//   the new fetch, so an in-flight quote never shows the old range's money.
// Part B — pure: roomsFromResult never keeps rows, and quoteFromResult never
//   keeps a number, on a failed/empty result.
// Part C — DB: listAvailableRooms end-to-end against the ISOLATED test DB
//   (:5433 guesthub-testdb): 120- and 200-night windows return the full,
//   range-correct list; the default ceiling refuses at ceiling+1; a tenant's
//   settings.pricing.max_quote_nights=150 refuses 151 and allows 150. The
//   REAL engine (calculateQuote) prices the same 120-night window and its
//   roomSubtotal both matches the picker's avg hint and passes through
//   quoteFromResult untouched.
//   Everything runs in one rolled-back transaction — NOTHING is committed.
//
// Usage: node scripts/check-room-picker-window.mjs
// ============================================================

import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// the tree this script lives in — never an absolute checkout (check:guard-roots)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";

// fail-closed: this script must never run against production
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ============================================================
// Part A — static wiring
// ============================================================
{
  const actions = read("src/app/(dashboard)/reservations/actions.ts");
  const lib = read("src/lib/reservations/available-rooms.ts");
  const editor = read("src/components/reservations/StayEditor.tsx");

  assert.ok(!/טווח ארוך מדי/.test(actions),
    "the blind 'טווח ארוך מדי' 90-night refusal is gone from the action");
  assert.ok(/listAvailableRooms\(sql,\s*actor\.tenantId/.test(actions),
    "the action delegates to listAvailableRooms — the lib this guard drives");
  ok("action: no hardcoded window, delegates to the guarded lib");

  assert.ok(/resolveMaxQuoteNights\(/.test(lib),
    "the lib resolves the bound via resolveMaxQuoteNights (D100)");
  assert.ok(!/[><]=?\s*90\b/.test(lib) && !/=\s*(90|400)\b/.test(lib),
    "no second window constant in the lib — the bound has ONE source of truth");
  assert.ok(/חורג מחלון התמחור המותר \(\$\{maxNights\} לילות\)/.test(lib),
    "the refusal names the bound, in the engine's wording");
  ok("lib: the bound is resolveMaxQuoteNights — named in the error, no second constant");

  assert.ok(!/res\.success\s*&&\s*res\.data\)\s*setRooms/.test(editor),
    "the silent apply-only-on-success pattern is gone from StayEditor");
  assert.ok(/apply\(roomsFromResult\(res\)\)/.test(editor),
    "fulfilled responses go through roomsFromResult");
  assert.ok(/apply\(roomsFromResult\(null\)\)/.test(editor),
    "REJECTED promises also go through roomsFromResult — a network failure clears too");
  assert.ok(/setRooms\(outcome\.rooms\)/.test(editor) && /setRoomsError\(outcome\.error\)/.test(editor),
    "the outcome is applied to BOTH the list and the error state");
  assert.ok(/\{roomsError\s*&&[\s\S]{0,200}role="alert"/.test(editor),
    "the fetch error renders as a role=\"alert\" message");
  ok("StayEditor: every outcome clears-or-fills the list and says why — no stale rows");

  assert.ok(!/alive\s*&&\s*res\.success\s*&&\s*res\.data/.test(editor),
    "the silent apply-only-on-success pattern is gone from the QUOTE fetch too");
  assert.ok(/useEffect\(\(\)\s*=>\s*\{\s*\n\s*setQuote\(null\);\s*\n\s*setQuoteError\(null\);/.test(editor),
    "any input change clears the displayed total BEFORE fetching — no in-flight stale money");
  assert.ok(/apply\(quoteFromResult\(res\)\)/.test(editor) && /apply\(quoteFromResult\(null\)\)/.test(editor),
    "fulfilled AND rejected quote outcomes go through quoteFromResult");
  assert.ok(/setQuoteError\(outcome\.error\)/.test(editor),
    "the quote outcome's reason reaches state");
  assert.ok(/\{quoteError\s*&&[\s\S]{0,220}role="alert"/.test(editor),
    "the quote error renders as a role=\"alert\" message");
  ok("StayEditor: the quote — money read aloud — clears on change, fails loud, never stale");
}

// ============================================================
// compile the REAL modules (tsc, CommonJS)
// ============================================================
console.log("compiling src/lib/reservations via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-roompicker-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [
    join(ROOT, "src/lib/reservations/available-rooms.ts"),
    join(ROOT, "src/lib/reservations/room-picker-result.ts"),
    join(ROOT, "src/lib/pricing/engine.ts"),
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

const { listAvailableRooms } = req(join(out, "lib/reservations/available-rooms.js"));
const { roomsFromResult, quoteFromResult, ROOMS_FETCH_FAILED, NO_ROOMS_AVAILABLE, QUOTE_FETCH_FAILED } =
  req(join(out, "lib/reservations/room-picker-result.js"));
const { resolveMaxQuoteNights } = req(join(out, "lib/pricing/types.js"));
const { calculateQuote } = req(join(out, "lib/pricing/engine.js"));
const { nightsBetween } = req(join(out, "lib/dates.js"));

// ============================================================
// Part B — roomsFromResult is stale-proof
// ============================================================
{
  const rows = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(roomsFromResult({ success: true, data: rows }), { rooms: rows, error: null });
  assert.deepEqual(roomsFromResult({ success: false, error: "החדר נעלם" }),
    { rooms: [], error: "החדר נעלם" });
  assert.deepEqual(roomsFromResult({ success: true }), { rooms: [], error: ROOMS_FETCH_FAILED });
  assert.deepEqual(roomsFromResult({ success: true, data: [] }),
    { rooms: [], error: NO_ROOMS_AVAILABLE });
  assert.deepEqual(roomsFromResult(null), { rooms: [], error: ROOMS_FETCH_FAILED });
  ok("roomsFromResult: rows only on success-with-rows; every other outcome = empty list + reason");

  const q = { total: 54_000, restriction: null };
  assert.deepEqual(quoteFromResult({ success: true, data: q }), { quote: q, error: null });
  assert.deepEqual(quoteFromResult({ success: false, error: "חישוב המחיר נכשל בצד השרת" }),
    { quote: null, error: "חישוב המחיר נכשל בצד השרת" });
  assert.deepEqual(quoteFromResult({ success: true }), { quote: null, error: QUOTE_FETCH_FAILED });
  assert.deepEqual(quoteFromResult(null), { quote: null, error: QUOTE_FETCH_FAILED });
  ok("quoteFromResult: a ₪total only from success-with-data; every other outcome = NO number + reason");
}

// ============================================================
// Part C — end-to-end on the test DB (rolled back)
// ============================================================
console.log("applying migration chain to the test DB…");
const migrations = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  execSync(
    `psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q < "db/migrations/${f}"`,
    { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
  );
}

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1 });
class Rollback extends Error {}

const addD = (d, k) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const IN = "2027-04-01";               // 120-night window: IN → addD(IN,120)
const IN2 = "2027-09-01";              // disjoint 200-night window

async function buildFixture(tx) {
  const uniq = (p) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [tenant] = await tx`
    INSERT INTO guesthub.tenants (name, slug, timezone, currency, settings)
    VALUES ('בדיקת בורר חדרים', ${uniq("room-picker")}, 'Asia/Jerusalem', 'ILS', ${tx.json({})})
    RETURNING id`;
  const T = tenant.id;
  const [rt] = await tx`
    INSERT INTO guesthub.room_types (tenant_id, name, base_price)
    VALUES (${T}, 'סוג בדיקה', 400) RETURNING id`;

  const mkRoom = async (num, extra = {}) => {
    const [r] = await tx`
      INSERT INTO guesthub.rooms ${tx({
        tenant_id: T, room_type_id: rt.id, room_number: num, name: `חדר ${num}`,
        status: "available", is_active: true,
        max_occupancy: 4, max_adults: 3, max_children: 2, max_infants: 1,
        min_occupancy: 1, included_occupancy: 2, default_occupancy: 4,
        extra_guest_pricing_mode: "inherit",
        ...extra,
      })} RETURNING id`;
    const [su] = await tx`
      INSERT INTO guesthub.sellable_units (tenant_id, code, name, room_type_id)
      VALUES (${T}, ${num}, ${`יחידה ${num}`}, ${rt.id}) RETURNING id`;
    await tx`
      INSERT INTO guesthub.sellable_unit_rooms (tenant_id, sellable_unit_id, room_id)
      VALUES (${T}, ${su.id}, ${r.id})`;
    const [bp] = await tx`
      INSERT INTO guesthub.pricing_plans (tenant_id, sellable_unit_id, code, name, is_base, plan_kind)
      VALUES (${T}, ${su.id}, 'base', 'מחיר בסיס', true, 'base') RETURNING id`;
    return { roomId: r.id, suId: su.id, basePlanId: bp.id };
  };

  const R1 = await mkRoom("901");
  const R2 = await mkRoom("902");
  await mkRoom("903", { is_active: false }); // must never appear in the picker

  // nightly 500 on the FIRST 60 nights of the 120-window only; the other 60
  // fall back to room_types.base_price 400 → avg 450 in THIS window, 400 in a
  // window without rates. Same room, different window, different avg — exactly
  // what a stale list would lie about.
  await tx`
    INSERT INTO guesthub.pricing_plan_rates (tenant_id, sellable_unit_id, pricing_plan_id, date, price)
    SELECT ${T}, ${R1.suId}, ${R1.basePlanId}, d::date, 500
    FROM generate_series(${IN}::date, ${addD(IN, 59)}::date, '1 day') d`;

  // room 902 is occupied for 9 nights INSIDE the 120-window (and nowhere near
  // the 200-window) by a confirmed reservation
  const [resv] = await tx`
    INSERT INTO guesthub.reservations
      (tenant_id, reservation_number, status, check_in, check_out)
    VALUES (${T}, 'RP-1', 'confirmed', ${addD(IN, 30)}, ${addD(IN, 39)})
    RETURNING id`;
  await tx`
    INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
    VALUES (${T}, ${resv.id}, ${R2.roomId}, ${addD(IN, 30)}, ${addD(IN, 39)})`;

  return { T, R1, R2, resvId: resv.id };
}

async function scenario(tx, fn) {
  try {
    await tx.savepoint(async (sp) => { await fn(sp); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const summary = [];
try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);
    const ceiling = resolveMaxQuoteNights(null);
    assert.ok(ceiling >= 366, `default window is ${ceiling} — a yearly let must be pickable`);

    // ---- 120 nights: full, range-correct list ----
    {
      const OUT = addD(IN, 120);
      assert.equal(nightsBetween(IN, OUT), 120);
      const r = await listAvailableRooms(tx, f.T, { checkIn: IN, checkOut: OUT });
      assert.equal(r.ok, true, `120 nights must be listable (got: ${r.ok ? "ok" : r.error})`);
      assert.deepEqual(r.rooms.map((x) => x.room_number), ["901", "902"],
        "both active rooms, ordered; the inactive 903 never appears");
      const [r901, r902] = r.rooms;
      assert.equal(r901.free, true);
      assert.equal(r902.free, false, "902 is occupied inside this window");
      assert.equal(r901.avg_price, 450, "avg = (60×500 + 60×400)/120 — rates of THIS window");
      assert.equal(r902.avg_price, 400);
      summary.push({ nights: 120, ok: "YES", rooms: 2, "902_free": false, avg901: r901.avg_price });
      ok("120 nights: both rooms, 902 correctly occupied, avg from this window's rates (450)");

      // the edit flow: excluding the occupying reservation frees 902
      const rx = await listAvailableRooms(tx, f.T,
        { checkIn: IN, checkOut: OUT, excludeReservationId: f.resvId });
      assert.equal(rx.ok, true);
      assert.equal(rx.rooms.find((x) => x.room_number === "902").free, true,
        "excludeReservationId frees the room its own stay occupies");
      ok("120 nights + excludeReservationId: a stay never conflicts with itself");
    }

    // ---- the quote for the same 120-night window: the REAL engine's number,
    //      matching the picker's hint, surviving the reducer untouched ----
    {
      const OUT = addD(IN, 120);
      const q = await calculateQuote(tx, {
        tenantId: f.T, checkIn: IN, checkOut: OUT,
        rooms: [{ roomId: f.R1.roomId, ratePlanId: null,
                  adults: 2, children: 0, infants: 0, manualRatePerNight: null }],
        source: "manual_reservation",
      });
      assert.equal(q.valid, true, `the engine must price 120 nights (errors: ${JSON.stringify(q.errors)})`);
      const subtotal = q.rooms[0].roomSubtotal;
      assert.equal(subtotal, 54_000, "60×500 + 60×400 — the engine prices THIS window's rates");
      assert.equal(subtotal, 450 * 120, "the quoted total and the picker's avg hint agree");
      // the action's success payload (total = roomSubtotal) passes through untouched…
      const shown = quoteFromResult({ success: true, data: { total: subtotal, restriction: null } });
      assert.equal(shown.quote.total, 54_000);
      assert.equal(shown.error, null);
      // …and the action's failure shape yields NO number, only the reason
      const failed = quoteFromResult({ success: false, error: "חישוב המחיר נכשל" });
      assert.equal(failed.quote, null, "a failed quote never yields a number to render");
      summary.push({ nights: 120, ok: "YES", rooms: "-", "902_free": "-", avg901: "₪54,000 quote" });
      ok("quote 120 nights: engine total ₪54,000 = 450×120; success renders it, failure renders NO number");
    }

    // ---- 200 nights, disjoint window: same rooms, different truth ----
    {
      const OUT2 = addD(IN2, 200);
      assert.equal(nightsBetween(IN2, OUT2), 200);
      const r = await listAvailableRooms(tx, f.T, { checkIn: IN2, checkOut: OUT2 });
      assert.equal(r.ok, true, `200 nights must be listable (got: ${r.ok ? "ok" : r.error})`);
      assert.deepEqual(r.rooms.map((x) => x.room_number), ["901", "902"]);
      assert.equal(r.rooms[1].free, true, "902 is FREE here — the flag belongs to the window");
      assert.equal(r.rooms[0].avg_price, 400, "no rates in this window → base 400, not 450");
      summary.push({ nights: 200, ok: "YES", rooms: 2, "902_free": true, avg901: 400 });
      ok("200 nights (disjoint): 902 free, avg 400 — free flags and prices are per-window facts");
    }

    // ---- the default ceiling refuses at +1, names the bound ----
    {
      const r = await listAvailableRooms(tx, f.T, { checkIn: IN, checkOut: addD(IN, ceiling + 1) });
      assert.equal(r.ok, false, `${ceiling + 1} nights is past the default ceiling`);
      assert.ok(r.error.includes(String(ceiling)),
        `the refusal names the bound (got: "${r.error}")`);
      summary.push({ nights: ceiling + 1, ok: "NO", rooms: "-", "902_free": "-", avg901: "-" });
      ok(`${ceiling + 1} nights: refused, and the error names the ${ceiling}-night bound`);
    }

    // ---- the bound is the TENANT's setting, not a constant ----
    await scenario(tx, async (sp) => {
      await sp`
        UPDATE guesthub.tenants
        SET settings = jsonb_set(settings, '{pricing}', '{"max_quote_nights": 150}')
        WHERE id = ${f.T}`;
      const over = await listAvailableRooms(sp, f.T, { checkIn: IN, checkOut: addD(IN, 151) });
      assert.equal(over.ok, false, "151 nights over a 150-night tenant bound is refused");
      assert.ok(over.error.includes("150"), `the refusal names the TENANT's bound (got: "${over.error}")`);
      const at = await listAvailableRooms(sp, f.T, { checkIn: IN, checkOut: addD(IN, 150) });
      assert.equal(at.ok, true, "exactly the tenant bound passes");
      ok("settings.pricing.max_quote_nights=150: refused at 151, allowed at 150 — per-tenant, from settings");
    });

    // ---- garbage in = a refusal, never a stale-friendly silence ----
    {
      const r = await listAvailableRooms(tx, f.T, { checkIn: IN, checkOut: IN });
      assert.equal(r.ok, false);
      assert.equal(r.error, "טווח תאריכים לא תקין");
      ok("checkOut ≤ checkIn: refused with a reason");
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
} finally {
  await sql.end();
}

console.log("\n=== summary ===");
console.table(summary);
console.log(`\nALL ${n} ROOM-PICKER-WINDOW CHECKS PASSED (nothing committed)`);
