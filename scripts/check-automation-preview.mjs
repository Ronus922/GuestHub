// check:automation-preview — D203: "מי יקבל ב-7 הימים הקרובים" shows exactly
// what the real scheduler + engine would do, day by day, and writes nothing.
//
// For every one of the six windows (plus an expired-catch-up automation) the
// guard runs, on one seed and one frozen clock:
//   · the PREVIEW (previewScheduledAutomation — the scheduler's predicate +
//     the engine's evaluateEventAutomations with recording effects), and
//   · the REAL PIPELINE, per day: the automation is activated inside a
//     savepoint, runScheduledTriggerScan({ at }) emits, prepareDeliveriesForEvent
//     plans the outbound rows, and the savepoint is rolled back,
// and asserts the two agree for every reservation the pipeline touched, plus
// absolute expectations for the seed (stale/cancelled status, test, opt-out,
// missing phone, landline, outside_stay, expired catch-up, already sent).
// A preview call must not change a single tuple (pg_stat_xact_user_tables),
// and the REAL lib/db withReadOnlyScope must make PostgreSQL refuse a write.
//
// Runs the REAL compiled code against a scratch database inside a rolled-back
// transaction; every mutant below must turn it red. DB-backed: connects to
// TEST_DATABASE_URL (action-harness connect()) — the suite reads this file to
// decide it needs its own cloned database.
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

const url = process.env.TEST_DATABASE_URL
  || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
process.env.DATABASE_URL = url; // the REAL lib/db (read-only scope probe) connects here
const sql = connect();
const out = compile("check-automation-preview", [
  "src/lib/communications/preview.ts",
  "src/app/(dashboard)/communications/actions.ts",
  "src/lib/db.ts",
]);
const PREVIEW = "lib/communications/preview.js";
const AUTO = "lib/communications/automation.js";
const DB = "lib/db.js";

