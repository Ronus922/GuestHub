#!/usr/bin/env node
// ============================================================
// check:availability-ari-coverage — a write that changes WHAT A CHANNEL MAY
// SELL must claim its outbound work in the SAME transaction that makes it true.
//
// THE DEFECT THIS EXISTS FOR, measured on main 2026-08-22 (audit of /rooms):
// the board-status popover (פנוי / מלוכלך / בניקיון / חסום / תחזוקה) wrote
// guesthub.rooms.status directly — 'out_of_order' for חסום, 'inactive' for
// תחזוקה — and never touched the ARI outbox. rooms.status is not decoration:
// sellable_unit_inventory() counts a unit's sellable rooms with exactly
// `status = 'available' AND is_active` (migration 040), and projectBeds24Ari
// publishes that count. So blocking a room from the board removed it from
// inventory LOCALLY while Beds24 kept selling it, and re-opening a room left
// the channel publishing it as unavailable. Nothing caught it: the closure
// path had check:maintenance-closures, the rate path had check:ari-horizon,
// and the room-status path had nothing at all.
//
// THE RULE, stated once for every path present and future: if a transaction
// makes a room more or less sellable, that same transaction marks the outbox.
// Not the caller, not a later job, not the next reconcile — the same tx, so the
// claim commits or dies with the fact it describes.
//
// WHY AN AST AND NOT A GREP. The three things this must catch are invisible to
// a text search: a mark parked behind a dead branch, a mark handed an empty
// room list, and a mark that moved outside the transaction it belongs to. All
// three keep the string "markAriDirty" in the file. So the source is parsed
// with the TypeScript compiler, transactions are located as scopes, and every
// mark is checked for the tx it was handed, the rooms it names and whether it
// can be reached at all.
//
// Static only: parses src/, runs no DB, no network, no build.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-availability-ari-coverage.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const ts = createRequire(join(ROOT, "package.json"))("typescript");

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ============================================================
// THE ALLOWLIST — five named paths, each with its reason, written out one by
// one. There is no categorical rule anywhere in this file: "closures" are not
// exempt, "housekeeping" is not exempt, "areas" are not exempt. Each entry
// below either EXEMPTS one named function (exempt: true) or records why a path
// people expect to see here needs no exemption at all (exempt: false) — and
// every exempt:false entry is turned into a positive assertion further down,
// so a wrong reason fails the guard instead of sitting here as a comment.
// ============================================================
const ALLOWLIST = [
  {
    exempt: true,
    file: "src/app/(dashboard)/rooms/actions.ts",
    fn: "duplicateRoomAction",
    reason:
      "the copy is INSERTed with is_active = false, so it is born outside " +
      "sellable_unit_inventory()'s `status='available' AND is_active` filter — " +
      "it adds no inventory to publish, and it has no channel mapping either",
  },
  {
    exempt: true,
    file: "src/app/(dashboard)/rooms/actions.ts",
    fn: "deleteRoomAction",
    reason:
      "the DELETE is refused up front when the room carries any reservation, " +
      "closure, rate or bulk-update history, so a deletable room is one that " +
      "never sold and never will; a room with history is disabled, not deleted, " +
      "and that path goes through the wizard, which marks",
  },
  {
    exempt: false,
    file: "src/app/(dashboard)/calendar/actions.ts",
    fns: ["createClosureAction", "updateClosureAction", "deleteClosureAction"],
    reason:
      "a closure whose kind is not 'ooo' does not remove a room from inventory " +
      "(040: the closed-rooms leg of sellable_unit_inventory filters kind='ooo'), " +
      "so those three actions mark CONDITIONALLY. That needs no exemption: this " +
      "guard requires a REACHABLE mark, and a mark behind a runtime condition is " +
      "reachable. Only a mark behind a constant-false condition is not.",
  },
  {
    exempt: false,
    file: "src/lib/reservations/lifecycle.ts",
    table: "guesthub.housekeeping_tasks",
    reason:
      "the checkout block files a cleaning task and must NOT mark the outbox — " +
      "a dirty room is still a sellable room (check-housekeeping.mjs:34 asserts " +
      "exactly that). It needs no exemption because housekeeping_tasks is not an " +
      "availability write in the first place: this guard never asks it to mark, " +
      "so the two guards cannot collide.",
  },
  {
    exempt: false,
    file: "src/app/(dashboard)/rooms/actions.ts",
    table: "guesthub.operational_areas",
    reason:
      "an operational area is not a room. sellable_unit_inventory() joins " +
      "sellable_unit_rooms → rooms and never reads operational_areas, so an " +
      "area's status changes nothing a channel can sell. Needs no exemption for " +
      "the same reason as housekeeping: it is not an availability write.",
  },
];
const EXEMPT = ALLOWLIST.filter((a) => a.exempt);

