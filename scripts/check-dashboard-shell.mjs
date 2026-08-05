#!/usr/bin/env node
// ============================================================
// check:dashboard-shell — the two mechanisms Phase 1 exists to make safe.
//
// It compiles the REAL source (never a stale dist/) and exercises it, because
// both of these bugs are invisible to a grep:
//
//   A. THE WINDOW REGISTRY (DeshbordMain.md §8.1/§8.2). A window registered but
//      never placed falls to the bottom of its column and its drag breaks; a
//      stored layout from an older build hides a window that now exists, or
//      resurrects one that no longer does. The SAVED layout owns each window's
//      column (§3 cross-column drag); the registry owns only the default. Every
//      assertion below is on BEHAVIOUR — feed normalizeDashboardLayout a
//      hostile object and look at what comes out.
//
//   B. THE DONUT ARCS (InvitationSources.md §10). The offsets must be negative
//      and accumulating, the dash remainder must be the UNPAINTED part, and the
//      arithmetic must hold at 1, 2 and 8 slices — the three shapes the two
//      call sites will actually render.
//
// Usage: node scripts/check-dashboard-shell.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
let n = 0;
const ok = (m) => {
  n++;
  console.log(`  ✓ ${m}`);
};

const OUT = mkdtempSync(join(tmpdir(), "dash-shell-"));
const SRC = join(ROOT, "src");
writeFileSync(
  join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs",
      moduleResolution: "node10",
      target: "es2022",
      lib: ["es2023", "dom"],
      types: ["node"],
      typeRoots: [join(ROOT, "node_modules/@types")],
      esModuleInterop: true,
      skipLibCheck: true,
      strict: true,
      noEmitOnError: true,
      jsx: "react-jsx",
      baseUrl: SRC,
      paths: { "@/*": ["*"] },
      rootDir: SRC,
      outDir: join(OUT, "build"),
    },
    include: [
      join(SRC, "app/(dashboard)/dashboard/windows.ts"),
      join(SRC, "components/shared/donut-arcs.ts"),
    ],
  }),
);
execSync(`"${join(ROOT, "node_modules/.bin/tsc")}" -p "${join(OUT, "tsconfig.json")}"`, {
  stdio: "pipe",
  cwd: ROOT,
});
const BUILD = join(OUT, "build");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@/")) return origResolve.call(this, join(BUILD, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};
const require_ = createRequire(import.meta.url);

