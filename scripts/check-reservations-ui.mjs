// ============================================================
// /reservations list — the visible-number rule AND the unified tab bar.
//
// 1. The page shows exactly ONE reservation number per row (מס׳ הזמנה):
//    the OTA code when the channel supplied one, else the internal #number.
//    The internal id stays the identity for opening/editing/keys. The real
//    feature is Reservations — no Orders route/page/component may appear.
// 2. The tab bar is ONE bar, ONE selection, ONE URL param: lifecycle tabs and
//    the former "quick filters" are the same control. It never renders two
//    rows, never two active tabs, never a removed/duplicate label.
//
// Mostly static source assertions in the house style (see
// check-status-default.mjs). The layout rules that only exist at render time
// (one row · one active tab · canonical blue active style) are measured in a
// real headless Chrome against the REAL CSS — no server or login needed: the
// bar is rendered standalone from the actual tab config + design-system.css +
// reservations-list.css. Chrome missing → those checks SKIP loudly, they never
// pass silently.
// Usage: node scripts/check-reservations-ui.mjs
// ============================================================
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const read = (p) => readFileSync(p, "utf8");

const SCREEN = "src/app/(dashboard)/reservations/ReservationsScreen.tsx";
const PAGE = "src/app/(dashboard)/reservations/page.tsx";
const DATA = "src/app/(dashboard)/reservations/data.ts";
const HELPER = "src/lib/reservations/visible-number.ts";

// ---- 1. the production route is /reservations; no Orders surface exists ----
assert.ok(existsSync(PAGE), "the canonical Reservations route must exist");
const page = read(PAGE);
assert.match(page, /ReservationsScreen/, "the route must render ReservationsScreen");

const badNames = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (/^orders$/i.test(e)) badNames.push(p);
      walk(p);
    } else if (/^orders(page|screen)?\.(ts|tsx)$/i.test(e)) badNames.push(p);
  }
})("src");
assert.deepEqual(badNames, [], "no Orders route/page/component may exist");
for (const forbidden of ["OrdersPage", "OrdersScreen", "OrdersTable", "ReservationsV2"]) {
  assert.ok(!read(SCREEN).includes(forbidden) && !page.includes(forbidden),
    `${forbidden} must not exist — the feature is Reservations`);
}
ok("route is /reservations; no Orders route, page or parallel component");

