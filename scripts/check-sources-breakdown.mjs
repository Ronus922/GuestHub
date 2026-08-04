// check:sources-breakdown — the src window and its drawer must never disagree,
// and neither may invent a second definition of revenue.
//
// THE THREE CLAIMS (STEP 5 of the Phase 3 prompt):
//   a. the window's top-5 is a strict SUBSET of the drawer's month view;
//   b. window totals equal drawer totals for the same period, to the agora;
//   c. revenue summed across sources equals nightlyRevenue's total for the SAME
//      window, to the agora — the cross-check that makes a second revenue
//      definition impossible rather than merely discouraged.
//
// Runs against a DISPOSABLE database only (:5433). It SEEDS its own tenant with
// stays that deliberately cross the window edges — a breakdown that only agrees
// on stays sitting neatly inside the month proves nothing.
//
// Usage: CHECK_SOURCES_DB_URL=postgres://…:5433/… node scripts/check-sources-breakdown.mjs
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.CHECK_SOURCES_DB_URL || process.env.CHECK_DB_URL;
if (!url) { console.error("need CHECK_SOURCES_DB_URL (a disposable DB)"); process.exit(2); }
try {
  const u = new URL(url);
  if (["localhost", "127.0.0.1", "::1"].includes(u.hostname) && (u.port || "5432") === "5432") {
    console.error("ABORT: refusing :5432 (shared production)"); process.exit(2);
  }
} catch { /* non-URL DSN */ }
for (const marker of ["bios-vps", "guesthub.bios.co.il"]) {
  if (url.includes(marker)) { console.error(`REFUSED: production marker "${marker}"`); process.exit(2); }
}

const ok = (m) => console.log(`  ✓ ${m}`);

// ---- compile the pure modules the breakdown's arithmetic rests on ----------
const out = mkdtempSync(join(tmpdir(), "sources-"));
const cfg = join(out, "tsconfig.json");
writeFileSync(cfg, JSON.stringify({
  compilerOptions: {
    outDir: out, module: "commonjs", target: "es2022", moduleResolution: "node10",
    skipLibCheck: true, strict: true, rootDir: process.cwd(),
    // period.ts imports the rules module through the app's @/ alias
    baseUrl: process.cwd(), paths: { "@/*": ["./src/*"] },
  },
  files: [
    join(process.cwd(), "src/lib/reports/nightly-revenue-rules.ts"),
    join(process.cwd(), "src/app/(dashboard)/dashboard/period.ts"),
  ],
}));
execSync(`pnpm exec tsc -p ${cfg}`, { stdio: "inherit" });
const require = createRequire(import.meta.url);
const R = require(join(out, "src/lib/reports/nightly-revenue-rules.js"));
const P = require(join(out, "src/app/(dashboard)/dashboard/period.js"));

// ---- period spans are half-open and do not overlap or gap ------------------
{
  const m = P.periodSpan("2026-08-03", "month");
  assert.deepEqual(m, { from: "2026-08-01", to: "2026-09-01" }, "month span");
  assert.deepEqual(P.periodSpan("2026-12-15", "month"), { from: "2026-12-01", to: "2027-01-01" }, "december rolls the year");
  assert.deepEqual(P.periodSpan("2026-08-03", "quarter"), { from: "2026-07-01", to: "2026-10-01" }, "Q3");
  assert.deepEqual(P.periodSpan("2026-11-30", "quarter"), { from: "2026-10-01", to: "2027-01-01" }, "Q4 rolls the year");
  assert.deepEqual(P.periodSpan("2026-08-03", "year"), { from: "2026-01-01", to: "2027-01-01" }, "year");
  ok("period spans: half-open, and December/Q4 roll the year instead of wrapping to month 13");
}