try {
  const W = require_(join(BUILD, "app/(dashboard)/dashboard/windows.js"));
  const { donutArcs } = require_(join(BUILD, "components/shared/donut-arcs.js"));

  // ================= A. the window registry =================
  const ids = W.WINDOWS.map((w) => w.id);
  assert.equal(ids.length, 11, "eleven windows are registered");
  assert.equal(new Set(ids).size, 11, "window ids are unique");
  ok(`11 windows registered, ids unique: ${ids.join(", ")}`);

  // §8.1 — every registered window has a place, in its own column
  const placed = [...W.DEFAULT_LAYOUT.l, ...W.DEFAULT_LAYOUT.r];
  assert.deepEqual(
    [...placed].sort(),
    [...ids].sort(),
    "DEFAULT_LAYOUT must contain EVERY registered id and nothing else — an unplaced window falls to the bottom and its drag breaks (§8.1)",
  );
  for (const col of W.COLUMNS)
    for (const id of W.DEFAULT_LAYOUT[col])
      assert.equal(W.defaultColumnOf(id), col, `${id} is placed in its DEFAULT column`);
  ok("DEFAULT_LAYOUT covers every window exactly once, each in its default column");

  assert.deepEqual(W.DEFAULT_LAYOUT.l, ["arr", "rev", "hk", "agd"], "left column default order");
  assert.deepEqual(
    W.DEFAULT_LAYOUT.r,
    ["alr", "iss", "tsk", "rvw", "msg", "src", "inh"],
    "right column default order",
  );
  ok("default order matches DeshbordMain.md §3");

  // §8.2 — a stored layout is reconciled, not trusted
  const empty = W.normalizeDashboardLayout(null);
  assert.deepEqual(empty.layout, W.DEFAULT_LAYOUT, "no stored value yields the default layout");
  assert.deepEqual(empty.hidden, [], "no stored value yields nothing hidden");
  ok("a user who never dragged anything gets the default layout");

  const stale = W.normalizeDashboardLayout({
    layout: { l: ["hk", "ghost", "arr"], r: ["msg"] },
    hidden: ["ghost", "src", "src"],
  });
  assert.ok(!stale.layout.l.includes("ghost"), "an id that is no longer registered is dropped");
  assert.ok(!stale.hidden.includes("ghost"), "a stale hidden id cannot survive either");
  assert.deepEqual(stale.hidden, ["src"], "hidden is de-duplicated and filtered to live ids");
  assert.deepEqual(
    [...stale.layout.l, ...stale.layout.r].sort(),
    [...ids].sort(),
    "every registered window still appears — a stored layout must never be able to hide a new one",
  );
  assert.deepEqual(stale.layout.l.slice(0, 2), ["hk", "arr"], "the stored order is respected");
  assert.deepEqual(stale.layout.l.slice(2), ["rev", "agd"], "unmentioned ids append in default order");
  assert.equal(stale.layout.r[0], "msg", "the stored right-column order is respected too");
  ok("a stale stored layout: unknown ids dropped, new ids appended, order preserved");

  // §3 cross-column drag — the saved state owns the column, the registry only
  // supplies the default for ids the stored layout never mentioned
  const moved = W.normalizeDashboardLayout({ layout: { l: ["msg", "arr"], r: [] }, hidden: [] });
  assert.ok(moved.layout.l.includes("msg"), "a window stored in the other column STAYS there");
  assert.ok(!moved.layout.r.includes("msg"), "…and does not also appear in its default column");
  assert.equal(moved.layout.l[0], "msg", "the stored order within the adopted column is respected");
  assert.deepEqual(
    [...moved.layout.l, ...moved.layout.r].sort(),
    [...ids].sort(),
    "every registered window appears exactly once across BOTH columns",
  );
  assert.deepEqual(
    moved.layout.r,
    ["alr", "iss", "tsk", "rvw", "src", "inh"],
    "unmentioned right-column windows append in default order",
  );
  ok("the saved state owns the column; the registry owns only the default");

  const dup = W.normalizeDashboardLayout({ layout: { l: ["msg"], r: ["msg", "alr"] }, hidden: [] });
  assert.ok(
    dup.layout.l.includes("msg") && !dup.layout.r.includes("msg"),
    "an id stored in both columns keeps its first occurrence only (l scans before r)",
  );
  assert.deepEqual(
    [...dup.layout.l, ...dup.layout.r].sort(),
    [...ids].sort(),
    "de-duplication still yields all 11 exactly once",
  );
  ok("a cross-column duplicate: first occurrence wins, nothing is lost");

  for (const junk of [undefined, 0, "x", [], { layout: "no" }, { layout: { l: 7, r: null } }]) {
    const out = W.normalizeDashboardLayout(junk);
    assert.deepEqual(
      [...out.layout.l, ...out.layout.r].sort(),
      [...ids].sort(),
      `junk input ${JSON.stringify(junk)} still yields all 11 windows`,
    );
  }
  ok("six malformed jsonb shapes each still yield all 11 windows");

  // ================= B. the donut =================
  const CIRC = 2 * Math.PI * 70;
  const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

  for (const count of [1, 2, 8]) {
    const slices = Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      label: `slice ${i}`,
      value: i + 1,
      color: "#000000",
    }));
    const g = donutArcs(slices);
    assert.equal(g.arcs.length, count, `${count} slices → ${count} arcs`);
    assert.ok(near(g.circumference, CIRC, 0.01), "circumference is 2πr for r=70");

    const sum = g.arcs.reduce((s, a) => s + a.fraction, 0);
    assert.ok(near(sum, 1), `${count}: fractions sum to 1 (got ${sum})`);

    let acc = 0;
    g.arcs.forEach((a, i) => {
      const [len, rest] = a.dash.split(" ").map(Number);
      // trap 3 — the remainder is the UNPAINTED part, not the circumference
      assert.ok(near(len + rest, CIRC, 0.01), `${count}#${i}: dash is "len rest", summing to 2πr`);
      assert.ok(near(len, CIRC * a.fraction, 0.01), `${count}#${i}: painted length matches fraction`);
      // trap 1 — offsets are zero-or-negative and accumulate
      assert.ok(a.offset <= 0, `${count}#${i}: offset must never be positive (got ${a.offset})`);
      assert.ok(near(a.offset, -acc, 0.01), `${count}#${i}: offset accumulates the lengths before it`);
      acc += len;
    });
    assert.equal(g.arcs[0].offset, 0, `${count}: the first arc starts at 12 o'clock`);
    assert.ok(near(acc, CIRC, 0.05), `${count}: the arcs close the ring exactly once`);
    ok(`donut renders ${count} slice${count === 1 ? "" : "s"}: dashes, negative accumulating offsets, ring closes`);
  }

  const degenerate = donutArcs([
    { id: "a", label: "a", value: 0, color: "#000000" },
    { id: "b", label: "b", value: -3, color: "#000000" },
  ]);
  assert.equal(degenerate.arcs.length, 0, "zero and negative slices are dropped, not painted as dots");
  assert.equal(degenerate.total, 0, "an all-zero donut has no total");
  ok("zero/negative slices drop out (a 0-length arc still paints a cap dot)");

  assert.equal(donutArcs([]).arcs.length, 0, "an empty donut has no arcs");
  ok("an empty donut renders the track ring alone");

  console.log(`\nDASHBOARD SHELL: ${n} PASSED`);
} catch (e) {
  console.error(`\nDASHBOARD SHELL FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