const TODAY = "2026-07-15";
const NOW = new Date("2026-07-15T07:30:00Z"); // 10:30 Asia/Jerusalem (IDT)
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const israelInstant = (date, hm) => new Date(`${date}T${hm}:00+03:00`); // July = IDT

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const [P, A, S, T, C, DBM] = await Promise.all([
    load(PREVIEW), load(AUTO), load("lib/communications/scheduler.js"), load("lib/communications/triggers.js"),
    load("app/(dashboard)/communications/actions.js"), load(DB),
  ]);
  const L = A.SKIP_REASON_LABELS;

  // ---- the REAL read-only scope (lib/db), on its own connection ----
  try {
    eq(await DBM.withReadOnlyScope(async () => (await DBM.sql`SELECT current_setting('transaction_read_only') AS ro`)[0].ro),
      "on", "lib/db: inside withReadOnlyScope every `sql` statement runs in a read-only transaction");
    eq((await DBM.sql`SELECT current_setting('transaction_read_only') AS ro`)[0].ro, "off",
      "lib/db: outside the scope `sql` is the ordinary pool");
    let code = null;
    try {
      await DBM.withReadOnlyScope(async () => {
        await DBM.sql`INSERT INTO guesthub.tenants (name, slug) VALUES ('ro-probe', ${`ro-probe-${Date.now()}`})`;
        throw new Error("probe-wrote");
      });
    } catch (error) { code = error.code ?? error.message; }
    eq(code, "25006", "lib/db: a write inside the scope is refused by PostgreSQL (read_only_sql_transaction)");
  } catch (error) { fail.push(`lib/db read-only probe crashed: ${error.message}`); }

  await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "preview");
    // a connected + tested WhatsApp channel — the engine's readiness bar
    await tx`UPDATE guesthub.tenants SET settings = '{"messaging":{"whatsappProvider":"green_api"}}'::jsonb WHERE id = ${tenantId}`;
    await tx`INSERT INTO guesthub.messaging_provider_connections (tenant_id, provider, status, last_tested_at, secret_ciphertext)
             VALUES (${tenantId}, 'green_api', 'connected', now(), 'fixture')`;
    const wa = { channel: "whatsapp", name: "תבנית תצוגה", category: "reservation", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text: "שלום {{guest.first_name}}" } };
    const templateId = (await C.saveTemplateDraftAction(wa)).id;
    await C.publishTemplateAction({ ...wa, id: templateId });

    const automation = async (name, triggerType, offsetDays, sendTime) => {
      const res = await C.saveAutomationAction({ name, triggerType, channel: "whatsapp", templateId,
        sources: ["back_office", "direct_website"], offsetDays, sendTime, activate: false,
        recipient: { guest: true, owner: null } });
      if (!res.success) throw new Error(`save ${name}: ${res.error}`);
      return res.id;
    };
    const ids = {
      A1: await automation("לפני הגעה", T.scheduledTriggerId("check_in", "before"), 3, "10:00"),
      A2: await automation("ביום ההגעה", T.scheduledTriggerId("check_in", "on"), 0, "09:00"),
      A3: await automation("אחרי הגעה", T.scheduledTriggerId("check_in", "after"), 1, "10:00"),
      A4: await automation("לפני עזיבה", T.scheduledTriggerId("check_out", "before"), 1, "10:00"),
      A5: await automation("ביום העזיבה", T.scheduledTriggerId("check_out", "on"), 0, "09:00"),
      A6: await automation("אחרי עזיבה", T.scheduledTriggerId("check_out", "after"), 1, "11:00"),
      A7: await automation("ביום ההגעה 06:00", T.scheduledTriggerId("check_in", "on"), 0, "06:00"),
    };

    // fixture guests and bookings — no real guest data (D201 rule)
    const res = async (number, checkIn, checkOut, status, guest = {}) => {
      const [g] = await tx`
        INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, phone, language)
        VALUES (${tenantId}, 'אורח', ${number}, ${`אורח ${number}`}, ${guest.phone === undefined ? "0501234567" : guest.phone}, 'he')
        RETURNING id`;
      const [r] = await tx`
        INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status,
                                           primary_guest_id, is_test, guest_communication_opt_out)
        VALUES (${tenantId}, ${number}, ${checkIn}, ${checkOut}, ${status}, ${g.id},
                ${guest.test ?? false}, ${guest.optOut ?? false}) RETURNING id`;
      return r.id;
    };
    const d = (n) => addDays(TODAY, n);
    await res("R01", d(3), d(5), "confirmed");
    await res("R02", d(0), d(2), "confirmed");
    await res("R03", d(4), d(6), "cancelled");
    await res("R04", d(5), d(7), "checked_out");                       // stale status before arrival
    await res("R05", d(3), d(4), "confirmed", { test: true });
    await res("R06", d(6), d(8), "confirmed", { optOut: true });
    await res("R07", d(6), d(8), "confirmed", { phone: null });
    await res("R08", d(6), d(8), "confirmed", { phone: "031234567" });  // landline
    const r10 = await res("R10", d(3), d(5), "confirmed");
    await res("R11", d(0), d(1), "confirmed");                          // one night

    // R10's pre-arrival occurrence was already sent by the real engine
    const shortName = T.TRIGGERS[T.scheduledTriggerId("check_in", "before")].shortName;
    await tx`UPDATE guesthub.communication_automations SET status = 'active' WHERE id = ${ids.A1}`;
    const [sentEvent] = await tx`
      INSERT INTO guesthub.communication_events (tenant_id, event_type, aggregate_type, reservation_id, source,
                                                 occurrence_key, payload, occurred_at)
      VALUES (${tenantId}, ${T.scheduledTriggerId("check_in", "before")}, 'reservation', ${r10}, 'back_office',
              ${`reservation:${r10}:${shortName}:${ids.A1}:${d(3)}`},
              ${tx.json({ automationId: ids.A1, anchorDate: d(3), offsetDays: 3 })}, now()) RETURNING *`;
    await A.prepareDeliveriesForEvent(sentEvent);
    await tx`UPDATE guesthub.communication_automations SET status = 'draft' WHERE id = ${ids.A1}`;

    const rowOf = async (id) => (await tx`
      SELECT id, tenant_id, trigger_type, channel, template_id, template_version_policy, locked_template_version_id,
             timing_config, source_filters, conditions, exclusion_rules, recipient_config
      FROM guesthub.communication_automations WHERE id = ${id}`)[0];
    const writes = async () => (await tx`
      SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int AS n
      FROM pg_stat_xact_user_tables WHERE schemaname = 'guesthub'`)[0].n;
    const notEmitted = (reason) => reason === L.reservation_not_eligible || reason === L.test_reservation
      || (reason ?? "").startsWith("כבר");
    const verdictOf = (row) => (row.included ? "send" : row.reason);

    const previews = {};
    for (const [key, id] of Object.entries(ids)) {
      const row = await rowOf(id);
      const before = await writes();
      const preview = await P.previewScheduledAutomation({ automation: row, days: 7, now: NOW, showGuestData: true });
      eq(await writes(), before, `${key}: the preview changes no tuple (pg_stat_xact_user_tables)`);
      previews[key] = preview;

      // ---- the real pipeline, day by day, same frozen clock ----
      for (const [i, day] of preview.days.entries()) {
        const sendAt = israelInstant(day.date, row.timing_config.sendTime);
        const at = i === 0 && NOW > sendAt ? NOW : sendAt;
        await tx.unsafe("SAVEPOINT pipeline");
        await tx`UPDATE guesthub.communication_automations SET status = 'active' WHERE id = ${id}`;
        const known = (await tx`SELECT id FROM guesthub.communication_events WHERE tenant_id = ${tenantId}`).map((e) => e.id);
        await S.runScheduledTriggerScan(() => {}, { at });
        const fresh = await tx`SELECT * FROM guesthub.communication_events
                               WHERE tenant_id = ${tenantId} AND NOT (id = ANY(${known}::uuid[]))`;
        for (const event of fresh) await A.prepareDeliveriesForEvent(event);
        const outcomes = await tx`
          SELECT r.reservation_number, o.status, o.error_code, o.error_detail
          FROM guesthub.outbound_messages o JOIN guesthub.reservations r ON r.id = o.reservation_id
          WHERE o.event_id = ANY(${fresh.map((e) => e.id)}::uuid[])`;
        await tx.unsafe("ROLLBACK TO SAVEPOINT pipeline");
        const pipeline = outcomes.map((o) => `${o.reservation_number} ${o.status === "queued" ? "send"
          : o.error_code === "catch_up_window_expired" ? P.PREVIEW_CATCH_UP_EXPIRED : o.error_detail}`).sort();
        const shown = day.rows.filter((r) => !notEmitted(r.reason))
          .map((r) => `${r.reservationNumber} ${verdictOf(r)}`).sort();
        eq(shown, pipeline, `${key} ${day.date}: the preview equals what the real scheduler + engine do`);
      }
    }

    // ---- absolute expectations for the seed ----
    const at = (key, n) => previews[key].days[n].rows.map((r) => `${r.reservationNumber} ${verdictOf(r)}`).sort();
    eq(previews.A1.days.map((x) => x.date), [0, 1, 2, 3, 4, 5, 6].map(d), "seven days, today first");
    eq(at("A1", 0), ["R01 send", `R05 ${L.test_reservation}`, `R10 ${P.PREVIEW_ALREADY_SENT}`],
      "before check-in, today: R01 sends, the test booking is excluded, R10 was already sent");
    eq(at("A1", 1), [`R03 ${L.reservation_not_eligible}`], "a cancelled booking is excluded by status");
    eq(at("A1", 2), [`R04 ${L.reservation_not_eligible}`], "a stale status before arrival is excluded by status");
    eq(at("A1", 3), [`R06 ${L.guest_opted_out}`, `R07 ${L.missing_guest_phone}`, "R08 send"],
      "opt-out and a missing phone are excluded; a landline is valid to the engine (normalizePhone) so it sends");
    eq(at("A2", 0), ["R02 send", "R11 send"], "on check-in 09:00, scanned 10:30: inside the catch-up window → sends");
    eq(at("A7", 0), [`R02 ${P.PREVIEW_CATCH_UP_EXPIRED}`, `R11 ${P.PREVIEW_CATCH_UP_EXPIRED}`],
      "on check-in 06:00, scanned 10:30: past the 3-hour window → 'ידולג — עבר חלון השליחה'");
    eq(at("A3", 1), ["R02 send", `R11 ${L.outside_stay}`], "after check-in +1: R11 has already left (outside_stay)");
    eq(at("A4", 0), ["R11 send"], "before check-out −1, today");
    eq(at("A5", 1), ["R11 send"], "on check-out");
    eq(at("A6", 3), ["R02 send"], "after check-out +1");
    eq(previews.A1.days[3].rows.find((r) => r.reservationNumber === "R08")?.contact, "031-***-4567",
      "the contact is masked");
    eq(previews.A1.days[0].rows.find((r) => r.included)?.time, "10:30",
      "today inside the catch-up window: planned for now");
    eq(previews.A5.days[1].rows[0]?.time, "09:00", "a later day: planned at the send time");
    eq(Boolean(previews.A5.days[1].rows[0]?.message?.text.includes("שלום אורח")), true,
      "an included row carries the rendered published message");
    const totals = previews.A1;
    eq([totals.included, totals.excluded], [2, 6], "totals: included / excluded");

    // ---- the server action: same schema, event-based note, validation ----
    const confirmed = await C.previewAutomationAction({ triggerType: "reservation.confirmed", channel: "whatsapp",
      templateId, sources: ["back_office"], recipient: { guest: true, owner: null } });
    eq(confirmed.success && confirmed.data.kind, "event_based", "an event-based automation gets the scheduled-only note");
    const missing = await C.previewAutomationAction({ triggerType: T.scheduledTriggerId("check_out", "on"), channel: "whatsapp",
      sources: ["back_office"] });
    eq(missing.success, false, "a draft without a template is refused by the save schema");
    const draft = await C.previewAutomationAction({ triggerType: T.scheduledTriggerId("check_out", "on"), channel: "whatsapp",
      templateId, sources: ["back_office"], sendTime: "09:00", recipient: { guest: true, owner: null } });
    eq(draft.success && draft.data.kind === "scheduled" && draft.data.days.length, 7,
      "an unsaved, unnamed draft previews seven days through the action");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "preview ignores eligible statuses",
    mutations: [[PREVIEW, "if (!c.status_ok) {", "if (false) {"],
      [AUTO, ": !trigger.eligibleStatuses.includes(reservation.status)", ": false"]] },
  { name: "preview ignores outside_stay",
    mutations: [[PREVIEW, "payload: c.payload,",
      "payload: { ...c.payload, skipReason: c.payload.skipReason === \"outside_stay\" ? undefined : c.payload.skipReason },"]] },
  { name: "preview writes a row (emits the event like the scheduler)",
    mutations: [[PREVIEW, "await evaluateEventAutomations(",
      "await sql`INSERT INTO guesthub.communication_events (tenant_id, event_type, aggregate_type, reservation_id, source, occurrence_key, payload, occurred_at) VALUES (${c.tenant_id}, ${c.event_type}, ${c.aggregate_type}, ${c.reservation_id}, ${c.source}, ${c.occurrence_key}, ${sql.json(c.payload)}, now()) ON CONFLICT DO NOTHING`; await evaluateEventAutomations("]] },
  { name: "preview not marking already-sent",
    mutations: [[PREVIEW, "const handled = await alreadyHandled(c, automation.id);", "const handled = null;"]] },
  { name: "read-only scope opened read-write",
    mutations: [[DB, 'base.begin("read only", ', "base.begin("]] },
]);
await sql.end();
await globalThis.__guesthubSql?.end();
