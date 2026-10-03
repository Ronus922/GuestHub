// check:history-purge — D204 "מחק היסטוריה" (owner decision 03/10/2026).
//
// Seeds terminal and active outbound rows, an occurrence the REAL pipeline
// already sent "today" (frozen clock: the scan runs at D 09:30 Israel, D =
// yesterday in real time so the run is stable at any hour), finished and
// unfinished events, and an incoming + an outgoing guest conversation. Then:
// a non-admin is refused; the REAL purge action runs; the REAL scheduler scan
// (same frozen clock), event preparation and delivery drain run again.
//   - terminal rows, their attempts and provider events are gone;
//   - active rows are intact and the due one IS sent;
//   - the already-sent occurrence is NOT re-emitted and NOT re-sent;
//   - guest conversations / messages are untouched;
//   - one audit entry carries the counts per table.
// Every mutant below must turn it red. DB-backed: connects to
// TEST_DATABASE_URL (action-harness connect()) — the suite reads this file to
// decide it needs its own cloned database.
import { compile, connect, inRollback, variant, stubs } from "./lib/action-harness.mjs";

const sql = connect();
const out = compile("check-history-purge", [
  "src/app/(dashboard)/communications/actions.ts",
  "src/lib/communications/worker.ts",
]);
const ACTIONS = "app/(dashboard)/communications/actions.js";
const PURGE = "lib/communications/purge.js";

