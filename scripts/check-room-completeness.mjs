#!/usr/bin/env node
// ============================================================
// check:room-completeness — D197 §D-D: ONE server-side function
// (src/lib/rooms/completeness.ts → roomCompleteness) decides what a room is
// still missing, and the rooms list chip and the wizard panel both read it.
//
// The seven criteria, each proven on its own fixture room (everything else
// on that room is complete, so exactly one key must come back):
//   1. at least one photo                 → photo
//   2. size in sqm                         → size_sqm
//   3. Hebrew name + description           → name_he, description_he
//      (a "he" row holding English text is NOT Hebrew — same script test the
//      public catalog applies, lib/rooms/lang-text.ts)
//   4. English name + description          → name_en, description_en
//   5. Arabic name + description           → name_ar, description_ar
//   6. slug (Hebrew — the website reads lang=he) → slug
//   7. resolved occupancy, room → room type, through THE engine's resolver
//      (getRoomCapacities): the room falls to the hardcoded default only when
//      neither it nor a room type supplies max_occupancy → occupancy
//
// Nothing committed: one transaction, always rolled back.
// Usage: node scripts/check-room-completeness.mjs
// ============================================================
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
  if (TEST_URL.includes(marker)) {
    console.error(`REFUSED: TEST_DATABASE_URL contains production marker "${marker}"`);
    process.exit(1);
  }
}
process.env.DATABASE_URL = TEST_URL;

const psql = (sqlText) =>
  execSync(`psql "${TEST_URL}" -tA -v ON_ERROR_STOP=1`,
    { input: sqlText, cwd: ROOT, shell: "/bin/bash" }).toString().trim();

if (psql(`SELECT to_regclass('guesthub.rooms') IS NULL`) === "t") {
  console.log("applying migration chain to the test DB…");
  for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    execSync(
      `psql "${TEST_URL}" -q -v ON_ERROR_STOP=1 < "db/migrations/${f}"`,
      { cwd: ROOT, stdio: ["pipe", "ignore", "inherit"], shell: "/bin/bash" },
    );
  }
}

// ---- compile the real modules (tsc → CJS) ----
console.log("compiling lib/rooms/completeness (+ inventory resolver, lang-text) via tsc…");
const tmp = mkdtempSync(join(tmpdir(), "gh-room-completeness-"));
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
    join(ROOT, "src/lib/rooms/completeness.ts"),
    join(ROOT, "src/lib/rooms/completeness-keys.ts"),
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

const { roomCompleteness } = req(join(out, "lib/rooms/completeness.js"));
const { ROOM_MISSING_KEYS, ROOM_MISSING_LABEL, ROOM_MISSING_TARGET } = req(join(out, "lib/rooms/completeness-keys.js"));
const { getRoomCapacities } = req(join(out, "lib/inventory.js"));

const postgres = req("postgres");
const sql = postgres(TEST_URL, { prepare: false, max: 1, onnotice: () => {} });
class Rollback extends Error {}
let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// the complete translation set — Hebrew/Arabic carry their own script
const FULL_TR = {
  he: { name: "סוויטה עם נוף לים", description: "דירה מרווחת מול הים", slug: "sea-view" },
  en: { name: "Sea view suite", description: "A spacious apartment facing the sea", slug: null },
  ar: { name: "جناح مطل على البحر", description: "شقة واسعة مقابل البحر", slug: null },
};

async function buildFixture(tx) {
  const [t] = await tx`INSERT INTO guesthub.tenants (name, slug, currency, settings)
    VALUES ('Room Completeness', ${`rc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`}, 'ILS', ${tx.json({ vat_rate: 18 })}) RETURNING id`;
  const T = t.id;
  const [type] = await tx`INSERT INTO guesthub.room_types (tenant_id, name, base_price, max_occupancy, max_adults, max_children, max_infants)
    VALUES (${T}, 'Bedroom', 680, 4, 4, 2, 1) RETURNING id`;

  // a room that is complete unless `gap` says otherwise
  const room = async (num, gap = {}) => {
    const [r] = await tx`INSERT INTO guesthub.rooms ${tx({
      tenant_id: T, room_type_id: gap.noType ? null : type.id, room_number: num, name: `Room ${num}`,
      status: "available", is_active: true, show_on_website: true,
      size_sqm: gap.size === undefined ? 32 : gap.size,
      max_occupancy: gap.roomOccupancy === undefined ? 2 : gap.roomOccupancy,
      max_adults: 2, max_children: 1, max_infants: 1,
      included_occupancy: 2, extra_guest_pricing_mode: "inherit",
    })} RETURNING id`;
    if (!gap.noPhoto) await tx`INSERT INTO guesthub.room_images (tenant_id, room_id, url, is_main) VALUES (${T}, ${r.id}, ${`https://x/${num}.jpg`}, true)`;
    const trs = { ...FULL_TR, ...(gap.tr ?? {}) };
    for (const lang of ["he", "en", "ar"]) {
      const v = trs[lang];
      if (!v) continue;
      await tx`INSERT INTO guesthub.room_translations (tenant_id, room_id, lang, name, description, slug)
        VALUES (${T}, ${r.id}, ${lang}, ${v.name}, ${v.description}, ${v.slug === null ? null : v.slug ? `${v.slug}-${num}` : null})`;
    }
    return { id: r.id, num };
  };

  return {
    T,
    full: await room("rc-full"),
    noPhoto: await room("rc-photo", { noPhoto: true }),
    noSize: await room("rc-size", { size: null }),
    zeroSize: await room("rc-size0", { size: 0 }),
    heEnglish: await room("rc-he", { tr: { he: { name: "Sea view suite", description: "English text in the he row", slug: "sea-view" } } }),
    noEn: await room("rc-en", { tr: { en: null } }),
    arHebrew: await room("rc-ar", { tr: { ar: { name: "שם בעברית", description: "תיאור בעברית", slug: null } } }),
    noSlug: await room("rc-slug", { tr: { he: { ...FULL_TR.he, slug: null } } }),
    // occupancy: NULL on the room AND no room type → the engine's hardcoded default
    noOccupancy: await room("rc-occ", { roomOccupancy: null, noType: true }),
    // occupancy resolved by the TYPE (room NULL, type 4) → complete
    typeOccupancy: await room("rc-occ-type", { roomOccupancy: null }),
    // occupancy resolved by the ROOM alone (no type) → complete
    roomOccupancy: await room("rc-occ-room", { noType: true }),
  };
}

