// Completes the 14 real rooms of the גינות הים tenant (Rooms-module step 2):
// occupancy defaults, sleeping arrangements, size, website visibility, he/en/ar
// content + SEO + unique slugs, and a baseline amenity set.
//
// Run: node --env-file=.env.local scripts/complete-rooms-data.mjs
//
// Additive + idempotent: occupancy fields use COALESCE (never clobbers a manual
// edit), translations upsert per (room, lang), amenity links ON CONFLICT DO
// NOTHING. No deletes, no reservation/status/rate changes.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
const TENANT = "68139d06-58c4-4043-b256-4691f83e1556";

// per-type completion profile, keyed by room_types.name
const PROFILES = {
  "סטודיו": {
    default_occupancy: 2, included_occupancy: 2,
    beds: { single: 0, double: 1, queen: 0, sofa: 0, cribs: 1 },
    size: 24,
    amenities: ["wifi", "ac", "tv", "safe", "fridge", "coffee", "hairdryer"],
    he: {
      typeName: "סטודיו",
      desc: (loc) => `סטודיו מעוצב ומואר ${loc.he}, דקות הליכה מחוף הים של תל אביב. מיטה זוגית נוחה, פינת קפה, מקרר, מיזוג אוויר ו-Wi-Fi מהיר — פתרון מושלם לזוגות.`,
      summary: "סטודיו זוגי מעוצב דקות הליכה מהים — פינת קפה, מיזוג, כספת ו-Wi-Fi מהיר.",
    },
    en: {
      typeName: "Studio",
      desc: (loc) => `A bright, stylish studio ${loc.en}, minutes from the Tel Aviv beach. Comfortable double bed, coffee corner, fridge, air conditioning and fast Wi-Fi — perfect for couples.`,
      summary: "Stylish studio for two, minutes from the beach — coffee corner, A/C and fast Wi-Fi.",
    },
    ar: {
      typeName: "ستوديو",
      desc: (loc) => `ستوديو أنيق ومضيء ${loc.ar}، على بعد دقائق من شاطئ تل أبيب. سرير مزدوج مريح، ركن قهوة، ثلاجة، تكييف وواي فاي سريع — مثالي للأزواج.`,
      summary: "ستوديو أنيق لشخصين على بعد دقائق من البحر — ركن قهوة وتكييف وواي فاي سريع.",
    },
  },
  "דירת חדר שינה": {
    default_occupancy: 2, included_occupancy: 2,
    beds: { single: 0, double: 1, queen: 0, sofa: 1, cribs: 1 },
    size: 38,
    amenities: ["wifi", "ac", "tv", "safe", "fridge", "coffee", "hairdryer", "kitchenette"],
    he: {
      typeName: "דירת חדר שינה",
      desc: (loc) => `דירה עם חדר שינה נפרד וסלון מרווח ${loc.he}. מטבחון מאובזר, ספה נפתחת לאירוח עד 4 אורחים, מיזוג אוויר ו-Wi-Fi. מתאימה למשפחות קטנות ולשהות ארוכה.`,
      summary: "דירת חדר שינה עם סלון ומטבחון מאובזר — עד 4 אורחים, דקות מחוף הים.",
    },
    en: {
      typeName: "One-Bedroom Apartment",
      desc: (loc) => `An apartment with a separate bedroom and spacious living room ${loc.en}. Equipped kitchenette, sofa bed for up to 4 guests, air conditioning and Wi-Fi. Great for small families and longer stays.`,
      summary: "One-bedroom apartment with living room and kitchenette — up to 4 guests near the beach.",
    },
    ar: {
      typeName: "شقة بغرفة نوم",
      desc: (loc) => `شقة بغرفة نوم منفصلة وصالة واسعة ${loc.ar}. مطبخ صغير مجهز، أريكة سرير حتى 4 ضيوف، تكييف وواي فاي. مثالية للعائلات الصغيرة والإقامات الطويلة.`,
      summary: "شقة بغرفة نوم وصالة ومطبخ صغير — حتى 4 ضيوف قرب الشاطئ.",
    },
  },
  "סוויטה משפחתית": {
    default_occupancy: 4, included_occupancy: 4,
    beds: { single: 2, double: 1, queen: 0, sofa: 1, cribs: 1 },
    size: 55,
    amenities: ["wifi", "ac", "tv", "safe", "fridge", "coffee", "hairdryer", "kitchenette", "balcony"],
    he: {
      typeName: "סוויטה משפחתית",
      desc: (loc) => `סוויטה משפחתית מרווחת ${loc.he} — חדר שינה זוגי, פינת ילדים עם שתי מיטות יחיד, סלון עם ספה נפתחת ומרפסת. עד 6 אורחים, מטבחון מלא, מיזוג ו-Wi-Fi.`,
      summary: "סוויטה משפחתית עד 6 אורחים — חדר שינה, פינת ילדים, מרפסת ומטבחון מלא.",
    },
    en: {
      typeName: "Family Suite",
      desc: (loc) => `A spacious family suite ${loc.en} — double bedroom, kids' corner with two single beds, living room with sofa bed and a balcony. Up to 6 guests, full kitchenette, A/C and Wi-Fi.`,
      summary: "Family suite for up to 6 — bedroom, kids' corner, balcony and full kitchenette.",
    },
    ar: {
      typeName: "جناح عائلي",
      desc: (loc) => `جناح عائلي واسع ${loc.ar} — غرفة نوم مزدوجة، ركن أطفال بسريرين مفردين، صالة بأريكة سرير وشرفة. حتى 6 ضيوف، مطبخ صغير كامل، تكييف وواي فاي.`,
      summary: "جناح عائلي حتى 6 ضيوف — غرفة نوم وركن أطفال وشرفة ومطبخ صغير.",
    },
  },
};

