// Runnable checks for the pure Phase-3 calendar/channel logic (same pattern
// as check-guards.mjs): compiles the pure modules with tsc, imports them and
// asserts the business rules. Usage: node scripts/check-calendar.mjs
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "calendar-"));
// commonjs so compiled inter-module imports resolve without extensions under plain node
execSync(
  `pnpm exec tsc src/lib/dates.ts src/lib/inventory-rules.ts src/lib/rooms/sort.ts src/lib/channel/ranges.ts src/lib/channel/payloads.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const dates = require(join(out, "dates.js"));
const rules = require(join(out, "inventory-rules.js"));
const ranges = require(join(out, "channel/ranges.js"));
const payloads = require(join(out, "channel/payloads.js"));

// ---- hotel-night date semantics (§E) ----
assert.equal(dates.nightsBetween("2026-07-04", "2026-07-05"), 1, "July 4→5 is exactly one night");
assert.equal(dates.nightsBetween("2026-07-01", "2026-07-08"), 7);
assert.equal(dates.addDays("2026-07-31", 1), "2026-08-01", "month rollover");
assert.equal(dates.addDays("2026-01-01", -1), "2025-12-31", "year rollover");
assert.equal(dates.addDays("2026-03-27", 1), "2026-03-28", "IL DST switch does not drift");
assert.deepEqual(dates.eachDay("2026-07-04", "2026-07-06"), ["2026-07-04", "2026-07-05"], "checkout day excluded");

// overlap: half-open [start, end)
assert.equal(dates.rangesOverlap("2026-07-04", "2026-07-06", "2026-07-05", "2026-07-08"), true);
assert.equal(
  dates.rangesOverlap("2026-07-04", "2026-07-06", "2026-07-06", "2026-07-08"),
  false,
  "checkout + same-day check-in must coexist",
);
assert.equal(dates.rangesOverlap("2026-07-06", "2026-07-08", "2026-07-04", "2026-07-06"), false);
assert.equal(dates.rangesOverlap("2026-07-01", "2026-07-31", "2026-07-10", "2026-07-11"), true, "containment");
assert.equal(dates.rangesOverlap("2026-07-04", "2026-07-05", "2026-07-04", "2026-07-05"), true, "one-night self");
assert.equal(dates.isDateOnly("2026-02-30"), false, "impossible date rejected");
assert.equal(dates.isDateOnly("2026-07-04"), true);

// ---- capacity (§L) ----
const CAP = { max_occupancy: 4, max_adults: 2, max_children: 2, max_infants: 0 };
assert.equal(rules.capacityViolation(CAP, { adults: 2, children: 2, infants: 0 }), null);
assert.ok(rules.capacityViolation(CAP, { adults: 3, children: 0, infants: 0 }), "over max_adults");
assert.ok(rules.capacityViolation(CAP, { adults: 2, children: 3, infants: 0 }), "over max_children");
assert.ok(
  rules.capacityViolation(CAP, { adults: 1, children: 0, infants: 1 }),
  "infants not silently accepted when capacity is 0",
);
assert.ok(rules.capacityViolation(CAP, { adults: 0, children: 1, infants: 0 }), "at least one adult");
assert.equal(
  rules.capacityViolation({ ...CAP, max_infants: 1 }, { adults: 1, children: 0, infants: 1 }),
  null,
  "infant allowed when capacity exists",
);

// ---- blocking statuses (§8) ----
assert.deepEqual([...rules.INVENTORY_BLOCKING_STATUSES], ["confirmed", "checked_in", "blocked"]);
assert.ok(!rules.INVENTORY_BLOCKING_STATUSES.includes("cancelled"), "cancelled never consumes inventory");
assert.ok(!rules.CALENDAR_VISIBLE_STATUSES.includes("cancelled"), "cancelled never renders");

// ---- payment state (§F) + canonical balance (D52 §6/§7) ----
assert.equal(rules.paymentState(1000, 0), "unpaid");
assert.equal(rules.paymentState(1000, 500), "partial");
assert.equal(rules.paymentState(1000, 1000), "paid");
assert.equal(rules.paymentState(1000, 1200), "overpaid", "paid over total → overpaid, not silently 'paid'");
assert.equal(rules.paymentState(0, 0), "unpaid", "a zero-total unpaid stay is unpaid");

// balanceOf is NOT floored — a credit is negative, shown as a credit (never a
// zero balance). ONE definition shared by tooltip / panel / payment section.
assert.equal(rules.balanceOf(1000, 400), 600, "positive balance = amount still due");
assert.equal(rules.balanceOf(1000, 1000), 0, "settled");
assert.equal(rules.balanceOf(1000, 1200), -200, "overpayment is a NEGATIVE balance (credit), not floored to 0");
assert.deepEqual(rules.formatBalance(1000, 400), { kind: "due", amount: 600, label: "יתרה לתשלום" });
assert.deepEqual(rules.formatBalance(1000, 1000), { kind: "settled", amount: 0, label: "שולם במלואו" });
assert.deepEqual(rules.formatBalance(1000, 1200), { kind: "credit", amount: 200, label: "זיכוי ללקוח" },
  "an overpayment is a ₪200 customer credit — absolute amount + credit label");

// ---- canonical pricing + restriction rules moved to check-effective-state.mjs ----
// Phase 4A: the room/type resolveRate is retired; the single validator/pricer is
// src/lib/rates/rules.ts (planNightlyPrice + stayRestrictionViolation), asserted
// pure + against the DB by scripts/check-effective-state.mjs.

// ---- dirty-range coalescing (§S) ----
{
  const existing = [
    { id: "a", date_from: "2026-07-01", date_to: "2026-07-05" },
    { id: "b", date_from: "2026-07-10", date_to: "2026-07-12" },
  ];
  const r1 = ranges.coalesceRange(existing, { date_from: "2026-07-05", date_to: "2026-07-10" });
  assert.deepEqual(r1.merged, { date_from: "2026-07-01", date_to: "2026-07-12" }, "adjacency bridges both ranges");
  assert.equal(r1.absorbedIds.length, 2);
  const r2 = ranges.coalesceRange(existing, { date_from: "2026-07-20", date_to: "2026-07-21" });
  assert.equal(r2.absorbedIds.length, 0, "distant range untouched");
  const r3 = ranges.coalesceRange([existing[0]], { date_from: "2026-07-02", date_to: "2026-07-03" });
  assert.deepEqual(r3.merged, { date_from: "2026-07-01", date_to: "2026-07-05" }, "contained range absorbed — no duplicate work");
}

// ---- retry/backoff (§U) ----
assert.ok(ranges.backoffMs(1, () => 0.5) < ranges.backoffMs(5, () => 0.5), "backoff grows");
assert.ok(ranges.backoffMs(30, () => 1) <= 60 * 60 * 1000, "backoff capped at 1h");
assert.equal(ranges.isPermanentError("validation_error"), true);
assert.equal(ranges.isPermanentError("rate_limited"), false, "rate limits retry");

// (The outbound ARI payload builders are provider-specific — the Beds24
//  calendar-request builders + batching are exercised by the Beds24 ARI
//  guards, not by this pure calendar/date guard.)

// ---- redaction (§Z) ----
{
  const red = payloads.redactPayload({
    guest: { name: "א", card_number: "4111111111111111" },
    payment: { cvc: "123", guarantee: { pan: "x" } },
    rooms: [{ price: 100 }],
  });
  assert.equal(red.guest.card_number, "[redacted]");
  assert.equal(red.payment.cvc, "[redacted]");
  assert.equal(red.payment.guarantee, "[redacted]");
  assert.equal(red.rooms[0].price, 100, "non-sensitive data intact");
}

// ---- outbound ARI cannot originate from a SAVE PATH (§M/§W, D68) ----
// The old ChannelManagerProvider factory (disabled/dry-run) enforced this by
// construction. It is gone; the guarantee is asserted here: nothing a canonical
// save reaches may touch the network, and the outbox itself performs no HTTP
// call. Only the PM2 worker talks to the channel provider.
//
// SCOPE (rescoped): the architectural rule is PATH-scoped, not FILE-scoped. Its
// earlier implementation matched import SPECIFIER TEXT anywhere in the file,
// which had two defects:
//   • false RED — D93 put the SUPERVISED RELEASE escape hatch
//     (releaseChannelReservationAction) in reservations/actions.ts. That is an
//     operator-triggered, permission-gated admin action that reads Beds24 live
//     and then enqueues the worker's pull job; it saves nothing. File-scoping
//     could not tell it apart from a save, so main shipped RED.
//   • false GREEN — re-exporting beds24Request from an innocently named module
//     defeated the specifier regex while the save still reached the socket.
// The assertions below therefore (a) work on the resolved MODULE GRAPH and on
// the real network primitives at its leaves, not on module names, and (b) split
// each save-path file into top-level REGIONS so an allow-listed escape hatch is
// judged by what it does, not by which file it sits in.
//
// Every assertion in this block is a CONTRACT assertion: it fails on an
// architectural contract breach, not on a behaviour breach.
{
  const ts = require("typescript");

  const SAVE_PATHS = [
    "src/lib/channel/outbox.ts",
    "src/lib/channel/ranges.ts",
    "src/lib/rates/service.ts",
    "src/app/(dashboard)/rates/actions.ts",
    "src/app/(dashboard)/calendar/actions.ts",
    "src/app/(dashboard)/reservations/actions.ts",
    "src/app/(dashboard)/rate-plans/actions.ts",
  ];

  // Operator escape hatches: top-level functions that live in a save-path file
  // but are NOT a save. Each entry buys nothing for free — the hatch contract
  // below is asserted for every one of them, and an entry that stops touching
  // the channel is a failure too, so the allow-list cannot quietly widen.
  const ESCAPE_HATCHES = new Map([
    ["src/app/(dashboard)/reservations/actions.ts", ["releaseChannelReservationAction"]],
  ]);

  const parseFile = (f) =>
    ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true,
      f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  // "@/x" → src/x, "./x" → sibling; a bare specifier is an external package and
  // is out of this rule's scope (the rule is about OUR layering).
  const resolveSpec = (spec, fromFile) => {
    let base;
    if (spec.startsWith("@/")) base = join("src", spec.slice(2));
    else if (spec.startsWith(".")) base = normalize(join(dirname(fromFile), spec));
    else return null;
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (existsSync(c)) return c;
    }
    return null;
  };

  // every module specifier this file depends on, re-exports included (a
  // re-export drags the target in exactly like an import) plus dynamic import()
  const moduleEdges = (sf) => {
    const out = [];
    const walk = (n) => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
          n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword &&
          n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
    return out;
  };

  // The LEAF predicate: does this module reach the network for real? Not
  // "is it called *-http" — the actual primitives, in VALUE position. This is
  // what makes an alias/re-export chain pointless: channel-http.ts and
  // beds24-http.ts are caught by `opts.fetchImpl ?? fetch`, which no `fetch(`
  // regex ever saw.
  const NET_GLOBALS = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]);
  const NET_PKGS = /^(axios|undici|got|node-fetch|superagent|node:https?|https?)$/;
  const networkIO = (file) => {
    const sf = parseFile(file);
    const reasons = [];
    for (const spec of moduleEdges(sf)) if (NET_PKGS.test(spec)) reasons.push(`imports "${spec}"`);
    const inTypePosition = (n) => {
      for (let a = n.parent; a; a = a.parent) if (ts.isTypeQueryNode(a) || ts.isTypeNode(a)) return true;
      return false;
    };
    const walk = (n) => {
      if (ts.isIdentifier(n) && NET_GLOBALS.has(n.text)) {
        const p = n.parent;
        const isName = p && ((ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n) ||
          (ts.isBindingElement(p) && p.propertyName === n) || ts.isImportSpecifier(p) ||
          (ts.isParameter(p) && p.name === n) || (ts.isVariableDeclaration(p) && p.name === n));
        if (!isName && !inTypePosition(n)) {
          reasons.push(`uses the global ${n.text} at line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
        }
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) &&
          /^https?$/.test(n.expression.text) && /^(request|get)$/.test(n.name.text)) {
        reasons.push(`calls ${n.expression.text}.${n.name.text}`);
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
    return reasons;
  };

  // top-level declarations, so a reference can be attributed to the function it
  // sits in instead of to the whole file
  const topLevelRegions = (sf) => {
    const regions = [];
    for (const st of sf.statements) {
      let name = null;
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) name = st.name.text;
      else if (ts.isVariableStatement(st)) {
        const d = st.declarationList.declarations[0];
        if (d && ts.isIdentifier(d.name)) name = d.name.text;
      }
      if (name) regions.push({ name, start: st.getStart(sf), end: st.getEnd() });
    }
    return regions;
  };

  for (const f of SAVE_PATHS) {
    const sf = parseFile(f);
    const hatches = ESCAPE_HATCHES.get(f) ?? [];
    const regions = topLevelRegions(sf);
    const regionAt = (pos) => regions.find((r) => pos >= r.start && pos < r.end)?.name ?? "<module scope>";

    // 1. the save-path file never reaches the network with its own hands —
    //    file-wide, hatch or no hatch. The hatch goes through the typed client.
    const own = networkIO(f);
    assert.equal(own.length, 0,
      `CONTRACT BREACH (§M/§W): ${f} contains network code of its own (${own[0]}) — a save path may not hold a socket`);

    // 2. attribute every VALUE import to the region(s) that use it
    const bindingSpec = new Map();
    const sideEffectOrUnused = new Set();
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        sideEffectOrUnused.add(st.moduleSpecifier.text); // a re-export widens the file's surface
      }
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      if (!st.importClause) { sideEffectOrUnused.add(spec); continue; } // import "x" — runs at load
      if (st.importClause.isTypeOnly) continue; // erased, never in the bundle
      if (st.importClause.name) bindingSpec.set(st.importClause.name.text, spec);
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindingSpec.set(nb.name.text, spec);
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) if (!e.isTypeOnly) bindingSpec.set(e.name.text, spec);
      }
    }
    const specRegions = new Map();
    const hatchRefs = new Map();
    const walkRefs = (n) => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const isName = p && ((ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n));
        if (!isName) {
          const where = regionAt(n.getStart(sf));
          if (bindingSpec.has(n.text)) {
            const spec = bindingSpec.get(n.text);
            if (!specRegions.has(spec)) specRegions.set(spec, new Set());
            specRegions.get(spec).add(where);
          }
          if (hatches.includes(n.text) && where !== n.text) {
            if (!hatchRefs.has(n.text)) hatchRefs.set(n.text, new Set());
            hatchRefs.get(n.text).add(where);
          }
        }
      }
      ts.forEachChild(n, walkRefs);
    };
    ts.forEachChild(sf, walkRefs);
    // an imported-but-unreferenced value import still ships in the bundle
    for (const spec of new Set(bindingSpec.values())) if (!specRegions.has(spec)) sideEffectOrUnused.add(spec);

    // 3. the SAVE side of the graph: every specifier reached from anything that
    //    is not an allow-listed hatch. Walk it transitively to the leaves.
    const saveSpecs = new Set(sideEffectOrUnused);
    for (const [spec, where] of specRegions) {
      if ([...where].some((r) => !hatches.includes(r))) saveSpecs.add(spec);
    }
    const seen = new Set([f]);
    const stack = [...saveSpecs].map((s) => ({ spec: s, chain: [f] }));
    while (stack.length) {
      const { spec, chain } = stack.pop();
      const target = resolveSpec(spec, chain[chain.length - 1]);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const reasons = networkIO(target);
      assert.equal(reasons.length, 0,
        `CONTRACT BREACH (§M/§W): a canonical save reaches the network — ${[...chain, target].join(" → ")} (${reasons[0]}). ` +
        `Outbound traffic belongs to the PM2 channel worker, never to a save.`);
      for (const next of moduleEdges(parseFile(target))) stack.push({ spec: next, chain: [...chain, target] });
    }

    // 4. the escape-hatch contract — what earns a region its place on the
    //    allow-list. A hatch may READ the channel; it may not WRITE the stay.
    for (const name of hatches) {
      const region = regions.find((r) => r.name === name);
      assert.ok(region,
        `CONTRACT BREACH (§M/§W): ${f} allow-lists escape hatch "${name}" but declares no such top-level function — the allow-list has rotted`);
      const usesChannel = [...specRegions].some(([, where]) => where.has(name));
      assert.ok(usesChannel,
        `CONTRACT BREACH (§M/§W): escape hatch ${f}#${name} no longer touches the channel layer — drop it from the allow-list instead of leaving a standing exemption`);
      const body = sf.text.slice(region.start, region.end);
      assert.match(body, /requirePermission\(/,
        `CONTRACT BREACH (§M/§W): escape hatch ${f}#${name} must be permission-gated — an operator action, not an open door`);
      assert.match(body, /writeAudit\(/,
        `CONTRACT BREACH (§M/§W): escape hatch ${f}#${name} must audit WHO triggered it and WHAT the source reported`);
      assert.match(body, /enqueueChannelJob\(/,
        `CONTRACT BREACH (§M/§W): escape hatch ${f}#${name} must delegate to the canonical worker job — it may not apply the outcome itself`);
      assert.doesNotMatch(body, /\b(UPDATE|INSERT INTO|DELETE FROM)\s+guesthub\.reservations/i,
        `CONTRACT BREACH (§M/§W): escape hatch ${f}#${name} writes the reservation directly — that makes it a save path, and a save path may not touch the channel`);
      assert.doesNotMatch(body, /\b(markAriDirty|applyCancellation|recomputePaymentAggregates)\(/,
        `CONTRACT BREACH (§M/§W): escape hatch ${f}#${name} applies stay/inventory side effects itself — it must only enqueue the worker`);
      const callers = [...(hatchRefs.get(name) ?? [])].filter((r) => !hatches.includes(r) && r !== "<module scope>");
      assert.equal(callers.length, 0,
        `CONTRACT BREACH (§M/§W): escape hatch ${f}#${name} is called from ${callers[0]} — a save must not reach the channel through the hatch`);
    }
  }
}

// the pure modules contain no network code at all — structural guarantee
for (const f of ["src/lib/channel/payloads.ts", "src/lib/channel/ranges.ts"]) {
  const src = readFileSync(f, "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest|axios|http\.request|https\.request/.test(src), `${f} contains no network code`);
  assert.ok(!/^import /m.test(src), `${f} stays import-free (standalone-compilable)`);
}

// ---- canonical room ordering (D86) ----
// The calendar orders rooms by ONE comparator; room_number is a text column, so
// both Postgres and JS would otherwise sort "1006" before "926".
{
  const { compareRoomNumber, sortRoomsByNumber } = require(join(out, "rooms/sort.js"));

  assert.equal(compareRoomNumber("100", "926") < 0, true, "100 before 926");
  assert.equal(compareRoomNumber("926", "1006") < 0, true, "926 before 1006 (never string order)");
  assert.equal(compareRoomNumber("1006", "926") > 0, true, "comparator is antisymmetric");
  assert.equal(compareRoomNumber("100", "100"), 0, "equal numbers tie");

  // the live room set, deliberately fed in the scrambled order the old
  // area-grouped SQL produced (צפוני block, then דרומי block, then no-area)
  const scrambled = ["1102", "1142", "1235", "1237", "1238", "1242", "1245", "1424", "1000", "1006", "1130", "1131", "1329", "926"];
  assert.deepEqual(
    sortRoomsByNumber(scrambled.map((room_number) => ({ room_number }))).map((r) => r.room_number),
    ["926", "1000", "1006", "1102", "1130", "1131", "1142", "1235", "1237", "1238", "1242", "1245", "1329", "1424"],
    "rooms ascend numerically regardless of area/insertion order",
  );

  // legacy non-numeric room numbers sort AFTER every numeric one (their relative
  // order is the locale's natural order — asserted as a set, not an ICU tie-break)
  const mixed = sortRoomsByNumber(
    ["A12", "1006", "פנטהאוז", "926", "12B"].map((room_number) => ({ room_number })),
  ).map((r) => r.room_number);
  assert.deepEqual(mixed.slice(0, 2), ["926", "1006"], "numeric rooms come first, ascending");
  assert.deepEqual(
    [...mixed.slice(2)].sort(),
    ["12B", "A12", "פנטהאוז"].sort(),
    "every non-numeric room number lands after the numeric ones",
  );

  // equal numeric values keep input order (stable) — ids stay attached to rows
  const dupes = [
    { room_number: "101", id: "first" },
    { room_number: "101", id: "second" },
  ];
  assert.deepEqual(sortRoomsByNumber(dupes).map((r) => r.id), ["first", "second"], "stable on ties");
}

// the calendar loader must not re-introduce an area-grouped/text ORDER BY
{
  const src = readFileSync("src/app/(dashboard)/calendar/data.ts", "utf8");
  assert.ok(
    /sortRoomsByNumber\(/.test(src),
    "calendar loader orders rooms through the canonical comparator",
  );
  assert.ok(
    !/ORDER BY a\.sort_order/.test(src),
    "calendar rooms are no longer grouped by area sort_order",
  );
}

console.log("check-calendar: all assertions passed");