// ============================================================
// 1. What counts as an availability write
// ============================================================

/** the literal halves of a tagged template, with every ${…} hole blanked */
function templateText(tpl) {
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) return tpl.text;
  let s = tpl.head.text;
  for (const span of tpl.templateSpans) s += " ? " + span.literal.text;
  return s;
}

/**
 * THE DEFINITION, one clause per bullet of the rule:
 *   · UPDATE/INSERT/DELETE on guesthub.rooms touching status or is_active
 *   · INSERT/UPDATE/DELETE on guesthub.room_closures
 *   · a write to stop_sell in guesthub.pricing_plan_rates
 * Returns a short label, or null when the statement moves no inventory.
 */
function classifyWrite(sqlText) {
  const low = sqlText.replace(/\s+/g, " ").toLowerCase();

  // ---- guesthub.rooms ----
  const upd = low.search(/\bupdate\s+guesthub\.rooms\b/);
  if (upd >= 0) {
    const setAt = low.indexOf(" set ", upd);
    if (setAt >= 0) {
      const tail = low.slice(setAt + 5);
      const whereAt = tail.lastIndexOf(" where ");
      const setClause = whereAt >= 0 ? tail.slice(0, whereAt) : tail;
      // a column ASSIGNED, not a column merely mentioned in a WHERE
      if (/\b(status|is_active)\s*=/.test(setClause)) return "UPDATE rooms (status/is_active)";
    }
  }
  if (/\binsert\s+into\s+guesthub\.rooms\b/.test(low)) {
    const cols = /\binsert\s+into\s+guesthub\.rooms\s*\(([^)]*)\)/.exec(low);
    // no explicit column list = every column, status included
    if (!cols || /\b(status|is_active)\b/.test(cols[1])) return "INSERT rooms (status/is_active)";
  }
  if (/\bdelete\s+from\s+guesthub\.rooms\b/.test(low)) return "DELETE rooms";

  // ---- guesthub.room_closures — every write, kind decided at runtime ----
  if (/\b(insert\s+into|update|delete\s+from)\s+guesthub\.room_closures\b/.test(low))
    return "WRITE room_closures";

  // ---- stop_sell in guesthub.pricing_plan_rates ----
  if (/\b(insert\s+into|update|delete\s+from)\s+guesthub\.pricing_plan_rates\b/.test(low)) {
    // fails closed: an interpolated column list is opaque and may carry stop_sell
    if (/\bstop_sell\b/.test(low) || /guesthub\.pricing_plan_rates\s+\?/.test(low))
      return "WRITE pricing_plan_rates.stop_sell";
  }
  return null;
}

// ============================================================
// 2. Transactions, as the parser sees them
// ============================================================

/** a literal that decides a branch at compile time; undefined = runtime value */
function staticTruth(e) {
  if (!e) return undefined;
  if (ts.isParenthesizedExpression(e)) return staticTruth(e.expression);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(e) && e.text === "undefined") return false;
  if (ts.isNumericLiteral(e)) return Number(e.text) !== 0;
  if (ts.isStringLiteral(e)) return e.text.length > 0;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = staticTruth(e.operand);
    return inner === undefined ? undefined : !inner;
  }
  return undefined;
}

const isFn = (nd) =>
  ts.isArrowFunction(nd) || ts.isFunctionExpression(nd) ||
  ts.isFunctionDeclaration(nd) || ts.isMethodDeclaration(nd);

/** the tx binding a function opens, or null when it opens no transaction */
function txBindingOf(nd) {
  if (!isFn(nd)) return null;
  const p0 = nd.parameters?.[0];

  // (a) the callback of `<sql|db|anything>.begin(...)`
  const call = nd.parent;
  if (
    call && ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "begin" &&
    call.arguments.includes(nd) && p0 && ts.isIdentifier(p0.name)
  ) return { name: p0.name.text, kind: "begin" };

  // (b) a function HANDED a transaction — the shape every helper in
  //     src/lib/** uses (lockRooms, writeRateCells, markAriDirty itself)
  if (p0 && ts.isIdentifier(p0.name)) {
    const typeText = p0.type ? p0.type.getText() : "";
    if (p0.name.text === "tx" || /\bTransactionSql\b/.test(typeText))
      return { name: p0.name.text, kind: "tx-param" };
  }
  return null;
}

