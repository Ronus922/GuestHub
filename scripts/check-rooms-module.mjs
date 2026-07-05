// Rooms-module invariants (migration 013 + data completion).
// Run: node --env-file=.env.local scripts/check-rooms-module.mjs
//
// 1. schema: new tables/columns/unique indexes exist
// 2. data: every room is complete (occupancy, he/en/ar content+SEO+slug, amenities)
// 3. safety: duplicate room-number and duplicate slug are rejected by the DB
// 4. round-trip: create → translate → link amenity → delete cascades clean
// Read-only except a throwaway ZZTEST room that is always deleted.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
const TENANT = "68139d06-58c4-4043-b256-4691f83e1556";
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
};

// ---- 1. schema ----
const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'guesthub'
    AND table_name IN ('room_translations', 'room_images', 'room_amenities', 'operational_areas')`;
ok(tables.length === 4, "013 tables exist (translations, images, amenities, operational_areas)");

const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'guesthub' AND table_name = 'rooms'
    AND column_name IN ('show_on_website', 'sort_order', 'size_sqm')`;
ok(cols.length === 3, "rooms has show_on_website / sort_order / size_sqm");

const idx = await sql`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'guesthub'
    AND indexname IN ('rooms_tenant_number_uniq', 'room_translations_slug_uniq', 'room_images_main_uniq')`;
ok(idx.length === 3, "unique indexes exist (room number, slug, main image)");

// ---- 2. the 14 real rooms are complete ----
const [completeness] = await sql`
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE r.included_occupancy IS NOT NULL AND r.default_occupancy IS NOT NULL)::int AS occupancy_done,
         COUNT(*) FILTER (WHERE r.single_beds + r.double_beds + r.queen_beds + r.sofa_beds > 0)::int AS beds_done,
         COUNT(*) FILTER (WHERE r.size_sqm IS NOT NULL)::int AS size_done
  FROM guesthub.rooms r WHERE r.tenant_id = ${TENANT}`;
ok(completeness.total === 14, `14 rooms exist (found ${completeness.total})`);
ok(completeness.occupancy_done === completeness.total, "all rooms: default + included occupancy set");
ok(completeness.beds_done === completeness.total, "all rooms: sleeping arrangements set");
ok(completeness.size_done === completeness.total, "all rooms: size set");

const [langRows] = await sql`
  SELECT COUNT(*) FILTER (WHERE lang = 'he')::int AS he,
         COUNT(*) FILTER (WHERE lang = 'en')::int AS en,
         COUNT(*) FILTER (WHERE lang = 'ar')::int AS ar
  FROM guesthub.room_translations
  WHERE tenant_id = ${TENANT} AND name IS NOT NULL AND seo_title IS NOT NULL
    AND meta_description IS NOT NULL AND slug IS NOT NULL`;
ok(langRows.he === 14 && langRows.en === 14 && langRows.ar === 14,
  `he/en/ar content+SEO+slug complete for all 14 rooms (he=${langRows.he} en=${langRows.en} ar=${langRows.ar})`);

const [{ n: amenLinked }] = await sql`
  SELECT COUNT(DISTINCT room_id)::int AS n FROM guesthub.room_amenities WHERE tenant_id = ${TENANT}`;
ok(amenLinked === 14, `all 14 rooms have amenities (${amenLinked})`);