try {
  await sql.begin(async (tx) => {
    const f = await buildFixture(tx);
    const all = await roomCompleteness(tx, f.T);
    const missingOf = (r) => all.get(r.id)?.missing ?? null;

    // ---- the closed key set is what the UI maps -------------------------------
    for (const k of ROOM_MISSING_KEYS) {
      assert.ok(typeof ROOM_MISSING_LABEL[k] === "string" && ROOM_MISSING_LABEL[k].length > 0, `${k}: has a Hebrew label`);
      assert.ok([1, 2, 3].includes(ROOM_MISSING_TARGET[k]?.step) && ROOM_MISSING_TARGET[k].field.startsWith("rm-f-"), `${k}: has a wizard target`);
    }
    ok(`keys: all ${ROOM_MISSING_KEYS.length} keys carry a label and a wizard target (step + field id)`);

    // ---- complete room ---------------------------------------------------------
    assert.deepEqual(missingOf(f.full), [], "rc-full: nothing missing");
    assert.equal(all.get(f.full.id).count, 0);
    ok("complete room: missing = [], count = 0");

    // ---- one criterion at a time -----------------------------------------------
    assert.deepEqual(missingOf(f.noPhoto), ["photo"], "1. no photo → photo");
    ok("criterion 1: at least one photo");
    assert.deepEqual(missingOf(f.noSize), ["size_sqm"], "2. size NULL → size_sqm");
    assert.deepEqual(missingOf(f.zeroSize), ["size_sqm"], "2. size 0 → size_sqm");
    ok("criterion 2: size in sqm (NULL and 0 are both missing)");
    assert.deepEqual(missingOf(f.heEnglish), ["name_he", "description_he"], "3. he row with English text → name_he + description_he");
    ok("criterion 3: Hebrew name + description — English text in the he row does not count");
    assert.deepEqual(missingOf(f.noEn), ["name_en", "description_en"], "4. no en row → name_en + description_en");
    ok("criterion 4: English name + description");
    assert.deepEqual(missingOf(f.arHebrew), ["name_ar", "description_ar"], "5. ar row with Hebrew text → name_ar + description_ar");
    ok("criterion 5: Arabic name + description — Hebrew text in the ar row does not count");
    assert.deepEqual(missingOf(f.noSlug), ["slug"], "6. no Hebrew slug → slug");
    ok("criterion 6: slug (Hebrew, the language the website reads)");
    assert.deepEqual(missingOf(f.noOccupancy), ["occupancy"], "7. room NULL + no type → occupancy");
    assert.deepEqual(missingOf(f.typeOccupancy), [], "7. room NULL + type 4 → resolved by the type");
    assert.deepEqual(missingOf(f.roomOccupancy), [], "7. room 2 + no type → resolved by the room");
    // and it IS the engine's resolver that said so
    const caps = await getRoomCapacities(tx, f.T, [f.noOccupancy.id, f.typeOccupancy.id, f.roomOccupancy.id]);
    assert.equal(caps.get(f.noOccupancy.id).max_occupancy_source, "default");
    assert.equal(caps.get(f.typeOccupancy.id).max_occupancy_source, "type");
    assert.equal(caps.get(f.roomOccupancy.id).max_occupancy_source, "room");
    assert.equal(caps.get(f.typeOccupancy.id).max_occupancy, 4, "the type's value is what the engine resolves");
    ok("criterion 7: occupancy through getRoomCapacities — room, else type; only the hardcoded default is 'missing'");

    // ---- count and scoping -----------------------------------------------------
    for (const r of Object.values(f)) {
      if (typeof r !== "object") continue;
      const c = all.get(r.id);
      assert.equal(c.count, c.missing.length, `${r.num}: count == missing.length`);
    }
    const one = await roomCompleteness(tx, f.T, [f.noPhoto.id]);
    assert.equal(one.size, 1, "roomIds narrows the evaluation");
    assert.deepEqual(one.get(f.noPhoto.id).missing, ["photo"]);
    const [other] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('Other', ${`rc-o-${Date.now()}`}) RETURNING id`;
    assert.equal((await roomCompleteness(tx, other.id)).size, 0, "another tenant sees none of these rooms");
    ok("count == missing.length; roomIds narrows; tenant-scoped");

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); await sql.end(); process.exit(1); }
}

await sql.end();
console.log(`\nALL ${n} ROOM-COMPLETENESS CHECKS PASSED (nothing committed)`);