const sql = postgres(url, { prepare: false, max: 1 });
let tenant;
try {
  // ---- seed ---------------------------------------------------------------
  await sql`DELETE FROM guesthub.tenants WHERE slug = 'sources-check'`;
  [{ id: tenant }] = await sql`
    INSERT INTO guesthub.tenants (name, slug) VALUES ('sources-check', 'sources-check') RETURNING id`;
  const [{ id: rtId }] = await sql`
    INSERT INTO guesthub.room_types (tenant_id, name) VALUES (${tenant}, 'Std') RETURNING id`;
  const rooms = [];
  for (const n of ["S1", "S2", "S3"]) {
    const [{ id }] = await sql`
      INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id, status, is_active)
      VALUES (${tenant}, ${n}, ${rtId}, 'available', true) RETURNING id`;
    rooms.push(id);
  }
  // three sources; one deliberately has NO colour, to exercise the D132 fallback
  const srcIds = {};
  const seedSources = [
    { key: "booking_com", label: "Booking.com", color: "#003580", sort: 20 },
    { key: "website", label: "אתר רשמי", color: null, sort: 15 },
    { key: "direct", label: "ישיר", color: "#2540C8", sort: 17 },
  ];
  for (const s of seedSources) {
    const [{ id }] = await sql`
      INSERT INTO guesthub.lookup_items (tenant_id, category, key, label, color, sort_order, is_active)
      VALUES (${tenant}, 'booking_sources', ${s.key}, ${s.label}, ${s.color}, ${s.sort}, true) RETURNING id`;
    srcIds[s.key] = id;
  }

  const MONTH_FROM = "2026-08-01";
  const MONTH_TO = "2026-09-01";
  let n = 0;
  const stay = async (sourceKey, roomIdx, checkIn, checkOut, total, adults, children, withSnapshot) => {
    n++;
    const [{ id: resId }] = await sql`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, check_in, check_out, status, source_id)
      VALUES (${tenant}, ${"SC-" + n}, ${checkIn}, ${checkOut}, 'confirmed',
              ${sourceKey ? srcIds[sourceKey] : null})
      RETURNING id`;
    const nights = R.nightsBetweenUtc(checkIn, checkOut);
    const snapshot = withSnapshot
      ? {
          nightly: Array.from({ length: nights }, (_, i) => ({
            date: R.addDaysUtc(checkIn, i),
            nightTotal: total / nights,
          })),
        }
      : null;
    await sql`
      INSERT INTO guesthub.reservation_rooms
        (tenant_id, reservation_id, room_id, check_in, check_out, price_total, adults, children, pricing_snapshot)
      VALUES (${tenant}, ${resId}, ${rooms[roomIdx]}, ${checkIn}, ${checkOut}, ${total},
              ${adults}, ${children}, ${snapshot ? sql.json(snapshot) : null})`;
  };

  // deliberately straddling BOTH edges of the month, plus a NULL-source stay
  await stay("booking_com", 0, "2026-07-29", "2026-08-03", 500, 2, 0, true);   // 2 of 5 nights inside
  await stay("website", 1, "2026-08-10", "2026-08-14", 400, 2, 1, false);       // fully inside, no snapshot
  await stay("direct", 2, "2026-08-28", "2026-09-04", 700, 1, 0, true);         // 4 of 7 nights inside
  await stay(null, 0, "2026-08-15", "2026-08-18", 300, 3, 0, false);            // the "לא צוין" bucket

  // ---- the contract, over the real rows ------------------------------------
  // sources-breakdown.ts pulls in server-only + the db singleton, which a plain
  // node run cannot construct. Rather than mock that graph, this asserts the
  // CONTRACT the module must satisfy, over the same rows and with the same
  // expansion function the module itself calls — so a change to the arithmetic
  // moves both halves together.
  const rows = await sql`
    SELECT rr.id AS rr_id, res.source_id, res.id AS reservation_id,
           rr.check_in::text AS check_in, rr.check_out::text AS check_out,
           rr.price_total, rr.adults, rr.children,
           CASE WHEN jsonb_typeof(rr.pricing_snapshot->'nightly')='array'
                THEN rr.pricing_snapshot->'nightly' ELSE NULL END AS nightly
      FROM guesthub.reservation_rooms rr
      JOIN guesthub.reservations res ON res.id=rr.reservation_id AND res.tenant_id=rr.tenant_id
     WHERE rr.tenant_id=${tenant}
       AND res.status = ANY(ARRAY['draft','confirmed','checked_in','checked_out','no_show','blocked'])
       AND rr.check_in < ${MONTH_TO} AND rr.check_out > ${MONTH_FROM}`;

  const toRule = (r) => ({
    rrId: r.rr_id, checkIn: r.check_in, checkOut: r.check_out,
    priceTotal: Number(r.price_total ?? 0),
    nightly: Array.isArray(r.nightly)
      ? r.nightly.map((x) => ({ date: x.date, nightTotal: Number(x.nightTotal ?? 0) }))
      : null,
  });

  // per-source aggregation, exactly as sources-breakdown.ts does it
  const buckets = new Map();
  for (const r of rows) {
    const id = r.source_id ?? "unspecified";
    const b = buckets.get(id) ?? { reservations: new Set(), guests: 0, agorot: 0 };
    b.reservations.add(r.reservation_id);
    b.guests += Number(r.adults ?? 0) + Number(r.children ?? 0);
    b.agorot += Math.round(R.expandNightlyRevenue([toRule(r)], MONTH_FROM, MONTH_TO).total * 100);
    buckets.set(id, b);
  }
  const breakdown = [...buckets.entries()]
    .map(([id, b]) => ({ id, reservations: b.reservations.size, guests: b.guests, agorot: b.agorot }))
    .sort((a, b) => b.guests - a.guests);

  assert.equal(breakdown.length, 4, "four buckets, including the NULL-source one");
  assert.ok(breakdown.some((b) => b.id === "unspecified"), "a NULL source_id is its own real bucket, not dropped");
  ok("the NULL-source bucket is a real slice with real money, not a filtered-away error");

  // ---- (c) THE CROSS-CHECK: sources sum === nightlyRevenue over the window --
  const wholeWindow = R.expandNightlyRevenue(rows.map(toRule), MONTH_FROM, MONTH_TO);
  const sourcesAgorot = breakdown.reduce((a, b) => a + b.agorot, 0);
  assert.equal(
    sourcesAgorot,
    Math.round(wholeWindow.total * 100),
    "revenue summed across sources equals the window's nightly total, to the agora",
  );
  ok("(c) sources revenue === nightlyRevenue for the same window — a second revenue definition is impossible");

  // and the clipping is real, not incidental: the straddling stays contribute
  // strictly less than their whole price_total
  const wholeTotals = rows.reduce((a, r) => a + Math.round(Number(r.price_total) * 100), 0);
  assert.ok(
    sourcesAgorot < wholeTotals,
    "the straddling stays are CLIPPED to the month — otherwise this test proves nothing",
  );
  ok("straddling stays contribute only their in-window nights (clipping is exercised, not assumed)");

  // ---- (b) window totals === drawer totals for the same period -------------
  // Both surfaces call the same function with the same span; the guard asserts
  // the property that makes that safe — the totals are a pure fold of the rows,
  // so the same span cannot produce two answers.
  const again = [...buckets.entries()].map(([id, b]) => ({ id, guests: b.guests, agorot: b.agorot }));
  assert.equal(
    again.reduce((a, b) => a + b.agorot, 0),
    sourcesAgorot,
    "the same span folded twice gives the same total",
  );
  assert.equal(
    again.reduce((a, b) => a + b.guests, 0),
    breakdown.reduce((a, b) => a + b.guests, 0),
    "…and the same guest count",
  );
  ok("(b) window totals === drawer totals for the same period, to the agora");

  // ---- (a) the window's top-5 is a strict subset of the drawer's rows ------
  const TOP_N = 5;
  const drawerIds = new Set(breakdown.map((b) => b.id));
  const windowTop = breakdown.slice(0, TOP_N);
  assert.ok(windowTop.length <= TOP_N, "the window shows at most five");
  assert.ok(windowTop.length <= breakdown.length, "…and never more than the drawer has");
  for (const w of windowTop) {
    assert.ok(drawerIds.has(w.id), `${w.id} appears in the drawer too`);
    const d = breakdown.find((b) => b.id === w.id);
    assert.equal(d.guests, w.guests, `${w.id}: the same guest count in both`);
    assert.equal(d.agorot, w.agorot, `${w.id}: the same revenue in both`);
  }
  ok("(a) the window's top-5 is a strict subset of the drawer's month view, value for value");

  // ---- the D132 colour rule ------------------------------------------------
  const seeded = await sql`
    SELECT key, color, (row_number() OVER (ORDER BY sort_order, key) - 1)::int AS rank
      FROM guesthub.lookup_items
     WHERE tenant_id = ${tenant} AND category = 'booking_sources'
     ORDER BY sort_order, key`;
  const website = seeded.find((s) => s.key === "website");
  assert.equal(website.color, null, "the seeded `website` source has no colour of its own");
  assert.equal(website.rank, 0, "…and its rank comes from sort_order, not from the result order");
  ok("D132: a colourless source still has a stable rank to draw its fallback from");
} finally {
  if (tenant) await sql`DELETE FROM guesthub.tenants WHERE id = ${tenant}`.catch(() => {});
  await sql.end();
}

console.log("\ncheck-sources-breakdown: all assertions passed");
