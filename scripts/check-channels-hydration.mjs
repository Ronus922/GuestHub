// ============================================================
// /channels hydration safety checks (D71) — React error #418.
//
// THE DEFECT. The ARI card formatted timestamps in the component:
//     new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })
// with no `timeZone`. The Node server runs in UTC, the operator's browser does not,
// so the server HTML said "פעיל (10.7.2026, 8:29)" and the first client render said
// "פעיל (10.7.2026, 11:29)". React threw #418 and regenerated the subtree — which is
// why the Full Sync confirmation and progress bar could not be trusted.
//
// THE FIX. Every timestamp is formatted ONCE on the server, in the property
// timezone, and shipped inside the snapshot. The client component now contains no
// date, locale, clock or browser API in any render path. The one remaining clock
// read (the elapsed ticker) sits inside a useEffect, so it cannot run before
// hydration.
//
// This file proves BOTH halves:
//   * statically — the banned APIs are absent from the render paths;
//   * dynamically — the real component is compiled and rendered in five states
//     under three very different timezones, and the markup must be byte-identical.
//     A canary asserts the harness would have failed on the OLD code.
//
// Static + local render only: no network, no DB, no browser.
// Usage: node scripts/check-channels-hydration.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = "/var/www/guesthub";
const read = (f) => readFileSync(join(ROOT, f), "utf8");
// bans target CODE, not prose: a comment naming the defect is not the defect
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

const CARD = "src/app/(dashboard)/channels/AriSyncSection.tsx";
const PAGE = "src/app/(dashboard)/channels/page.tsx";
const ADMIN = "src/lib/channel/admin.ts";
const PROGRESS = "src/lib/channel/ari-progress.ts";
const CHANNELS_DIR = "src/app/(dashboard)/channels";

/** byte offsets of every `useEffect(` argument list, via paren matching */
function effectRegions(src) {
  const regions = [];
  let i = -1;
  while ((i = src.indexOf("useEffect(", i + 1)) !== -1) {
    let depth = 0;
    for (let j = i + "useEffect".length; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) { regions.push([i, j]); break; }
    }
  }
  return regions;
}
const insideEffect = (src, idx) => effectRegions(src).some(([a, b]) => idx > a && idx < b);

// ---- 1. no nondeterministic API in any render path of the ARI card ----
{
  const card = code(CARD);
  const banned = [
    "new Date(", "performance.now", "Math.random", "crypto.randomUUID",
    "toLocaleString", "toLocaleTimeString", "toLocaleDateString", "Intl.",
    "typeof window", "navigator.", "localStorage", "sessionStorage", "matchMedia",
    "document.",
  ];
  for (const b of banned) {
    assert.ok(!card.includes(b), `${CARD} must not use ${b} — it makes the server and client renders disagree`);
  }
  ok("the ARI card calls no date, locale, clock, storage or browser API — every value comes from the server snapshot");
}