// ---- 2b. migration 014 (D49): min_occupancy + grouped amenity catalog ----
const cols014 = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'guesthub' AND table_name = 'rooms' AND column_name = 'min_occupancy'`;
ok(cols014.length === 1, "rooms has min_occupancy (014)");

const [{ n: minBackfilled }] = await sql`
  SELECT COUNT(*)::int AS n FROM guesthub.rooms
  WHERE tenant_id = ${TENANT} AND min_occupancy IS NOT NULL`;
ok(minBackfilled >= 14, `min_occupancy backfilled on existing rooms (${minBackfilled})`);

let minChkRejected = false;
try {
  await sql`INSERT INTO guesthub.rooms (tenant_id, room_number, max_occupancy, max_adults, min_occupancy)
            VALUES (${TENANT}, 'ZZTEST-MIN-CHK', 2, 2, 5)`;
  await sql`DELETE FROM guesthub.rooms WHERE tenant_id = ${TENANT} AND room_number = 'ZZTEST-MIN-CHK'`;
} catch (e) {
  minChkRejected = e.code === "23514";
}
ok(minChkRejected, "min_occupancy > max_occupancy rejected by DB CHECK");

const [{ n: catalogSize }] = await sql`
  SELECT COUNT(*)::int AS n FROM guesthub.lookup_items
  WHERE tenant_id = ${TENANT} AND category = 'amenities'
    AND metadata->>'group' IN ('חדר רחצה', 'בידור', 'כללי', 'מטבח', 'יוקרה')`;
ok(catalogSize === 38, `approved amenity catalog: 38 grouped items (${catalogSize})`);

// ---- 3 + 4. DB-enforced uniqueness + cascade round-trip ----
const TEST_NUMBER = "ZZTEST-ROOMS-CHECK";
await sql`DELETE FROM guesthub.rooms WHERE tenant_id = ${TENANT} AND room_number = ${TEST_NUMBER}`;
try {
  const [room] = await sql`
    INSERT INTO guesthub.rooms (tenant_id, room_number, name, max_occupancy, max_adults)
    VALUES (${TENANT}, ${TEST_NUMBER}, 'בדיקת מודול חדרים', 2, 2) RETURNING id`;

  let dupNumberRejected = false;
  try {
    await sql`INSERT INTO guesthub.rooms (tenant_id, room_number, max_occupancy, max_adults)
              VALUES (${TENANT}, ${TEST_NUMBER.toLowerCase()}, 2, 2)`;
  } catch (e) {
    dupNumberRejected = e.code === "23505";
  }
  ok(dupNumberRejected, "duplicate room number rejected (case-insensitive)");

  await sql`
    INSERT INTO guesthub.room_translations (tenant_id, room_id, lang, name, slug)
    VALUES (${TENANT}, ${room.id}, 'he', 'בדיקה', 'zztest-check-slug')`;
  let dupSlugRejected = false;
  try {
    const [other] = await sql`
      SELECT room_id FROM guesthub.room_translations
      WHERE tenant_id = ${TENANT} AND lang = 'he' AND room_id != ${room.id} LIMIT 1`;
    await sql`
      UPDATE guesthub.room_translations SET slug = 'zztest-check-slug'
      WHERE room_id = ${other.room_id} AND lang = 'he'`;
  } catch (e) {
    dupSlugRejected = e.code === "23505";
  }
  ok(dupSlugRejected, "duplicate slug rejected within same language");

  const [amenity] = await sql`
    SELECT id FROM guesthub.lookup_items
    WHERE tenant_id = ${TENANT} AND category = 'amenities' LIMIT 1`;
  await sql`INSERT INTO guesthub.room_amenities (tenant_id, room_id, amenity_id)
            VALUES (${TENANT}, ${room.id}, ${amenity.id})`;

  await sql`DELETE FROM guesthub.rooms WHERE id = ${room.id}`;
  const [{ n: orphans }] = await sql`
    SELECT (SELECT COUNT(*) FROM guesthub.room_translations WHERE room_id = ${room.id})
         + (SELECT COUNT(*) FROM guesthub.room_amenities WHERE room_id = ${room.id}) AS n`;
  ok(Number(orphans) === 0, "delete cascades translations + amenity links");
} finally {
  await sql`DELETE FROM guesthub.rooms WHERE tenant_id = ${TENANT} AND room_number = ${TEST_NUMBER}`;
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
await sql.end();
process.exit(failures === 0 ? 0 : 1);