async function scenario(load, stub, sqlMutation) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const [C, S, T, AU, O, DL, H] = await Promise.all([
    load(ACTIONS), load("lib/communications/scheduler.js"), load("lib/communications/triggers.js"),
    load("lib/communications/automation.js"), load("lib/communications/outbox.js"),
    load("lib/communications/delivery.js"), load("lib/communications/history.js"),
  ]);
  stub.audits.length = 0;
  stub.wire.length = 0;
  try { await inRollback(sql, stub, async (tx) => {
    if (sqlMutation) await tx.unsafe(sqlMutation);
    const [tenant] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES ('purge', ${`purge-${Date.now()}`}) RETURNING id`;
    const tenantId = tenant.id;
    const [user] = await tx`INSERT INTO guesthub.users (tenant_id, username) VALUES (${tenantId}, ${`op-${tenantId.slice(0, 8)}`}) RETURNING id`;
    const admin = { tenantId, userId: user.id, tenantName: "purge" };
    stub.setActor(admin);
    await tx`UPDATE guesthub.tenants SET settings = '{"messaging":{"whatsappProvider":"green_api"}}'::jsonb WHERE id = ${tenantId}`;
    await tx`INSERT INTO guesthub.messaging_provider_connections (tenant_id, provider, status, last_tested_at, secret_ciphertext)
             VALUES (${tenantId}, 'green_api', 'connected', now(), 'fixture')`;
    const wa = { channel: "whatsapp", name: "ביום ההגעה", category: "check_in", language: "he",
      content: { schemaVersion: 1, kind: "whatsapp_text", text: "שלום {{guest.first_name}}" } };
    const templateId = (await C.publishTemplateAction(wa)).id;
    const triggerType = T.scheduledTriggerId("check_in", "on");
    const saved = await C.saveAutomationAction({ name: "ביום ההגעה 09:00", triggerType, channel: "whatsapp", templateId,
      sources: ["back_office", "direct_website"], offsetDays: 0, sendTime: "09:00", activate: false,
      recipient: { guest: true, owner: null } });
    if (!saved.success) throw new Error(`automation: ${saved.error}`);
    await tx`UPDATE guesthub.communication_automations SET status = 'active' WHERE id = ${saved.id}`;

    // the frozen clock: "today" is D, the worker scans at D 09:30 Israel
    const D = H.shiftDate(H.israelToday(), -1);
    const [y, m, d] = D.split("-").map(Number);
    const AT = T.israelWallTimeToInstant(y, m, d, 9, 30);
    // fixture guests and bookings — no real guest data (D201 rule)
    const reservation = async (number, phone) => {
      const [g] = await tx`INSERT INTO guesthub.guests (tenant_id, first_name, last_name, full_name, phone, language)
        VALUES (${tenantId}, 'אורח', ${number}, ${`אורח ${number}`}, ${phone}, 'he') RETURNING id`;
      const [r] = await tx`INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status, primary_guest_id)
        VALUES (${tenantId}, ${number}, ${D}, ${H.shiftDate(D, 2)}, 'confirmed', ${g.id}) RETURNING id`;
      return r.id;
    };
    const r1 = await reservation("P01", "0501111111");
    const r2 = await reservation("P02", "0502222222");
    const r3 = await reservation("P03", "0503333333");
    // P03 holds the manual history rows only — it does not arrive on D
    await tx`UPDATE guesthub.reservations SET check_in = ${H.shiftDate(D, 10)}, check_out = ${H.shiftDate(D, 12)} WHERE id = ${r3}`;

    // ---- the real worker, frozen at AT: scan → prepare → drain ----
    const tick = async () => {
      const emitted = (await S.runScheduledTriggerScan(() => {}, { at: AT })).emitted;
      for (const event of await O.claimCommunicationEvents("guard-worker", 50)) {
        await AU.prepareDeliveriesForEvent(event);
        await O.completeCommunicationEvent(event.id, "guard-worker");
      }
      // the guard runs in ONE transaction, whose now() froze at its start; a row
      // due "now" was written a moment later — the drain runs a moment after that
      await tx`UPDATE guesthub.outbound_messages SET scheduled_at = now() - interval '1 minute'
               WHERE tenant_id = ${tenantId} AND status = 'queued' AND scheduled_at < clock_timestamp() + interval '5 minutes'`;
      await DL.drainDeliveries("guard-worker", 50);
      return emitted;
    };
    eq(await tick(), 2, "the first tick emits today's two occurrences (P01, P02)");
    const sentBefore = stub.wire.length;
    eq(sentBefore, 2, `…and the real drain sends both (${JSON.stringify(await tx`SELECT status, error_code, scheduled_at, now() AS db_now FROM guesthub.outbound_messages WHERE tenant_id = ${tenantId}`)})`);

    // ---- more history: terminal, active, chained, referenced ----
    const row = async (fields) => (await tx`
      INSERT INTO guesthub.outbound_messages ${tx({ tenant_id: tenantId, channel: "whatsapp", provider: "green_api",
        to_address: "+972500000000", body: "x", rendered_plain_text: "x", delivery_type: "manual", idempotency_key: `guard:${Math.random()}`, ...fields })}
      RETURNING id`)[0].id;
    const failed = await row({ status: "failed", reservation_id: r3, attempt_count: 2, max_attempts: 3 });
    await tx`INSERT INTO guesthub.communication_delivery_attempts (tenant_id, delivery_id, attempt_number, result)
             VALUES (${tenantId}, ${failed}, 1, 'retry_scheduled'), (${tenantId}, ${failed}, 2, 'failed_final')`;
    await tx`INSERT INTO guesthub.message_events (tenant_id, message_id, provider, event_type, dedup_key)
             VALUES (${tenantId}, ${failed}, 'green_api', 'status', ${`dk:${failed}`})`;
    await row({ status: "skipped", reservation_id: r3 });
    await row({ status: "sent", delivery_type: "test" });
    const retrying = await row({ status: "queued", reservation_id: r3, to_address: "+972503333333",
      attempt_count: 1, max_attempts: 3, scheduled_at: new Date(Date.now() - 60_000) });
    const future = await row({ status: "queued", reservation_id: r3, scheduled_at: new Date(Date.now() + 2 * 86_400_000) });
    const original = await row({ status: "failed", reservation_id: r3 });
    const resend = await row({ status: "queued", reservation_id: r3, delivery_type: "manual_resend",
      resend_of_delivery_id: original, resend_reason: "בדיקה", scheduled_at: new Date(Date.now() + 86_400_000) });
    const linked = await row({ status: "sent", reservation_id: r3 });
    const [conv] = await tx`INSERT INTO guesthub.guest_conversations (tenant_id, channel, external_thread_key)
                            VALUES (${tenantId}, 'whatsapp', 'thread-guard') RETURNING id`;
    await tx`INSERT INTO guesthub.guest_messages (tenant_id, conversation_id, direction, provider, external_message_id, body, sent_at, outbound_message_id)
             VALUES (${tenantId}, ${conv.id}, 'inbound', 'green_api', 'in-1', 'שלום', now(), NULL),
                    (${tenantId}, ${conv.id}, 'outbound', 'green_api', 'out-1', 'x', now(), ${linked})`;
    const [pendingEvent] = await tx`INSERT INTO guesthub.communication_events (tenant_id, event_type, aggregate_type, reservation_id, source, occurrence_key, payload, status, available_at)
      VALUES (${tenantId}, 'reservation.confirmed', 'reservation', ${r3}, 'back_office', 'guard:pending', '{}'::jsonb, 'pending', now() + interval '1 day') RETURNING id`;
    const [futureEvent] = await tx`INSERT INTO guesthub.communication_events (tenant_id, event_type, aggregate_type, reservation_id, source, occurrence_key, payload, status)
      VALUES (${tenantId}, ${triggerType}, 'reservation', ${r3}, 'back_office', 'guard:future',
              ${tx.json({ anchorDate: H.shiftDate(D, 30) })}, 'processed') RETURNING id`;

    const guestSnapshot = async () => (await tx`
      SELECT md5(string_agg(m.id::text || coalesce(m.outbound_message_id::text, '-') || m.body, ',' ORDER BY m.id)) AS messages,
             (SELECT md5(string_agg(c.id::text || c.updated_at::text, ',')) FROM guesthub.guest_conversations c WHERE c.tenant_id = ${tenantId}) AS conversations
      FROM guesthub.guest_messages m WHERE m.tenant_id = ${tenantId}`)[0];
    const guestsBefore = await guestSnapshot();
    const statusCounts = async () => Object.fromEntries((await tx`
      SELECT status, COUNT(*)::int AS n FROM guesthub.outbound_messages WHERE tenant_id = ${tenantId} GROUP BY 1 ORDER BY 1`).map((r) => [r.status, r.n]));
    const before = await statusCounts();

    // ---- a non-admin is refused, and nothing moves ----
    stub.setActor({ ...admin, permissions: ["communications.deliveries.view"] });
    eq((await C.getHistoryPurgePreviewAction()).success, false, "a non-admin cannot even count");
    eq((await C.purgeCommunicationHistoryAction("מחק")).success, false, "a non-admin is refused");
    stub.setActor({ ...admin, permissions: ["communications.history.purge"] });
    eq((await C.purgeCommunicationHistoryAction("מחוק")).success, false, "without the exact word מחק nothing happens");
    eq(await statusCounts(), before, "the refusals deleted nothing");

    // ---- the purge ----
    const preview = await C.getHistoryPurgePreviewAction();
    const purged = await C.purgeCommunicationHistoryAction("מחק");
    eq(purged.success, true, `the admin purge succeeds (${purged.error ?? ""})`);
    eq(preview.counts, purged.counts, "the dialog's counts are exactly what was deleted");
    // terminal: P01+P02 sent (2) + failed + skipped + test + linked(kept) + original(kept)
    eq(purged.counts, { outboundMessages: 5, deliveryAttempts: 4, messageEvents: 1, communicationEvents: 2, activeKept: 3, referencedKept: 2 },
      "counts per table: 5 outbound (2 pipeline sends, failed, skipped, test), their attempts and provider event, the 2 finished occurrences");
    eq(await statusCounts(), { failed: 1, queued: 3, sent: 1 }, "left: the active three, the resend's original and the conversation-linked row");
    const ids = (await tx`SELECT id FROM guesthub.outbound_messages WHERE tenant_id = ${tenantId}`).map((r) => r.id).sort();
    eq(ids, [retrying, future, original, resend, linked].sort(), "exactly the active rows and the referenced rows survive");
    eq((await tx`SELECT COUNT(*)::int AS n FROM guesthub.communication_delivery_attempts WHERE delivery_id = ${failed}`)[0].n, 0, "the attempts of a purged row are gone");
    eq((await tx`SELECT COUNT(*)::int AS n FROM guesthub.message_events WHERE message_id = ${failed}`)[0].n, 0, "its provider events are gone");
    const events = (await tx`SELECT id FROM guesthub.communication_events WHERE tenant_id = ${tenantId}`).map((r) => r.id).sort();
    eq(events, [pendingEvent.id, futureEvent.id].sort(), "the pending event and the future-anchor event are kept; the finished ones go");
    const ledger = (await tx`SELECT key FROM guesthub.communication_purge_ledger WHERE tenant_id = ${tenantId}`).map((r) => r.key);
    eq([ledger.filter((k) => k.startsWith("delivery:")).length, ledger.filter((k) => k.startsWith("occurrence:")).length], [5, 2],
      "the ledger holds every purged delivery key and occurrence key");
    eq((await tx`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema = 'guesthub' AND table_name = 'communication_purge_ledger'`)[0].n,
      3, "the ledger is (tenant_id, key, created_at) — no content columns");
    eq(await guestSnapshot(), guestsBefore, "guest conversations and messages are untouched (incl. the outbound_message_id link)");
    eq(stub.audits.filter((a) => a.action === "communication_history_purged").map((a) => a.after), [purged.counts],
      "one audit entry with the counts per table");

    // ---- the worker runs again, same frozen clock ----
    eq(await tick(), 0, "the scheduler does NOT re-emit today's already-sent occurrences");
    eq(stub.wire.length - sentBefore, 1, `exactly one new send — the due retry (${JSON.stringify(await tx`SELECT status, error_code, error_detail, delivery_type FROM guesthub.outbound_messages WHERE id = ${retrying}`)})`);
    eq((await tx`SELECT status FROM guesthub.outbound_messages WHERE id = ${retrying}`)[0].status === "queued", false,
      "the active retry is still there and was sent");
    eq((await tx`SELECT status FROM guesthub.outbound_messages WHERE id = ${future}`)[0].status, "queued", "the future row is still waiting");
    eq((await tx`SELECT COUNT(*)::int AS n FROM guesthub.outbound_messages WHERE reservation_id IN (${r1}, ${r2})`)[0].n, 0,
      "P01 / P02 got no new delivery row");
  }); } catch (error) { fail.push(`the scenario threw: ${error.message}`); }
  return fail;
}

const MUTANTS = [
  { name: "deleting queued rows", mutations: [[PURGE, "const TERMINAL = [...TERMINAL_STATUSES];", "const TERMINAL = [...TERMINAL_STATUSES, \"queued\"];"]] },
  { name: "skipping the ledger write", mutations: [[PURGE, "'delivery:' || o.idempotency_key", "'x:' || o.idempotency_key"],
    [PURGE, "'occurrence:' || e.event_type", "'x:' || e.event_type"]] },
  { name: "the scheduler ignores the ledger", sql: "DROP TRIGGER trg_skip_purged_event ON guesthub.communication_events" },
  { name: "deleting conversations", mutations: [[PURGE, "await tx `DELETE FROM guesthub.communication_events",
    "await tx `DELETE FROM guesthub.guest_messages WHERE tenant_id = ${tenantId}`;\n    await tx `DELETE FROM guesthub.communication_events"]] },
  { name: "no permission check", mutations: [[ACTIONS, "requirePermission(actor, \"communications.history.purge\");", ""]] },
];

const stub = await stubs(out);
let failed = false;
const real = await scenario(await variant(out), stub, null);
if (real.length) { failed = true; console.log(`✗ the real code fails ${real.length} assertion(s):`); for (const m of real) console.log(`  ✗ ${m}`); }
else console.log("✓ the real code passes every assertion");
for (const mutant of MUTANTS) {
  const caught = await scenario(await variant(out, mutant.mutations ?? []), stub, mutant.sql ?? null);
  if (caught.length) console.log(`✓ mutant "${mutant.name}" is caught (${caught.length} failing assertion(s), e.g. ${caught[0].split("\n")[0]})`);
  else { failed = true; console.log(`✗ mutant "${mutant.name}" SURVIVES`); }
}
process.exitCode = failed ? 1 : 0;
await sql.end();
