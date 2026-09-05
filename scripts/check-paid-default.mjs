#!/usr/bin/env node
// ============================================================
// check:paid-default — D174: a reservation created with no paid input writes
// NO payment row; an explicit paid=500 writes exactly one row of 500; and the
// booking wizard never again fills "שולם" from the live total by itself.
//
// THE DEFECT (production, #1159). D87 §2 made the wizard copy the running
// total into "סכום ששולם" until the operator edited it. Nobody edited it, so
// every create wrote a cash payment row for the whole total — 75 back-office
// reservations carry one (05/09/2026 count) — and when a room was later
// removed the ledger kept the money: balance −760 on #1159, 10 reservations
// negative today.
//
// Runtime where it can be: the REAL createReservationAction is compiled
// (tsc → CommonJS) and RUN over a recording `sql` double — every statement the
// action issues is captured, none reaches a database. No DB, no network, no
// build. Static where it cannot: BookingPanel is a React state machine, so the
// claim "no effect writes שולם" is made on its source.
// Self-test (B2): both claims are re-run over a mutant and MUST fail on it.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-paid-default.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs";
import strict from "node:assert/strict";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
/** null when fn passes, its message when it throws — collect-all friendly */
const failureOf = (fn) => { try { fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };

const ACTIONS = "src/app/(dashboard)/reservations/actions.ts";
const BOOKING = "src/components/reservations/BookingPanel.tsx";
const EDIT = "src/components/reservations/EditReservationPanel.tsx";

// ============================================================
// 1. Compile the real create action (tsc → CJS) and stub ONLY its edges:
//    the database, the session, the pricing engine, Next's cache.
// ============================================================
// under the repo's node_modules on purpose: the compiled action `require`s bare
// packages (zod, @hebcal/core, …) and Node resolves those by walking UP from the
// requiring file — from /tmp there is nothing to find. Same home as
// check:guest-communications-worker. Removed on exit.
mkdirSync(join(ROOT, "node_modules/.cache"), { recursive: true });
const tmp = mkdtempSync(join(ROOT, "node_modules/.cache/check-paid-default-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const out = join(tmp, "out");
writeFileSync(
  join(tmp, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs", moduleResolution: "node10", target: "es2022", jsx: "react-jsx",
      esModuleInterop: true, skipLibCheck: true, strict: true,
      baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
      rootDir: join(ROOT, "src"), outDir: out,
      typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
    },
    include: [join(ROOT, ACTIONS)],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000ab";
const GUEST = "00000000-0000-4000-8000-0000000000ac";
const RES = "00000000-0000-4000-8000-0000000000ad";
const ROOM = "00000000-0000-4000-8000-0000000000ae";
const FIXTURE_TOTAL = 2000; // 2 nights × 1000 — what the pricing stub returns

const stubDir = join(tmp, "stubs");
mkdirSync(stubDir);
const stub = (name, body) => { const p = join(stubDir, name); writeFileSync(p, body); return p; };

// the recording sql double: every statement is captured; rows come from fixtures.
// Positional values follow the action's own template order.
const dbStub = stub("db.js", `
const calls = [];
const IDS = ${JSON.stringify({ GUEST, RES })};
const TOTAL = ${FIXTURE_TOTAL};
async function run(strings, values) {
  const text = strings.join(" $ ");
  calls.push({ text, values });
  if (/FROM guesthub\\.rooms[\\s\\S]*FOR UPDATE/.test(text)) return (values[1] || []).map((id) => ({ id })); // lockRooms: one row per id
  if (/AS next/.test(text)) return [{ next: "1160" }];
  if (/INSERT INTO guesthub\\.guests/.test(text)) return [{ id: IDS.GUEST }];
  if (/INSERT INTO guesthub\\.reservations\\b/.test(text)) return [{ id: IDS.RES }];
  if (/RETURNING x\\.paid/.test(text)) {
    // recomputePaymentAggregates — derived from the payment rows THIS run inserted
    const paid = calls.filter((c) => /INSERT INTO guesthub\\.payments/.test(c.text)).reduce((s, c) => s + Number(c.values[2]), 0);
    return [{ paid, balance: TOTAL - paid, total: TOTAL }];
  }
  return [];
}
function tag(strings, ...values) {
  if (!Array.isArray(strings)) return { __columns: strings }; // sql(obj) helper — not on the create path
  return run(strings, values);
}
tag.json = (v) => v;
tag.begin = async (cb) => cb(tag);
tag.unsafe = async () => [];
module.exports = { sql: tag, calls, reset: () => { calls.length = 0; } };
`);

const actorStub = stub("actor.js", `
const pc = require(${JSON.stringify(join(out, "lib/auth/permission-check.js"))});
const ACTOR = {
  userId: ${JSON.stringify(USER)}, tenantId: ${JSON.stringify(TENANT)}, authUserId: ${JSON.stringify(USER)},
  username: "guard", fullName: null, email: null, roleKey: "owner", roleName: null,
  tenantName: "guard", tenantSlug: "guard",
  permissions: new Set(["reservations.create", "reservations.edit"]),
};
module.exports = { ...pc, getActor: async () => ACTOR, effectivePermissionKeys: async () => [...ACTOR.permissions], toActorContext: (a) => a };
`);

// the engine is DB-backed; the fixture prices every stay to 2 nights × 1000
const pricingStub = stub("reservation-pricing.js", `
class StayPricingError extends Error {}
module.exports = {
  StayPricingError,
  OVERRIDABLE_RESTRICTION_CODES: new Set(),
  priceReservationStays: async (tx, tenantId, stays) => stays.map((s) => ({
    ...s, nights: 2, ratePerNight: 1000, priceTotal: ${FIXTURE_TOTAL}, isManualRate: false,
    ratePlanId: s.ratePlanId ?? null, pricingSnapshot: null,
  })),
};
`);

// @hebcal/core (via lib/settings → check-in-check-out) is ESM-only with no
// `require` export; the compiled CJS gets it through a bridge, loaded here first.
globalThis.__hebcal = await import("@hebcal/core");
const byRequest = new Map([
  ["@hebcal/core", stub("hebcal-bridge.js", "module.exports = globalThis.__hebcal;\n")],
  ["server-only", stub("server-only.js", "module.exports = {};\n")],
  ["next/cache", stub("next-cache.js", "module.exports = { revalidatePath() {}, revalidateTag() {} };\n")],
  ["next/headers", stub("next-headers.js", "module.exports = { headers: async () => new Map(), cookies: async () => ({ get() { return undefined; }, getAll() { return []; } }) };\n")],
  ["@/lib/db", dbStub],
  ["@/lib/auth/actor", actorStub],
  ["@/lib/pricing/reservation-pricing", pricingStub],
]);
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  const s = byRequest.get(request);
  if (s) return s;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

const db = req(dbStub);
const compiledPath = join(out, "app/(dashboard)/reservations/actions.js");
const actions = req(compiledPath);

const fixture = (over = {}) => ({
  guest: { firstName: "אנה", lastName: "כהן", phone: "0500000000" },
  sourceId: null,
  status: "confirmed",
  rooms: [{ roomId: ROOM, checkIn: "2026-10-01", checkOut: "2026-10-03", adults: 2, children: 0, infants: 0 }],
  discountMode: "none",
  taxExempt: false,
  currency: "ILS",
  ...over,
});

/** run the real action over the double; return what it wrote */
async function create(mod, over) {
  db.reset();
  const res = await mod.createReservationAction(fixture(over));
  const of = (re) => db.calls.filter((c) => re.test(c.text));
  return {
    res,
    payments: of(/INSERT INTO guesthub\.payments/),
    reservations: of(/INSERT INTO guesthub\.reservations\b/),
    recomputes: of(/RETURNING x\.paid/),
  };
}

// ============================================================
// 2. The claims, RUN
// ============================================================
{
  const r = await create(actions, {});
  assert.equal(r.res.success, true, `the fixture create must succeed — ${r.res.success ? "" : r.res.error}`);
  assert.equal(r.reservations.length, 1, "exactly one reservation row is written");
  assert.equal(r.payments.length, 0,
    "NO payment row when the operator recorded nothing — the D87 §2 default wrote one for the whole total on every create (#1159)");
  assert.equal(r.recomputes.length, 1,
    "paid/balance still reconcile through the ledger (D51): 0 paid, balance = total — never a cached guess");
  ok("create with no paid input → 0 payment rows (the real action, run)");
}
{
  const r = await create(actions, { paidAmount: 500, paymentMethod: "cash" });
  assert.equal(r.res.success, true, `the paid create must succeed — ${r.res.success ? "" : r.res.error}`);
  assert.equal(r.payments.length, 1, "exactly one payment row for an explicit amount");
  assert.equal(Number(r.payments[0]?.values[2]), 500, "…of exactly the amount the operator keyed (500), never the total");
  assert.equal(r.payments[0]?.values[3], "cash", "…carrying the method the operator chose");
  assert.equal(r.recomputes.length, 1, "…and the ledger recompute follows the insert");
  ok("create with paid=500 → 1 payment row of 500 (run)");
}
{
  const r = await create(actions, { paidAmount: 0 });
  assert.equal(r.res.success, true, "an explicit 0 is a valid create");
  assert.equal(r.payments.length, 0, "an explicit 0 is not a payment either — no row");
  ok("explicit paid=0 → 0 payment rows");
}

// ============================================================
// 3. The wizard, static: "שולם" is the operator's only
// ============================================================
const booking = stripComments(read(BOOKING));
/** every `useEffect(...)` call in the source, by balanced parentheses */
const effectsOf = (src) => {
  const bodies = [];
  let i = 0;
  while ((i = src.indexOf("useEffect(", i)) >= 0) {
    let depth = 0;
    let j = i + "useEffect".length;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    bodies.push(src.slice(i, j + 1));
    i = j;
  }
  return bodies;
};
/** throws when any effect writes paid to anything but the open-reset 0 */
const assertNoAutoPaid = (src) => {
  const effects = effectsOf(src);
  strict.ok(effects.length > 0, "the wizard has effects (the scanner found none — regex drift)");
  const writers = effects.filter((b) => /setPaid\((?!0\))/.test(b));
  strict.equal(writers.length, 0,
    `an effect writes "שולם" by itself — the D87 §2 default is back:\n${writers.map((w) => w.slice(0, 160)).join("\n")}`);
};
{
  assert.equal(failureOf(() => assertNoAutoPaid(booking)), null,
    "no useEffect in the wizard writes paid from anything but the open-reset 0 — the field moves only on the operator's typing or a payment chip");
  assert.match(booking, /const initialMethod = "";/, "the payment method starts unselected (no cash preselect)");
  assert.match(booking, /paid > 0 && !method/, "…and is required only once an amount is recorded — no amount, no demand");
  assert.match(booking, /paidAmount: paid \|\| undefined/,
    "the payload sends no paidAmount for 0 — the server's `?? 0` then writes no row (the run above)");
  assert.match(booking, /setPaid\(0\)/, "the open-reset still starts every wizard at 0");
  ok("the wizard: שולם starts at 0 and is the operator's only; method unselected, required only with an amount");
}

// ============================================================
// 4. The server condition and the room-removal warning, static
// ============================================================
const actionsSrc = stripComments(read(ACTIONS));
const edit = stripComments(read(EDIT));
{
  assert.match(actionsSrc, /const paid = input\.paidAmount \?\? 0;[\s\S]*?if \(paid > 0\) \{\s*await tx`\s*INSERT INTO guesthub\.payments/,
    "create: the payments INSERT sits under `if (paid > 0)` — verified, not assumed");
  assert.match(actionsSrc, /paidExceedsTotal:\s*ledger\.paid > ledger\.total/,
    "update: the ledger recompute decides whether the recorded payments exceed the new total, and the action returns it");
  assert.match(edit, /paidAfter > total && \(/, "edit panel: a live warning while the recorded payments exceed the (new) total");
  assert.match(edit, /התשלום הרשום \(₪/, "…in the owner's wording: התשלום הרשום (₪X) עולה על הסה״כ החדש (₪Y)");
  assert.match(edit, /res\.data\?\.paidExceedsTotal/, "…and the server's own numbers after save (toast)");
  assert.doesNotMatch(edit, /paidExceedsTotal[\s\S]{0,300}return;/, "…a warning, never a block: nothing returns early on it");
  ok("room removal: paid > total is said (panel + toast), never blocked");
}

// ============================================================
// 5. B2 — both claims must FAIL on a mutant
// ============================================================
{
  // (a) the wizard: put the D87 §2 sync back
  const SYNC = `
  useEffect(() => {
    if (paidTouched.current) return;
    const t = total;
    setPaid((prev) => (prev === t ? prev : t));
  }, [total]);
`;
  const anchor = "const total = totals.grandTotal;";
  strict.ok(booking.includes(anchor), "mutant anchor present in the wizard");
  const wizardMutant = booking.replace(anchor, `${anchor}${SYNC}`);
  const caught = failureOf(() => assertNoAutoPaid(wizardMutant));
  assert.ok(caught !== null, "B2 (wizard): re-enabling the paid=total sync MUST fail the static claim");

  // (b) the server: write a row for paid=0 too
  const compiled = readFileSync(compiledPath, "utf8");
  assert.equal(compiled.split("if (paid > 0)").length - 1, 1, "the compiled create carries exactly one `if (paid > 0)` guard");
  const mutantPath = join(out, "app/(dashboard)/reservations/actions.mutant.js");
  writeFileSync(mutantPath, compiled.replace("if (paid > 0)", "if (paid >= 0)"));
  const r = await create(req(mutantPath), {});
  assert.equal(r.payments.length, 1,
    "B2 (server): the mutant writes a payment row for a create with no paid input — exactly what claim 2 would fail on");
  ok("B2: both mutants are caught — the wizard sync and the server guard");
}

console.log(`\nAll ${n} paid-default claim groups hold.`);
