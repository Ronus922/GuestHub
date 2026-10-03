// check:history-list — D204: the send history is filtered and paged on the
// server. 100 rows per page with a total; the date filter is created_at as an
// Asia/Jerusalem calendar date (both ends inclusive); a status multi-select;
// filters combine and survive paging in the URL. Test sends never appear.
//
// Runs the REAL compiled loader against >250 seeded rows on a scratch database
// inside a rolled-back transaction, plus static checks of the table markup
// (every cell aligned under its header). Every mutant below must turn it red.
// DB-backed: connects to TEST_DATABASE_URL (action-harness connect()) — the
// suite reads this file to decide it needs its own cloned database.
import { readFileSync } from "node:fs";
import { compile, connect, inRollback, proveWithRefutation, seedTenant } from "./lib/action-harness.mjs";

// ---- static: alignment (C2) — the cell stays RTL, only the value inside is LTR ----
const shell = readFileSync("src/components/communications/CommunicationsShell.tsx", "utf8");
const panel = shell.slice(shell.indexOf("function HistoryPanel("), shell.indexOf("function PurgeHistoryDialog("));
const staticFail = [];
if (/<span className="ltr-num[^"]*" data-label=/.test(panel)) staticFail.push("a history cell is itself .ltr-num — its value would start at the cell's left edge, not under its header");
if (/gridTemplateColumns/.test(panel)) staticFail.push("the history grid must come from .gc-hist (an inline style beats the mobile card rule)");
if (!/className="gc-thead gc-hist mcard-head"/.test(panel) || !/className="gc-row gc-hist mcard-row"/.test(panel)) staticFail.push("header and rows must share .gc-hist and opt into the mobile cards");
if (!/splitRecipients\(row\.toAddress\)/.test(panel)) staticFail.push("recipients render one per line, not as a comma string");
const css = readFileSync("src/app/styles/communications.css", "utf8");
if (!/\.gc-thead\.gc-hist,\s*\.gc-row\.gc-hist\s*\{\s*grid-template-columns:/.test(css)) staticFail.push("ONE column template for the history header and rows");
if (!/\.gc-rcpts\s*\{[^}]*align-items:\s*flex-start/.test(css)) staticFail.push("each LTR address must hug its text at the inline start (.gc-rcpts align-items: flex-start), not stretch and start from the left");
if (staticFail.length) { for (const f of staticFail) console.log(`✗ ${f}`); process.exit(1); }
console.log("✓ static: cells aligned under their headers, one shared column template, recipients one per line, cards below md");

const sql = connect();
const out = compile("check-history-list", ["src/app/(dashboard)/communications/data.ts"]);
const DATA = "app/(dashboard)/communications/data.js";

async function scenario(load, stub) {
  const fail = [];
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual); const e = JSON.stringify(expected);
    if (a !== e) fail.push(`${message}\n      expected ${e}\n      actual   ${a}`);
  };
  const [D, H] = await Promise.all([load(DATA), load("lib/communications/history.js")]);
  await inRollback(sql, stub, async (tx) => {
    const { tenantId } = await seedTenant(tx, stub, "history-list");
    // 260 rows over 26 Israel days (10 a day, 13:00 Israel = 10:00Z in October),
    // statuses rotating: sent / failed / skipped / queued / delivered
    const STATUSES = ["sent", "failed", "skipped", "queued", "delivered"];
    const rows = [];
    for (let day = 0; day < 26; day += 1) for (let i = 0; i < 10; i += 1) {
      const date = new Date(Date.UTC(2026, 8, 1 + day, 10, i));
      rows.push({ tenant_id: tenantId, channel: "whatsapp", provider: "green_api", to_address: "+972500000000",
        body: "x", status: STATUSES[(day * 10 + i) % 5], delivery_type: "manual", created_at: date });
    }
    // the Israel-midnight boundary of 2026-10-01 (IDT, UTC+3): 20:59Z is still
    // Sep 30 in Israel, 21:00Z is already Oct 1 — a UTC filter gets both wrong
    rows.push({ ...rows[0], status: "failed", created_at: new Date("2026-09-30T20:59:00Z") });
    rows.push({ ...rows[0], status: "failed", created_at: new Date("2026-09-30T21:00:00Z") });
    rows.push({ ...rows[0], status: "sent", delivery_type: "test", created_at: new Date("2026-09-30T21:30:00Z") });
    for (let i = 0; i < rows.length; i += 50) await tx`INSERT INTO guesthub.outbound_messages ${tx(rows.slice(i, i + 50))}`;
    const q = (over = {}) => ({ from: null, to: null, statuses: [], page: 1, ...over });

    const p1 = await D.loadDeliveryPage(tenantId, q());
    eq([p1.total, p1.rows.length, p1.pages, p1.pageSize], [262, 100, 3, 100], "262 rows (the test send excluded): page 1 holds 100 of 3 pages");
    const p3 = await D.loadDeliveryPage(tenantId, q({ page: 3 }));
    eq([p3.rows.length, p3.page], [62, 3], "page 3 holds the remaining 62");
    eq((await D.loadDeliveryPage(tenantId, q({ page: 99 }))).page, 3, "a page past the end clamps to the last page");
    const all = [...p1.rows, ...(await D.loadDeliveryPage(tenantId, q({ page: 2 }))).rows, ...p3.rows];
    eq(new Set(all.map((r) => r.id)).size, 262, "the three pages are disjoint and cover every row");
    eq(all.every((r, i) => i === 0 || r.createdAt <= all[i - 1].createdAt), true, "newest first across pages");

    const oct1 = await D.loadDeliveryPage(tenantId, q({ from: "2026-10-01", to: "2026-10-01" }));
    eq(oct1.total, 1, "Oct 1 in Israel holds exactly the 21:00Z row (and not the 20:59Z one, nor the test send)");
    const sep30 = await D.loadDeliveryPage(tenantId, q({ from: "2026-09-30", to: "2026-09-30" }));
    eq(sep30.total, 1, "Sep 30 in Israel holds the 20:59Z row (none of the 13:00 rows fall on Sep 30: the seed ends Sep 26)");
    eq((await D.loadDeliveryPage(tenantId, q({ from: "2026-09-01", to: "2026-09-07" }))).total, 70, "a 7-day range is both ends inclusive");

    eq((await D.loadDeliveryPage(tenantId, q({ statuses: ["failed"] }))).total, 54, "status = failed (52 seeded + 2 boundary rows)");
    eq((await D.loadDeliveryPage(tenantId, q({ statuses: ["failed", "skipped"] }))).total, 106, "a status multi-select is an OR");
    const combined = await D.loadDeliveryPage(tenantId, q({ from: "2026-09-01", to: "2026-09-07", statuses: ["sent"] }));
    eq([combined.total, combined.rows.every((r) => r.status === "sent")], [14, true], "date AND status combine");

    // the URL carries the filters across pages, and only valid values survive it
    const query = { from: "2026-09-01", to: "2026-09-07", statuses: ["sent", "failed"], page: 2 };
    eq(H.parseHistoryQuery(Object.fromEntries(new URL(`https://x${H.historyHref(query)}`).searchParams)), query,
      "historyHref → parseHistoryQuery round-trips every filter and the page");
    eq(H.parseHistoryQuery({ from: "2026-02-30", to: "x", status: "sent,hacked,sent", page: "-3" }),
      { from: null, to: null, statuses: ["sent"], page: 1 }, "an invalid date, an unknown status and a bad page are dropped");
    eq(H.presetRange(7, "2026-10-03"), { from: "2026-09-27", to: "2026-10-03" }, "the 7-day preset ends today, 7 days inclusive");
    eq(H.splitRecipients("+972500000001, +972500000002"), ["+972500000001", "+972500000002"], "a two-address row splits into two lines");
  });
  return fail;
}

process.exitCode = await proveWithRefutation(out, scenario, [
  { name: "page size ignored", mutations: [[DATA, "LIMIT ${HISTORY_PAGE_SIZE} OFFSET", "LIMIT 1000 OFFSET"]] },
  { name: "UTC day boundaries", mutations: [[DATA, "::timestamp AT TIME ZONE 'Asia/Jerusalem'", "::timestamp AT TIME ZONE 'UTC'"]] },
  { name: "status filter ignored", mutations: [[DATA, "if (query.statuses.length)", "if (false)"]] },
]);
await sql.end();
