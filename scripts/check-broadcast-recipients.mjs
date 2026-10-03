// check:broadcast-recipients — D206: resolveRecipients(tenantId, segment, { at })
// is who a broadcast would reach. Read-only; service segments only, combinable
// (AND); in house = DATE-based on the Asia/Jerusalem date (lib/in-house.ts, the
// dashboard's definition); cancelled / no_show / is_test / opt-out / missing,
// invalid or landline phone always excluded with a reason; one message per
// normalized E.164 phone (in house first, then nearest arrival).
//
// Runs the REAL compiled resolver against a scratch database inside a
// rolled-back transaction, then proves the assertions fail on mutants.
// DB-backed: connects to TEST_DATABASE_URL (action-harness connect()) — the
// suite reads this file to decide it needs its own cloned database.
import { readFileSync } from "node:fs";
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-broadcast-recipients", ["src/lib/communications/recipients.ts"]);
const RES = "lib/communications/recipients.js";

// static: no writes, ONE in-house definition (the dashboard and the resolver import it; neither re-spells it)
const src = readFileSync("src/lib/communications/recipients.ts", "utf8");
const dash = readFileSync("src/app/(dashboard)/dashboard/data.ts", "utf8");
const staticFail = [];
if (/\b(INSERT|UPDATE|DELETE)\b/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""))) staticFail.push("recipients.ts contains a write statement");
if (!src.includes("withReadOnlyScope(")) staticFail.push("recipients.ts does not resolve inside withReadOnlyScope");
for (const [name, text] of [["recipients.ts", src], ["dashboard/data.ts", dash]]) {
  if (!text.includes('from "@/lib/in-house"')) staticFail.push(`${name} does not import the shared in-house definition`);
  if (/rr\.check_in <= \$\{\w+\} AND rr\.check_out > \$\{\w+\}`\)/.test(text)) staticFail.push(`${name} re-spells the in-house predicate`);
}
if (!dash.includes("stayRows(tenantId, inHouseOn(today))")) staticFail.push("the dashboard's inh window does not use inHouseOn");
if (staticFail.length) { for (const f of staticFail) console.log(`✗ ${f}`); process.exit(1); }
console.log("✓ static: read-only (no write statement, withReadOnlyScope); one in-house definition shared with the dashboard");

// 22:30 UTC on 05/10 = 01:30 on 06/10 in Israel: the UTC date is a day behind
const AT = new Date("2026-10-05T22:30:00Z");

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const R = await load(RES);
  await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "broadcast");
    const [typeA] = await tx`INSERT INTO guesthub.room_types (tenant_id, name) VALUES (${tenantId}, 'סטנדרט') RETURNING id`;
    const [typeB] = await tx`INSERT INTO guesthub.room_types (tenant_id, name) VALUES (${tenantId}, 'סוויטה') RETURNING id`;
    let roomNo = 100;
    const room = async (type = typeA) => (await tx`
      INSERT INTO guesthub.rooms (tenant_id, room_number, room_type_id) VALUES (${tenantId}, ${String(++roomNo)}, ${type.id}) RETURNING id`)[0].id;
    const ids = {}; const guests = {};
    // fixture guests only — no real guest data (D201)
    const res = async (num, { ci, co, status = "confirmed", phone = null, test = false, optOut = false,
      origin = "back_office", ota = null, rooms = null, tenant = tenantId }) => {
      const [g] = await tx`INSERT INTO guesthub.guests (tenant_id, first_name, full_name, phone, language)
                           VALUES (${tenant}, ${"אורח " + num}, ${"אורח " + num}, ${phone}, 'he') RETURNING id`;
      const [r] = await tx`
        INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status, primary_guest_id,
                                           is_test, guest_communication_opt_out, booking_origin, ota_name)
        VALUES (${tenant}, ${num}, ${ci}, ${co}, ${status}, ${g.id}, ${test}, ${optOut}, ${origin}, ${ota}) RETURNING id`;
      for (const roomId of rooms ?? [await room()]) {
        await tx`INSERT INTO guesthub.reservation_rooms (tenant_id, reservation_id, room_id, check_in, check_out)
                 VALUES (${tenant}, ${r.id}, ${roomId}, ${ci}, ${co})`;
      }
      ids[num] = r.id; guests[num] = g.id;
    };
    // today (Israel) = 2026-10-06, tomorrow = 2026-10-07
    await res("R1", { ci: "2026-10-04", co: "2026-10-08", phone: "050-111-1111" });                 // in house, status confirmed
    await res("R2", { ci: "2026-10-06", co: "2026-10-09", phone: "0502222222", origin: "ota", ota: "Booking" });
    const r201 = await room(typeB); const r202 = await room(typeB);
    await res("R3", { ci: "2026-10-07", co: "2026-10-10", phone: "0503333333", origin: "direct_website", rooms: [r202] });
    await res("R4", { ci: "2026-10-03", co: "2026-10-06", phone: "0504444444", origin: "ota", ota: "expedia", status: "checked_in" }); // departs today; status says in house
    await res("R5", { ci: "2026-10-05", co: "2026-10-07", phone: "0505555555" });                   // in house, departs tomorrow
    await res("R6", { ci: "2026-10-20", co: "2026-10-22", phone: "0506666666" });
    await res("R7", { ci: "2026-10-04", co: "2026-10-08", phone: "0507777777", status: "cancelled" });
    await res("R8", { ci: "2026-10-06", co: "2026-10-08", phone: "0507000008", status: "no_show" });
    await res("R9", { ci: "2026-10-04", co: "2026-10-08", phone: "0507000009", test: true });
    await res("R10", { ci: "2026-10-04", co: "2026-10-08", phone: "0507000010", optOut: true });
    await res("R11", { ci: "2026-10-04", co: "2026-10-08", phone: null });
    await res("R12", { ci: "2026-10-04", co: "2026-10-08", phone: "12345" });
    await res("R13", { ci: "2026-10-04", co: "2026-10-08", phone: "03-1234567" });                  // Israeli landline
    await res("R14", { ci: "2026-10-15", co: "2026-10-17", phone: "+972 50-111-1111" });            // same phone as R1
    await res("R15", { ci: "2026-10-12", co: "2026-10-14", phone: "0508888888" });
    await res("R16", { ci: "2026-10-10", co: "2026-10-11", phone: "+972508888888" });               // same phone, nearer
    await res("R17", { ci: "2026-10-04", co: "2026-10-08", phone: "0509999999", rooms: [await room(), r201] }); // two rooms
    await res("R18", { ci: "2026-10-05", co: "2026-10-06", phone: "0501818181" });                  // in house on the UTC date only
    await res("R19", { ci: "2026-10-04", co: "2026-10-08", phone: "+44 7700 900123" });             // foreign mobile
    const other = (await seedTenant(tx, stub, "broadcast-other")).tenantId;
    await res("X1", { ci: "2026-10-04", co: "2026-10-08", phone: "0501111112", tenant: other });
    stub.setActor({ tenantId, userId: null });

    const name = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    const run = async (segment) => {
      const r = await R.resolveRecipients(tenantId, segment, { at: AT });
      return { date: r.date, in: r.included.map((x) => name[x.reservationId]).sort(),
        out: Object.fromEntries(r.excluded.map((x) => [name[x.reservationId], x.reason]).sort()), raw: r };
    };
    const IN_HOUSE_EXCLUDED = { R10: "opt_out", R11: "missing_phone", R12: "invalid_phone", R13: "landline", R7: "cancelled", R8: "no_show", R9: "is_test" };

    const inHouse = await run({ stay: [{ kind: "in_house" }] });
    eq(inHouse.date, "2026-10-06", "evaluated on the Israel date of `at` (01:30 on 06/10), not the UTC date (05/10)");
    eq(inHouse.in, ["R1", "R17", "R19", "R2", "R5"], "in house = check_in <= today < check_out, by date: R2 arrives today and is in house tonight; R4 departs today though its status says checked_in; R18 left today");
    eq(inHouse.out, IN_HOUSE_EXCLUDED, "in house: every always-excluded reason is listed with its code");
    eq(inHouse.raw.included.filter((x) => name[x.reservationId] === "R17").length, 1, "a two-room booking is ONE recipient");
    eq(inHouse.raw.included.find((x) => name[x.reservationId] === "R1")?.phone, "+972501111111", "the phone is normalized E.164");
    eq(inHouse.raw.included.find((x) => name[x.reservationId] === "R19")?.phone, "+447700900123", "a foreign mobile is sendable");
    eq(inHouse.raw.included.every((x) => x.inHouse), true, "every in-house recipient is flagged inHouse");

    eq((await run({ stay: [{ kind: "arriving", day: "today" }] })).in, ["R2"], "arriving today");
    eq((await run({ stay: [{ kind: "arriving", day: "today" }] })).out, { R8: "no_show" }, "…a no_show is excluded with its reason");
    eq((await run({ stay: [{ kind: "arriving", day: "tomorrow" }] })).in, ["R3"], "arriving tomorrow");
    eq((await run({ stay: [{ kind: "departing", day: "today" }] })).in, ["R18", "R4"], "departing today");
    eq((await run({ stay: [{ kind: "departing", day: "tomorrow" }] })).in, ["R5"], "departing tomorrow");
    const future = await run({ stay: [{ kind: "future" }] });
    eq([future.in, future.out], [["R14", "R16", "R3", "R6"], { R15: "duplicate_phone" }],
      "future: one message per phone — the nearest arrival (R16, 10/10) keeps it, R15 is duplicate_phone; R14 alone in this segment");
    const range = await run({ stay: [{ kind: "overlapping", from: "2026-10-10", to: "2026-10-16" }] });
    eq([range.in, range.out], [["R14", "R16"], { R15: "duplicate_phone" }], "a stay overlapping a date range");
    const wide = await run({ stay: [{ kind: "overlapping", from: "2026-10-01", to: "2026-10-31" }] });
    eq(wide.out.R14, "duplicate_phone", "R1 (in house) and R14 (future) share a phone → the in-house booking keeps it");
    eq(wide.in.includes("R1"), true, "…R1 is the one included");

    eq((await run({ stay: [{ kind: "in_house" }], roomIds: [r201] })).in, ["R17"], "specific room AND in house");
    eq((await run({ roomTypeIds: [typeB.id], stay: [{ kind: "arriving", day: "tomorrow" }] })).in, ["R3"], "room type AND arriving tomorrow");
    eq((await run({ bookingOrigins: ["ota"] })).in, ["R2", "R4"], "source channel: booking_origin");
    eq((await run({ otaNames: ["booking"] })).in, ["R2"], "source channel: ota_name, case-insensitive");
    eq((await run({ reservationIds: [ids.R6] })).in, ["R6"], "a single reservation");
    eq((await run({ guestIds: [guests.R3] })).in, ["R3"], "a single guest");
    eq((await run({ reservationIds: [ids.R7] })).out, { R7: "cancelled" }, "a single cancelled reservation is still excluded");
    eq((await run({ stay: [{ kind: "in_house" }, { kind: "departing", day: "tomorrow" }] })).in, ["R5"], "criteria combine with AND");
    eq((await run({ stay: [{ kind: "in_house" }] })).in.includes("X1"), false, "another tenant's guest never appears");

    // schema: service segments only
    const refused = async (segment) => { try { await R.resolveRecipients(tenantId, segment, { at: AT }); return false; } catch { return true; } };
    eq([await refused({}), await refused({ pastGuests: true }), await refused({ stay: [{ kind: "past" }] }),
        await refused({ stay: [{ kind: "overlapping", from: "2026-10-09", to: "2026-10-01" }] })],
      [true, true, true, true], "empty / marketing / unknown / reversed segments are refused");
    eq(R.EXCLUSION_REASON_LABELS.landline, "מספר קווי — לא ניתן לשלוח WhatsApp", "reasons carry Hebrew labels");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "cancelled filter dropped",
    mutations: [[RES, 'row.status === "cancelled" ? "cancelled"\n            : ', ""]] },
  { name: "no dedupe (one message per reservation)",
    mutations: [[RES, "for (const dup of rest)\n            excluded.push", "for (const dup of rest)\n            included.push({ reservationId: dup.id, phone: dup.e164, inHouse: dup.in_house }), void excluded.push"]] },
  { name: "status-based in house",
    mutations: [["lib/in-house.js", "return sql `rr.check_in <= ${day} AND rr.check_out > ${day}`;",
      "return sql `EXISTS (SELECT 1 FROM guesthub.reservations s WHERE s.id = rr.reservation_id AND s.status = 'checked_in') AND ${day}::date IS NOT NULL`;"]] },
  { name: "landline included",
    mutations: [[RES, '? "landline" : "invalid_phone"', '? null : "invalid_phone"']] },
  { name: "UTC date boundaries",
    mutations: [[RES, "dateInTz(options.at ?? new Date(), BROADCAST_TIMEZONE)", "(options.at ?? new Date()).toISOString().slice(0, 10)"]] },
  { name: "dedupe keeps the wrong reservation (latest arrival)",
    mutations: [[RES, "(aFuture ? a.check_in < b.check_in : a.check_in > b.check_in)", "(aFuture ? a.check_in > b.check_in : a.check_in < b.check_in)"]] },
  { name: "dedupe ignores in house (arrival order only)",
    mutations: [[RES, "if (a.in_house !== b.in_house)\n        return", "if (false)\n        return"]] },
]);
await sql.end();