const slugBase = { "סטודיו": "studio", "דירת חדר שינה": "one-bedroom", "סוויטה משפחתית": "family-suite" };

function locationOf(roomNumber, floor) {
  if (roomNumber.startsWith("G")) {
    return {
      he: "באגף הבריכה, עם יציאה לגינה",
      en: "in the pool wing, opening to the garden",
      ar: "في جناح المسبح مع إطلالة على الحديقة",
      label: { he: "יחידת גן", en: "Garden Unit", ar: "وحدة حديقة" },
      extraAmenities: ["balcony"],
    };
  }
  return {
    he: `בקומה ${floor} של הבניין הראשי`,
    en: `on floor ${floor} of the main building`,
    ar: `في الطابق ${floor} من المبنى الرئيسي`,
    label: null,
    extraAmenities: [],
  };
}

const rooms = await sql`
  SELECT r.id, r.room_number, r.floor, rt.name AS type_name
  FROM guesthub.rooms r
  JOIN guesthub.room_types rt ON rt.id = r.room_type_id
  WHERE r.tenant_id = ${TENANT}
  ORDER BY r.room_number`;

const amenityRows = await sql`
  SELECT id, key FROM guesthub.lookup_items
  WHERE tenant_id = ${TENANT} AND category = 'amenities'`;
const amenityByKey = new Map(amenityRows.map((a) => [a.key, a.id]));

let updated = 0;
for (const room of rooms) {
  const p = PROFILES[room.type_name];
  if (!p) {
    console.error(`skip ${room.room_number}: unknown type ${room.type_name}`);
    continue;
  }
  const loc = locationOf(room.room_number, room.floor);
  const isGarden = room.room_number.startsWith("G");
  const slug = isGarden
    ? `garden-unit-${room.room_number.toLowerCase()}`
    : `${slugBase[room.type_name]}-${room.room_number}`;

  await sql.begin(async (tx) => {
    await tx`
      UPDATE guesthub.rooms SET
        default_occupancy = COALESCE(default_occupancy, ${p.default_occupancy}),
        included_occupancy = COALESCE(included_occupancy, ${p.included_occupancy}),
        single_beds = ${p.beds.single}, double_beds = ${p.beds.double},
        queen_beds = ${p.beds.queen}, sofa_beds = ${p.beds.sofa}, cribs = ${p.beds.cribs},
        size_sqm = COALESCE(size_sqm, ${p.size + (isGarden ? 5 : 0)}),
        show_on_website = true
      WHERE id = ${room.id} AND tenant_id = ${TENANT}`;

    for (const lang of ["he", "en", "ar"]) {
      const c = p[lang];
      const name = isGarden
        ? `${loc.label[lang]} ${room.room_number}`
        : lang === "he"
          ? `${c.typeName} ${room.room_number}`
          : `${c.typeName} ${room.room_number}`;
      const seoTitle =
        lang === "he"
          ? `${name} · גינות הים תל אביב`
          : lang === "en"
            ? `${name} · Ginot HaYam Tel Aviv`
            : `${name} · جينوت هيام تل أبيب`;
      await tx`
        INSERT INTO guesthub.room_translations (
          tenant_id, room_id, lang, name, description, summary, slug,
          seo_title, meta_description, og_title, og_description, noindex)
        VALUES (
          ${TENANT}, ${room.id}, ${lang}, ${name}, ${c.desc(loc)}, ${c.summary},
          ${slug}, ${seoTitle}, ${c.summary}, ${seoTitle}, ${c.summary}, false)
        ON CONFLICT (room_id, lang) DO UPDATE SET
          name = COALESCE(NULLIF(guesthub.room_translations.name, ''), EXCLUDED.name),
          description = COALESCE(guesthub.room_translations.description, EXCLUDED.description),
          summary = COALESCE(guesthub.room_translations.summary, EXCLUDED.summary),
          slug = COALESCE(guesthub.room_translations.slug, EXCLUDED.slug),
          seo_title = COALESCE(guesthub.room_translations.seo_title, EXCLUDED.seo_title),
          meta_description = COALESCE(guesthub.room_translations.meta_description, EXCLUDED.meta_description),
          og_title = COALESCE(guesthub.room_translations.og_title, EXCLUDED.og_title),
          og_description = COALESCE(guesthub.room_translations.og_description, EXCLUDED.og_description)`;
    }

    const keys = [...new Set([...p.amenities, ...loc.extraAmenities])];
    for (const key of keys) {
      const amenityId = amenityByKey.get(key);
      if (!amenityId) continue;
      await tx`
        INSERT INTO guesthub.room_amenities (tenant_id, room_id, amenity_id)
        VALUES (${TENANT}, ${room.id}, ${amenityId})
        ON CONFLICT DO NOTHING`;
    }
  });
  updated += 1;
  console.log(`✓ ${room.room_number} (${room.type_name}) — ${slug}`);
}

console.log(`\n${updated}/${rooms.length} rooms completed`);
await sql.end();