/**
 * The nearest named FUNCTION a node lives in — how the allowlist addresses it.
 * A `const id = await sql.begin(...)` binds the transaction's RESULT, not the
 * path; naming the scope "id" would let one allowlist entry match every action
 * that happens to assign its transaction to the same variable.
 */
function enclosingName(nd) {
  for (let p = nd; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isMethodDeclaration(p) && p.name) return p.name.getText();
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer && isFn(p.initializer))
      return p.name.text;
    if (ts.isPropertyAssignment(p) && p.initializer && isFn(p.initializer)) return p.name.getText();
  }
  return "<top level>";
}

function collectFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const scopes = [];        // every transaction that writes availability
const orphanWrites = [];  // availability writes with no transaction at all
const allTemplates = [];  // every SQL template seen, for the exempt:false proofs

for (const abs of collectFiles(join(ROOT, "src")).sort()) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(
    rel, text, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (nd) => sf.getLineAndCharacterOfPosition(nd.getStart(sf)).line + 1;

  const visit = (nd, scope) => {
    const tx = txBindingOf(nd);
    let here = scope;
    if (tx) {
      here = {
        file: rel, fn: enclosingName(nd), txName: tx.name, kind: tx.kind,
        line: lineOf(nd), node: nd, writes: [], marks: [],
      };
      scopes.push(here);
    }

    // ---- a SQL statement ----
    if (ts.isTaggedTemplateExpression(nd)) {
      const sqlText = templateText(nd.template);
      allTemplates.push({ file: rel, line: lineOf(nd), sql: sqlText });
      const label = classifyWrite(sqlText);
      if (label) {
        const w = { file: rel, line: lineOf(nd), label };
        if (here) here.writes.push(w);
        else orphanWrites.push(w);
      }
    }

    // ---- a mark ----
    if (
      ts.isCallExpression(nd) && ts.isIdentifier(nd.expression) &&
      nd.expression.text === "markAriDirty"
    ) {
      const problems = [];
      const arg0 = nd.arguments[0];
      const arg1 = nd.arguments[1];

      if (!here) problems.push("called outside any transaction");
      else if (!(arg0 && ts.isIdentifier(arg0) && arg0.text === here.txName))
        problems.push(
          `first argument is ${arg0 ? arg0.getText() : "missing"}, not this transaction's ${here.txName}`,
        );

      if (arg1 && ts.isObjectLiteralExpression(arg1)) {
        const prop = (k) =>
          arg1.properties.find((p) => p.name && p.name.getText() === k);
        const rooms = prop("roomIds");
        if (
          rooms && ts.isPropertyAssignment(rooms) &&
          ts.isArrayLiteralExpression(rooms.initializer) &&
          rooms.initializer.elements.length === 0
        ) problems.push("roomIds is a literal empty array — markAriDirty returns without writing");
        const from = prop("dateFrom"), to = prop("dateTo");
        if (
          from && to && ts.isPropertyAssignment(from) && ts.isPropertyAssignment(to) &&
          from.initializer.getText() === to.initializer.getText()
        ) problems.push("dateFrom and dateTo are the same expression — an empty range writes nothing");
      }

      // reachable at all? a mark in a branch the compiler can already decide
      // is a mark that never runs.
      for (let p = nd, q = nd.parent; q && q !== (here && here.node); p = q, q = q.parent) {
        if (ts.isIfStatement(q)) {
          const truth = staticTruth(q.expression);
          if (truth === false && q.thenStatement === p) problems.push("inside `if (<always false>)`");
          if (truth === true && q.elseStatement === p) problems.push("inside the else of `if (<always true>)`");
        }
        if ((ts.isWhileStatement(q) || ts.isForStatement(q)) && staticTruth(q.expression) === false)
          problems.push("inside a loop that never runs");
      }

      const mark = { file: rel, line: lineOf(nd), problems };
      if (here) here.marks.push(mark);
    }

    ts.forEachChild(nd, (c) => visit(c, here));
  };
  visit(sf, null);
}