// ---- 2. the fallback rule is real: run it ----
// Strip the (tiny, known) type annotations and execute the actual source, so
// the rule is verified by behavior, not by reading comments.
const helperSrc = read(HELPER);
const fnSrc = helperSrc
  .match(/export function getVisibleReservationNumber[\s\S]*\n\}/)?.[0]
  ?.replace(/\(r: \{[\s\S]*?\}\): string \{/, "(r) {")
  ?.replace(/^export /, "");
assert.ok(fnSrc && !fnSrc.includes("): string"), "could not extract a runnable helper — update this check");
const getVisible = new Function(`${fnSrc}; return getVisibleReservationNumber;`)();
assert.equal(getVisible({ reservation_number: "1071", ota_reservation_code: "6508475478" }),
  "6508475478", "an OTA reservation must show the OTA code only");
assert.equal(getVisible({ reservation_number: "1071", ota_reservation_code: null }),
  "#1071", "a direct reservation must fall back to the internal number");
assert.equal(getVisible({ reservation_number: "1071", ota_reservation_code: "  " }),
  "#1071", "a blank OTA code must fall back to the internal number");
ok("visible-number rule behaves: OTA code first, internal #number fallback");

// ---- 3. the screen consumes ONLY the helper — never a second number ----
const screen = read(SCREEN);
assert.ok(!screen.includes("row.ota_reservation_code"),
  "the screen must not render the OTA code directly — only via the helper");
assert.ok(!screen.includes("row.reservation_number"),
  "the screen must not render the internal number directly — only via the helper");
assert.ok(!/rl-otacode|rv-otacode/.test(screen),
  "the secondary OTA-code line must not return");
const headerCount = screen.split("מס׳ הזמנה").length - 1;
assert.equal(headerCount, 1, "exactly ONE reservation-number column header");
// desktop and mobile render through the SAME row markup — the helper is called
// once for sorting and once in the single number cell.
const calls = screen.split("getVisibleReservationNumber(").length - 1;
assert.equal(calls, 2, "one sort usage + one visible cell — no duplicated fallback logic");
ok("one מס׳ הזמנה column; helper is the only number source (desktop = mobile)");

// ---- 4. the internal identity still drives everything ----
assert.match(screen, /key=\{row\.id\}/, "React keys stay on the internal id");
assert.match(screen, /setPanelId\(row\.id\)/, "row click opens by the internal id");
assert.match(screen, /reservationId=\{panelId\}/, "the SidePanel receives the internal id");
const data = read(DATA);
assert.match(data, /res\.ota_reservation_code/, "the read model must keep the existing OTA field");
assert.ok(!data.includes("visible-number"),
  "the DB layer must not depend on the presentation rule");
ok("internal id remains the identity for keys, opening and editing");

// ---- 5. no schema or import changes rode along ----
assert.ok(!/ALTER TABLE|CREATE TABLE|ADD COLUMN/i.test(data),
  "the read model must not carry schema changes");
const importer = "src/lib/channel/booking-import.ts";
if (existsSync(importer)) {
  assert.ok(!read(importer).includes("visible-number"),
    "channel ingestion must not know about the presentation rule");
}
ok("no schema change; ingestion untouched by the presentation rule");

// ---- 6. canonical primitives ----
for (const cls of ["card", "chip chip-neutral", "field-input", "empty-state", "ltr-num"]) {
  assert.ok(screen.includes(cls), `the screen must use the canonical .${cls}`);
}
assert.match(screen, /<Icon\b/, "icons come from the ONE <Icon> component");
ok("screen is built from canonical design-system primitives");

// ============================================================
// The unified tab bar
// ============================================================

// ---- 7. ONE bar, ONE tab config, rendered in the approved order ----
const barCount = screen.split("rv-tabsbar").length - 1;
assert.equal(barCount, 1, "exactly ONE tab bar may be rendered — never a second toolbar");
assert.ok(!screen.includes("rv-tabdiv"),
  "no divider: the bar must read as one continuous control, not two groups");

const cfg = screen.match(/const TAB_ITEMS[\s\S]*?\n\];/)?.[0];
assert.ok(cfg, "could not find the TAB_ITEMS config — update this check");
const items = [...cfg.matchAll(/\{ key: "([a-z_0-9]+)", label: "([^"]+)"/g)]
  .map(([, key, label]) => ({ key, label }));

const EXPECTED = [
  ["all", "הכל"],
  ["inhouse", "שוהים"],
  ["cancelled", "בוטלו"],
  ["noshow", "לא הגיעו"],
  ["created24", "נוצרו ב־24 שעות"],
  ["arrivals", "הגעות היום"],
  ["departures", "עזיבות היום"],
  ["cancelled24", "בוטלו ב־24 השעות האחרונות"],
  ["unpaid", "לא שולמו"],
  ["partial", "שולם חלקית"],
  ["pending", "ממתינות לאישור"],
  ["missing_docs", "חסר מסמכים"],
  ["invalid_card", "כרטיס לא עבר"],
];
assert.deepEqual(items.map((i) => [i.key, i.label]), EXPECTED,
  "the unified bar must render exactly these tabs, in this RTL order");

// no item twice — neither by key nor by label. "שוהים" had a lifecycle tab AND
// a quick-filter chip; exactly one may survive.
assert.equal(new Set(items.map((i) => i.key)).size, items.length, "no tab key may repeat");
assert.equal(new Set(items.map((i) => i.label)).size, items.length, "no tab label may repeat");
assert.equal(items.filter((i) => i.label === "שוהים").length, 1, "'שוהים' must appear exactly once");
ok(`one bar, ${items.length} tabs, approved order; 'שוהים' rendered exactly once`);

// ---- 8. removed items stay removed; the rename sticks ----
for (const gone of ["מאושרות", "עזבו", "מועמדי No-show", "בוטלו היום", "בוטלו ביממה האחרונה"]) {
  assert.ok(!screen.includes(gone), `the removed tab "${gone}" must not return`);
}
for (const goneKey of ["confirmed", "out", "noshow_candidates", "cancelled_today", "arrivals24"]) {
  assert.ok(!new RegExp(`key: "${goneKey}"`).test(screen) && !new RegExp(`"${goneKey}"`).test(read(DATA)),
    `the obsolete tab key "${goneKey}" must be gone from the config AND the read model`);
}
assert.ok(screen.includes("בוטלו ב־24 השעות האחרונות"), "the renamed cancelled-24h tab must be present");
ok("obsolete tabs removed from config + read model; cancelled-24h renamed");

// ---- 9. ONE state: no second filter axis can be active ----
// The proof is structural: there is no second filter field to hold a value.
assert.ok(!/\bquick\b/.test(read(PAGE)) || !/p\.quick/.test(read(PAGE)),
  "the route must not parse a second (quick) filter param");
assert.ok(!/quick:/.test(screen) && !/filters\.quick/.test(screen),
  "the screen must not keep a second quick-filter state");
assert.ok(!/QuickFilter|quickCounts/.test(read(DATA)),
  "the read model must not keep a second quick-filter axis");
assert.match(screen, /onClick=\{\(\) => apply\(\{ tab: t\.key \}\)\}/,
  "clicking a tab must REPLACE the selection (one canonical ?tab= param)");
// one predicate map feeds both the rows and the badges — no parallel count path
const dataSrc = read(DATA);
assert.match(dataSrc, /function tabPredicates/, "one predicate map must resolve every tab");
assert.match(dataSrc, /AND \(\$\{tab\}\)/, "the list must be filtered by that same predicate");
assert.match(dataSrc, /COUNT\(\*\) FILTER \(WHERE \$\{P\.inhouse\}\)/,
  "badges must be counted from the SAME predicate that filters the list");
assert.equal(dataSrc.split("res.status = 'checked_in'").length - 1, 1,
  "'שוהים' must have exactly ONE predicate — no separately calculated count");
// the rolling window is real, not "since midnight"
assert.match(dataSrc, /cancelled_at > now\(\) - interval '24 hours'/,
  "בוטלו ב־24 השעות האחרונות must use a rolling now()-24h boundary");
assert.ok(!/cancelled_at AT TIME ZONE .*::date = /.test(dataSrc),
  "the cancelled-24h tab must not fall back to a since-midnight predicate");
ok("one tab state; one predicate per tab feeds both rows and badges; rolling 24h");

// ---- 10. RENDER: one row, one active tab, canonical blue active style ----
// Measured in a real browser against the real CSS — the only honest test of
// "does the bar wrap at the desktop viewport".
const CHROME = process.env.CHROME_BIN || "/opt/google/chrome/chrome";
if (!existsSync(CHROME)) {
  console.log(`\n  ⚠ SKIPPED the render checks — no Chrome at ${CHROME} (set CHROME_BIN)`);
  console.log(`\ncheck-reservations-ui: ${n} groups passed (render checks skipped) ⚠`);
  process.exit(0);
}

const ICON_STUB = "•";
const tabsHtml = items
  .map((i, idx) =>
    `<button class="btn rv-tab ${idx === 0 ? "btn-primary" : "btn-tertiary"}">` +
    `<span class="ms-icon">${ICON_STUB}</span>${i.label}` +
    `<span class="chip chip-neutral ltr-num">${10 + idx}</span></button>`,
  )
  .join("");

// The real content width of the bar on a 1440px desktop: viewport minus the
// dashboard sidebar (~254px) minus the page's 26px inline padding on both sides.
const CONTENT_W = 1440 - 254 - 52;
const html = `<!doctype html><html dir="rtl"><head><meta charset="utf-8">
<style>${read("src/app/styles/design-system.css").replace(/@layer components\s*\{/, "").replace(/\}\s*$/, "")}</style>
<style>${read("src/app/styles/reservations-list.css").replace(/@layer components\s*\{/, "").replace(/\}\s*$/, "")}</style>
<style>*{box-sizing:border-box}body{margin:0;font-family:sans-serif}
#w{width:${CONTENT_W}px}.ms-icon{font-size:17px;width:17px;height:17px;display:inline-flex}</style>
</head><body><div id="w"><div class="rv-tabsbar">${tabsHtml}</div></div></body></html>`;

const dir = mkdtempSync(join(tmpdir(), "res-tabbar-"));
const file = join(dir, "bar.html");
writeFileSync(file, html);
const profile = mkdtempSync(join(tmpdir(), "res-tabbar-chrome-"));
const PORT = Number(process.env.CDP_PORT || 9455);
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = async () => {
  chrome.kill();
  await sleep(300); // Chrome keeps writing its profile for a beat after SIGTERM
  const drop = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try { drop(dir); drop(profile); } catch { /* a temp dir left behind must never fail the check */ }
};

try {
  let ver;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  assert.ok(ver, "Chrome did not expose a CDP endpoint");

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? {}); pending.delete(msg.id); }
  };
  const raw = (method, params = {}, sessionId) =>
    new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => raw(m, p, sessionId);
  const evalJs = async (expression) =>
    (await S("Runtime.evaluate", { expression, returnByValue: true })).result?.value;

  await S("Page.enable");
  await S("Page.navigate", { url: `file://${file}` });
  for (let i = 0; i < 40; i++) {
    if (await evalJs(`document.readyState === "complete" && !!document.querySelector(".rv-tab")`)) break;
    await sleep(200);
  }

  const m = await evalJs(`(() => {
    const bar = document.querySelector(".rv-tabsbar");
    const tabs = [...document.querySelectorAll(".rv-tab")];
    const cs = getComputedStyle(bar);
    const active = tabs.filter((t) => getComputedStyle(t).backgroundColor === "rgb(37, 64, 200)");
    return {
      tabs: tabs.length,
      rows: new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size,
      barHeight: Math.round(bar.getBoundingClientRect().height),
      tabHeights: [...new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().height)))],
      wrap: cs.flexWrap,
      overflowX: cs.overflowX,
      scrolls: bar.scrollWidth > bar.clientWidth,
      escapes: tabs.some((t) => {
        const b = bar.getBoundingClientRect(), r = t.getBoundingClientRect();
        return r.top < b.top - 1 || r.bottom > b.bottom + 1;
      }),
      activeCount: active.length,
      activeColor: active[0] ? getComputedStyle(active[0]).color : null,
      radii: [...new Set(tabs.map((t) => getComputedStyle(t).borderRadius))],
      fonts: [...new Set(tabs.map((t) => getComputedStyle(t).fontSize + "/" + getComputedStyle(t).fontWeight))],
      badges: document.querySelectorAll(".rv-tab .chip.chip-neutral").length,
    };
  })()`);

  assert.equal(m.tabs, items.length, "every configured tab must render");
  assert.equal(m.rows, 1, `the bar must stay on ONE row at the desktop viewport — measured ${m.rows} rows`);
  assert.equal(m.wrap, "nowrap", "the bar must never wrap");
  assert.equal(m.overflowX, "auto", "overflow must be controlled scrolling inside the bar");
  assert.ok(!m.escapes, "no tab may overlap or escape its container");
  // 44px control + 5px padding top/bottom + 2px border ≈ 56px. A wrapped second
  // row would roughly double this — the height is the wrap canary.
  assert.ok(m.barHeight <= 60, `the bar must not grow a second row (height ${m.barHeight}px)`);
  assert.deepEqual(m.tabHeights, [44], "every tab is the same canonical 44px control (§4)");
  assert.equal(m.radii.length, 1, "every tab shares one radius");
  assert.equal(m.fonts.length, 1, "every tab shares one typography");
  assert.equal(m.badges, items.length, "every tab keeps its count badge");
  assert.equal(m.activeCount, 1, "exactly ONE tab may be active at a time");
  assert.equal(m.activeColor, "rgb(255, 255, 255)", "the active tab is solid brand blue with white text");
  ok(`render: ${m.tabs} tabs on ${m.rows} row (${m.barHeight}px), ${m.scrolls ? "scrolls inside the bar" : "fits"}, 1 active, canonical blue`);
} finally {
  await cleanup();
}

console.log(`\ncheck-reservations-ui: ${n} groups passed ✔`);