// ---- 2. the only clock read lives inside useEffect (never during render) ----
{
  const card = code(CARD);
  const hits = [];
  let i = -1;
  while ((i = card.indexOf("Date.now()", i + 1)) !== -1) hits.push(i);
  assert.equal(hits.length, 1, "exactly one Date.now() — the elapsed ticker");
  assert.ok(insideEffect(card, hits[0]), "Date.now() is called inside useEffect, so it cannot run before hydration");
  // the ticker's initial value must be null → identical on server and first client render
  assert.ok(/useState<string \| null>\(null\)/.test(card), "the elapsed ticker starts as null, not as a computed time");
  assert.ok(/setInterval\(/.test(card), "an elapsed ticker exists");
  for (const idx of [...card.matchAll(/setInterval\(/g)].map((m) => m.index)) {
    assert.ok(insideEffect(card, idx), "every setInterval is created inside useEffect (never during render)");
  }
  ok("the elapsed ticker and the poller start only after mount; the first render never reads a clock");
}

// ---- 3. polling starts only after mount, only while a run is live, and stops ----
{
  const card = code(CARD);
  assert.ok(/if \(!running\) return/.test(card), "polling never starts unless a run is live");
  assert.ok(/clearInterval\(/.test(card), "the poller is cleared on unmount / state change");
  const fetches = [...card.matchAll(/getAriSyncStatusAction\(/g)].map((m) => m.index);
  assert.equal(fetches.length, 1, "the status is re-fetched from exactly one place");
  assert.ok(/const reload = useCallback\(async \(\) => \{/.test(card), "…and that place is the post-mount `reload` callback, not a render path");
  ok("polling begins after hydration only; it never influences the first render");
}

// ---- 4. one serialized snapshot, used verbatim for the first render ----
{
  const card = code(CARD);
  assert.ok(/useState\(initial\)/.test(card), "client state is initialized directly from the server snapshot");
  assert.ok(!/useState\(\s*\{[\s\S]*?initial/.test(card), "the snapshot is not re-derived or merged with anything at init");
  assert.ok(/initial: AriSyncStatus/.test(card), "the snapshot is a serializable prop from the Server Component");
  const page = code(PAGE);
  assert.ok(/const ari = channexConnectionId \? await getAriSyncStatusAction/.test(page),
    "the Server Component fetches the one canonical snapshot");
  assert.ok(/<AriSyncSection connectionId=\{channexConnectionId\} initial=\{ariStatus\} \/>/.test(page),
    "…and passes that exact snapshot to the client component");
  ok("one canonical server snapshot → useState(initial); no second status request, no browser-derived state");
}

// ---- 5. timestamps are formatted on the SERVER, with a fixed locale + timezone ----
{
  const admin = code(ADMIN);
  assert.ok(/const PROPERTY_TIME_ZONE = "Asia\/Jerusalem"/.test(admin), "the canonical property timezone is pinned");
  assert.ok(/new Intl\.DateTimeFormat\("he-IL", \{[\s\S]*?timeZone: PROPERTY_TIME_ZONE,?[\s\S]*?\}\)/.test(admin),
    "the server formatter fixes BOTH locale and timeZone");
  for (const f of ["lastSuccessfulSyncAt", "workerBeatAt", "startedAt", "finishedAt", "duration", "startedAtMs"]) {
    assert.ok(new RegExp(`${f}:`).test(admin), `the snapshot ships a pre-formatted \`${f}\``);
  }
  assert.ok(/runId: job\?\.id \?\? null/.test(admin), "the snapshot ships the persisted run id, so the UI can restore an active run");
  ok("every timestamp is formatted once on the server in Asia/Jerusalem and shipped as a display string");
}

// ---- 6. no Intl formatter anywhere on /channels omits an explicit timeZone ----
//        (the exact defect class — a sibling card must not reintroduce it)
{
  for (const f of readdirSync(join(ROOT, CHANNELS_DIR)).filter((x) => x.endsWith(".tsx"))) {
    const src = code(`${CHANNELS_DIR}/${f}`);
    for (const m of src.matchAll(/new Intl\.DateTimeFormat\(([\s\S]*?)\)\s*;/g)) {
      assert.ok(/timeZone:/.test(m[1]), `${f}: Intl.DateTimeFormat without an explicit timeZone renders differently on server and client`);
    }
    assert.ok(!/toLocale(String|DateString|TimeString)\(/.test(src), `${f}: toLocale*() has no fixed timezone — use the server-formatted snapshot`);
  }
  ok("no Intl.DateTimeFormat on /channels omits timeZone; no toLocale*() survives anywhere on the route");
}

// ---- 7. the escape hatches are NOT used ----
{
  for (const f of readdirSync(join(ROOT, CHANNELS_DIR)).filter((x) => x.endsWith(".tsx"))) {
    const src = code(`${CHANNELS_DIR}/${f}`);
    assert.ok(!/suppressHydrationWarning/.test(src), `${f} does not silence the hydration warning`);
    assert.ok(!/ssr:\s*false/.test(src), `${f} does not disable SSR`);
  }
  assert.ok(!/"use client"/.test(read(PAGE)), "the /channels page stays a Server Component");
  assert.ok(/export const dynamic = "force-dynamic"/.test(read(PAGE)), "…rendered per request, not from a stale cache");
  ok("no suppressHydrationWarning, no ssr:false, no client-only shell — the page is still server-rendered");
}

// ---- 8. the confirmation UI: both buttons, stable markup, no invalid nesting ----
{
  const card = code(CARD);
  assert.ok(card.includes("בצע סנכרון מלא"), "the primary confirmation button exists");
  assert.ok(card.includes("ביטול"), "the cancel button exists");
  assert.ok(!/<form/.test(card), "the confirmation is plain buttons in a div — no form, so no nested-form hydration hazard");
  const buttons = [...card.matchAll(/<button\b[\s\S]*?>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 3, "exactly three buttons: open, confirm, cancel");
  for (const b of buttons) assert.ok(/type="button"/.test(b), "every button is type=button (never a submit inside unknown markup)");
  // disabled state must be a pure function of snapshot + transition state, not the browser
  assert.ok(/const busy = pending \|\| running/.test(card), "the disabled state derives only from the snapshot and the pending transition");
  assert.ok(/const \[confirming, setConfirming\] = useState\(false\)/.test(card),
    "the confirmation starts closed on the server AND on the first client render");
  ok("both confirmation buttons render from deterministic state; no form, no nested interactive markup");
}

// ---- 9. formatDuration is pure and clock-free, and shared server↔client ----
{
  const prog = code(PROGRESS);
  assert.ok(/export function formatDuration\(ms: number\): string/.test(prog), "formatDuration takes a span, not a clock");
  assert.ok(!/Date\.now|new Date\(|performance\.now/.test(prog), "ari-progress.ts reads no clock at all");
  assert.ok(!/^import /m.test(prog), "ari-progress.ts stays import-free — nothing nondeterministic is reachable from it");
  assert.ok(code(ADMIN).includes("formatDuration"), "the server uses it for finished runs");
  assert.ok(code(CARD).includes("formatDuration"), "the client uses the same function for the live ticker");
  ok("formatDuration is pure, clock-free and shared, so a duration reads the same wherever it is rendered");
}

// ============================================================
// 10. THE REAL PROOF — compile the actual component and render it in five states
//     under three timezones. Identical markup, or this fails.
// ============================================================
{
  const OUT = join(ROOT, "node_modules/.cache/hydration-check");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // The card imports server actions we must not pull in (they reach the DB).
  // Only the *types* matter for rendering, so a stub suffices.
  writeFileSync(join(OUT, "admin-stub.ts"), `
export type AriSyncStatus = Record<string, any>;
export async function getAriSyncStatusAction(_id: string): Promise<any> { throw new Error("not called in SSR"); }
export async function requestFullSyncAction(_id: string): Promise<any> { throw new Error("not called in SSR"); }
`);
  writeFileSync(join(OUT, "ari-progress.ts"), read(PROGRESS));
  writeFileSync(
    join(OUT, "AriSyncSection.tsx"),
    read(CARD)
      .replace('"@/lib/channel/admin"', '"./admin-stub"')
      .replace('"@/lib/channel/ari-progress"', '"./ari-progress"'),
  );
  writeFileSync(join(OUT, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
      jsx: "react-jsx", strict: false, skipLibCheck: true, noEmit: false, outDir: ".",
    },
    // the cache dir lives under node_modules/, which tsc excludes by default
    include: ["AriSyncSection.tsx", "ari-progress.ts", "admin-stub.ts"],
    exclude: [],
  }));
  execFileSync("npx", ["tsc", "-p", join(OUT, "tsconfig.json")], { cwd: ROOT, stdio: "pipe" });

  // package.json has no "type":"module", so emitted .js is CJS to Node. Rename to
  // .mjs and fix the extensionless relative specifiers tsc leaves behind.
  for (const f of ["AriSyncSection", "ari-progress", "admin-stub"]) {
    const src = readFileSync(join(OUT, `${f}.js`), "utf8")
      .replace(/from "\.\/(ari-progress|admin-stub)"/g, 'from "./$1.mjs"');
    writeFileSync(join(OUT, `${f}.mjs`), src);
    rmSync(join(OUT, `${f}.js`));
  }

  writeFileSync(join(OUT, "render.mjs"), `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AriSyncSection } from "./AriSyncSection.mjs";

// Display strings are produced by the SERVER, so they are constants here — that is
// precisely the property under test.
const display = {
  lastSuccessfulSyncAt: "10.7.2026, 11:14",
  workerBeatAt: "10.7.2026, 11:29",
  startedAt: "10.7.2026, 11:20",
  finishedAt: "10.7.2026, 11:26",
  duration: "6 דק׳ 3 שנ׳",
  startedAtMs: 1783075200000,
};
const progress = (over) => ({
  runId: "run-1", phase: "projecting_rates", percent: 55, message: "מחשב מחירים והגבלות",
  startedAt: "2026-07-10T08:20:00.000Z", updatedAt: "2026-07-10T08:26:00.000Z",
  completedAt: null, failedAt: null, dateFrom: "2026-07-10", dateTo: "2027-11-22", days: 500,
  roomsTotal: 13, roomsProjected: 13, availabilitySubmitted: true, availabilityValues: 6500,
  ratePlansTotal: 52, ratePlansProjected: 30, restrictionsSubmitted: false, restrictionValues: 0,
  blocked: 0, warnings: 0, errorCategory: null, taskIds: ["11111111-2222-3333-4444-555555555555"],
  ...over,
});
const base = {
  active: false, outboundEnabled: false, fullSyncRequired: true, runId: null, display,
  fullSyncJob: null, progress: null, outcome: "running", running: false,
  lastSuccessfulSyncAt: null, pendingRanges: 0, failedRanges: 0, lastError: null,
  worker: { online: true, beatAt: "2026-07-10T08:29:00.000Z", lastDrainAt: null },
};

const STATES = {
  idle:              { ...base },
  running_no_progress: { ...base, running: true, runId: "run-1" },
  running:           { ...base, running: true, runId: "run-1", progress: progress({}) },
  completed:         { ...base, running: false, runId: "run-1", outcome: "success", active: true, outboundEnabled: true, fullSyncRequired: false,
                        progress: progress({ phase: "completed", percent: 100, restrictionsSubmitted: true, completedAt: "2026-07-10T08:26:03.000Z" }) },
  failed:            { ...base, running: false, runId: "run-1", outcome: "failed",
                        progress: progress({ phase: "failed", percent: 62, message: "החיבור נדחה", errorCategory: "unauthorized", failedAt: "2026-07-10T08:26:03.000Z" }) },
  warnings:          { ...base, running: false, runId: "run-1", outcome: "warnings",
                        progress: progress({ phase: "failed", percent: 94, warnings: 3, availabilitySubmitted: true, restrictionsSubmitted: true, failedAt: "2026-07-10T08:26:03.000Z" }) },
  partial_failure:   { ...base, running: false, runId: "run-1", outcome: "partial_failure",
                        progress: progress({ phase: "failed", percent: 80, availabilitySubmitted: true, restrictionsSubmitted: false, failedAt: "2026-07-10T08:26:03.000Z" }) },
};

const out = {};
for (const [name, initial] of Object.entries(STATES)) {
  out[name] = renderToStaticMarkup(createElement(AriSyncSection, { connectionId: "c1", initial }));
}
// canary: the OLD code path (locale formatting with no timeZone) IS timezone-sensitive,
// so this harness would have caught the original defect.
out.__canary = new Date("2026-07-10T08:29:00.000Z").toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
out.__tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
process.stdout.write(JSON.stringify(out));
`);

  const ZONES = ["UTC", "Asia/Jerusalem", "Pacific/Kiritimati"]; // UTC+0, +3, +14
  const renders = ZONES.map((tz) =>
    JSON.parse(execFileSync(process.execPath, [join(OUT, "render.mjs")], {
      cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    })),
  );

  // the harness really does observe the timezone (otherwise the test proves nothing)
  assert.equal(renders[0].__tz, "UTC");
  assert.equal(renders[1].__tz, "Asia/Jerusalem");
  assert.notEqual(renders[0].__canary, renders[1].__canary);
  ok(`the harness is timezone-sensitive: the OLD formatter yields "${renders[0].__canary}" vs "${renders[1].__canary}" — it would have failed`);

  const states = Object.keys(renders[0]).filter((k) => !k.startsWith("__"));
  assert.equal(states.length, 7, "seven snapshot states are rendered");
  for (const s of states) {
    assert.equal(renders[0][s], renders[1][s], `state "${s}" renders identically in UTC and Asia/Jerusalem`);
    assert.equal(renders[0][s], renders[2][s], `state "${s}" renders identically in UTC and Pacific/Kiritimati`);
  }
  ok("idle, running(no progress), running, completed, failed, warnings and partial_failure render byte-identically in every timezone");

  // and the rendered output is actually the card, with the right text in the right states
  assert.ok(renders[0].idle.includes("סנכרון ARI") && renders[0].idle.includes("סנכרון מלא"), "the idle card renders its Full Sync button");
  assert.ok(!renders[0].idle.includes('role="progressbar"'), "idle shows no progress bar");
  assert.ok(renders[0].running.includes('role="progressbar"') && renders[0].running.includes('aria-valuenow="55"'),
    "a live run renders a determinate bar at the persisted percentage");
  assert.ok(renders[0].running.includes("10.7.2026, 11:20"), "before mount the running panel shows the persisted start time, not an elapsed clock");
  assert.ok(!renders[0].running.includes("שנ׳"), "…and no elapsed seconds are rendered during SSR/first client render");
  assert.ok(renders[0].completed.includes('aria-valuenow="100"') && renders[0].completed.includes("סנכרון מלא הושלם"), "a clean run renders 100%");
  assert.ok(renders[0].completed.includes("6 דק׳ 3 שנ׳"), "a finished run renders the server-computed duration");
  assert.ok(renders[0].failed.includes('aria-valuenow="62"') && !renders[0].failed.includes('aria-valuenow="100"'), "a failed run freezes below 100%");
  assert.ok(renders[0].warnings.includes("אזהרות") && !renders[0].warnings.includes("סנכרון מלא הושלם"), "warnings never read as a full success");
  assert.ok(renders[0].running_no_progress.includes('aria-valuenow="0"') && renders[0].running_no_progress.includes("ממתין לעובד הרקע"),
    "a claimed-but-unstarted run renders an honest 0%");
  ok("each state renders the expected determinate content (0% / 55% / 100% / frozen failure / warnings)");

  rmSync(OUT, { recursive: true, force: true });
}

console.log(`\ncheck-channels-hydration: all ${n} assertions passed`);