const writing = scopes.filter((s) => s.writes.length > 0);
assert.ok(
  writing.length >= 6,
  `expected the known availability-write transactions, found ${writing.length} — the parser is not seeing the tree`,
);
ok(`parsed src/ and found ${writing.length} transactions that write availability, out of ${scopes.length} transactions in total`);

// ============================================================
// 3. THE RULE
// ============================================================
const isExempt = (s) => EXEMPT.find((a) => a.file === s.file && a.fn === s.fn);

for (const s of writing) {
  const good = s.marks.filter((m) => m.problems.length === 0);
  const exemption = isExempt(s);
  const where = `${s.file}:${s.line} ${s.fn}()`;
  const what = s.writes.map((w) => `${w.label} @${w.line}`).join(", ");

  if (exemption) {
    assert.equal(
      good.length, 0,
      `${where} is on the allowlist but now marks the outbox — the exemption is stale, remove it from ALLOWLIST`,
    );
    ok(`${where} — ${what} — exempt: ${exemption.reason.slice(0, 60)}…`);
    continue;
  }

  const detail = s.marks.length === 0
    ? "no markAriDirty call in this transaction at all"
    : s.marks.map((m) => `line ${m.line}: ${m.problems.join("; ")}`).join(" | ");
  assert.ok(
    good.length > 0,
    `${where} writes availability (${what}) without a usable markAriDirty on ${s.txName} — ${detail}`,
  );
  if (good.length > 0) ok(`${where} — ${what} — marked at line ${good.map((m) => m.line).join(", ")} on ${s.txName}`);
}

for (const w of orphanWrites)
  assert.fail(
    `${w.file}:${w.line} — ${w.label} outside any transaction: nothing can mark the outbox atomically with it`,
  );
if (orphanWrites.length === 0) ok("no availability write happens outside a transaction");

// ============================================================
// 4. The allowlist itself stays honest
// ============================================================
for (const a of EXEMPT)
  assert.ok(
    writing.some((s) => s.file === a.file && s.fn === a.fn),
    `ALLOWLIST names ${a.file} ${a.fn}() but no such transaction writes availability any more — the entry is stale`,
  );
ok(`all ${EXEMPT.length} exemptions still name a real availability-write transaction`);

// the exempt:false entries, proved rather than asserted in prose
for (const a of ALLOWLIST.filter((x) => !x.exempt && x.table)) {
  const touching = allTemplates.filter((t) => t.sql.includes(a.table));
  assert.ok(touching.length > 0, `expected writes to ${a.table} in the tree, found none`);
  const misread = touching.filter((t) => classifyWrite(t.sql) !== null);
  assert.equal(
    misread.length, 0,
    `${a.table} is being read as an availability write (${misread.map((t) => `${t.file}:${t.line}`).join(", ")}) — ` +
      `this guard would demand a mark there and collide with the reason on record`,
  );
  ok(`${a.table} is not an availability write (${touching.length} statements) — ${a.reason.slice(0, 60)}…`);
}

// the closure trio: conditional marks are reachable marks
for (const fn of ALLOWLIST.find((a) => a.fns).fns) {
  const s = writing.find((x) => x.fn === fn);
  assert.ok(s, `${fn}() no longer writes room_closures — the closure reference path moved`);
  if (s) assert.ok(
    s.marks.some((m) => m.problems.length === 0),
    `${fn}() writes room_closures without a reachable mark`,
  );
}
ok("the three closure actions each carry a reachable mark, conditional on kind='ooo' as intended");

// ============================================================
// 5. The path this guard was written for
// ============================================================
{
  const popover = writing.find(
    (s) => s.file === "src/app/(dashboard)/rooms/actions.ts" && s.fn === "updateRoomBoardStatusAction",
  );
  assert.ok(popover, "updateRoomBoardStatusAction no longer writes rooms.status — has the board popover moved?");
  if (popover) {
    assert.ok(
      popover.marks.some((m) => m.problems.length === 0),
      "the /rooms board-status popover writes rooms.status without marking the ARI outbox — the exact defect this guard exists for",
    );
    ok("the /rooms board-status popover marks the outbox in its own transaction");
  }
}

console.log(`\nAll ${n} availability-ARI-coverage claims hold.`);
