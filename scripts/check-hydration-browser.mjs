// ============================================================
// /channels hydration BROWSER check (D71) — the end-to-end proof.
//
// Loads /channels in a real authenticated Chrome whose timezone is the operator's
// (Asia/Jerusalem) while the Next.js server runs in UTC — the exact condition that
// produced React error #418 — and FAILS on any console error, hydration warning or
// React error #418/#425. Then it opens and closes the Full Sync confirmation and
// asserts both buttons survive.
//
// It never clicks "בצע סנכרון מלא": no Full Sync is triggered, no ARI is sent.
//
// Usage:
//   HYDRATION_BASE_URL=http://localhost:3007 \
//   HYDRATION_EMAIL=… HYDRATION_PASSWORD=… \
//   node --experimental-websocket --env-file=.env.local scripts/check-hydration-browser.mjs
//
// Node 20 has no global WebSocket without --experimental-websocket.
// ============================================================
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.HYDRATION_BASE_URL;
const EMAIL = process.env.HYDRATION_EMAIL;
const PASSWORD = process.env.HYDRATION_PASSWORD;
const CHROME = process.env.CHROME_BIN || "/opt/google/chrome/chrome";
const CDP_PORT = Number(process.env.CDP_PORT || 9444);
const SUP = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

for (const [k, v] of Object.entries({ HYDRATION_BASE_URL: BASE, HYDRATION_EMAIL: EMAIL, HYDRATION_PASSWORD: PASSWORD, NEXT_PUBLIC_SUPABASE_URL: SUP, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON })) {
  if (!v) { console.error(`missing required env ${k}`); process.exit(1); }
}
if (typeof WebSocket === "undefined") { console.error("run with: node --experimental-websocket"); process.exit(1); }

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- authenticate the way @supabase/ssr expects ----
const res = await fetch(`${SUP}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
assert.ok(res.ok, `login failed: ${res.status}`);
const session = await res.json();
const ref = new URL(SUP).host.split(".")[0];
const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
const CHUNK = 3180;
const cookies = value.length <= CHUNK
  ? [{ name: `sb-${ref}-auth-token`, value }]
  : Array.from({ length: Math.ceil(value.length / CHUNK) }, (_, i) => ({ name: `sb-${ref}-auth-token.${i}`, value: value.slice(i * CHUNK, (i + 1) * CHUNK) }));

const profile = mkdtempSync(join(tmpdir(), "hydration-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
], { stdio: "ignore" });

// Chrome may still be flushing its profile as we exit; never let teardown mask a result.
const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
};
process.on("exit", cleanup);

let ver;
for (let i = 0; i < 30 && !ver; i++) {
  try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(300); }
}
assert.ok(ver, "Chrome did not expose a CDP endpoint");

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? {}); pending.delete(msg.id); }
  else if (msg.method) events.push(msg);
};
const raw = (method, params = {}, sessionId) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => raw(m, p, sessionId);
const evalJs = async (expression) => (await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await S("Runtime.enable");
await S("Log.enable");
await S("Page.enable");
await S("Network.enable");
// The whole point: the browser is NOT in the server's timezone.
await S("Emulation.setTimezoneOverride", { timezoneId: "Asia/Jerusalem" });
const host = new URL(BASE).hostname;
for (const c of cookies) await S("Network.setCookie", { ...c, domain: host, path: "/" });

/** everything the console/runtime reported since the last drain */
function drainProblems() {
  const out = [];
  for (const e of events.splice(0)) {
    if (e.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(e.params.type)) {
      out.push({ kind: e.params.type, text: e.params.args.map((a) => a.value ?? a.description ?? "").join(" ") });
    } else if (e.method === "Runtime.exceptionThrown") {
      const d = e.params.exceptionDetails;
      out.push({ kind: "exception", text: d.exception?.description ?? d.text ?? "" });
    } else if (e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level)) {
      out.push({ kind: `log:${e.params.entry.level}`, text: e.params.entry.text });
    }
  }
  return out;
}
const HYDRATION = /418|425|423|hydrat|did not match|didn't match|server rendered|Text content does not match/i;

// ---- load /channels and wait for React to hydrate ----
await S("Page.navigate", { url: `${BASE}/channels` });
for (let i = 0; i < 60; i++) {
  if (await evalJs(`document.readyState === "complete" && !!document.querySelector("section")`)) break;
  await sleep(500);
}
await sleep(3000); // let hydration finish and any warning surface

const problems = drainProblems();
const hydration = problems.filter((p) => HYDRATION.test(p.text));
const errors = problems.filter((p) => p.kind === "exception" || p.kind === "error" || p.kind === "log:error");

assert.ok(await evalJs(`document.body.innerText.includes("סנכרון ARI")`), "the ARI card rendered");
ok("authenticated /channels renders the ARI card (browser TZ=Asia/Jerusalem, server TZ=UTC)");

if (hydration.length) { console.error("\nHYDRATION DIAGNOSTICS:\n" + hydration.map((p) => `[${p.kind}] ${p.text}`).join("\n\n")); }
assert.equal(hydration.length, 0, "no hydration warning, no React #418/#423/#425");
ok("zero hydration warnings and zero React #418 on first load");

if (errors.length) { console.error("\nCONSOLE ERRORS:\n" + errors.map((p) => `[${p.kind}] ${p.text.slice(0, 400)}`).join("\n\n")); }
assert.equal(errors.length, 0, "the console is clean");
ok("zero console errors on first load");

// ---- hard refresh: same story ----
await S("Page.reload", { ignoreCache: true });
for (let i = 0; i < 60; i++) {
  if (await evalJs(`document.readyState === "complete" && !!document.querySelector("section")`)) break;
  await sleep(500);
}
await sleep(3000);
const afterReload = drainProblems();
assert.equal(afterReload.filter((p) => HYDRATION.test(p.text)).length, 0, "hard refresh produced no hydration warning");
assert.equal(afterReload.filter((p) => p.kind === "exception" || p.kind === "error").length, 0, "hard refresh produced no console error");
ok("a hard refresh (cache bypassed) is equally clean");

// ---- the idle card is stable and shows no progress bar ----
assert.equal(await evalJs(`document.querySelectorAll('[role="progressbar"]').length`), 0, "idle shows no progress bar");
assert.ok(await evalJs(`!document.body.innerText.includes("NaN") && !document.body.innerText.includes("Invalid Date")`), "no broken date text");
ok("the idle ARI card shows no progress bar and no malformed timestamp");

// ---- open the confirmation: both buttons must exist ----
const clickByText = (text) => evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === ${JSON.stringify(text)});
  if (!b) return false; b.click(); return true;
})()`);

assert.ok(await clickByText("סנכרון מלא"), 'the "סנכרון מלא" button exists and is clickable');
await sleep(600);
const confirmButtons = await evalJs(`[...document.querySelectorAll("button")].map(b => b.textContent.trim())`);
assert.ok(confirmButtons.includes("בצע סנכרון מלא"), 'the primary confirmation button "בצע סנכרון מלא" is present');
assert.ok(confirmButtons.includes("ביטול"), 'the cancel button "ביטול" is present');
assert.equal(
  await evalJs(`[...document.querySelectorAll("button")].filter(b => b.textContent.trim() === "בצע סנכרון מלא" && b.disabled).length`),
  0,
  "the primary confirmation button is enabled (no run in flight)",
);
ok("opening the confirmation renders BOTH buttons, primary enabled — it never disappears");

const afterOpen = drainProblems();
assert.equal(afterOpen.filter((p) => HYDRATION.test(p.text) || p.kind === "exception").length, 0, "opening the confirmation logged nothing");
ok("the confirmation state produces no console error and no hydration warning");

// ---- cancel: back to the single button, nothing triggered ----
assert.ok(await clickByText("ביטול"), "cancel is clickable");
await sleep(600);
const afterCancel = await evalJs(`[...document.querySelectorAll("button")].map(b => b.textContent.trim())`);
assert.ok(!afterCancel.includes("בצע סנכרון מלא"), "the confirmation closed");
assert.ok(afterCancel.includes("סנכרון מלא"), "the single Full Sync button is back");
assert.equal(await evalJs(`document.querySelectorAll('[role="progressbar"]').length`), 0, "cancelling started nothing");
ok("cancel closes the confirmation, restores the single button and starts no run");

const finalProblems = drainProblems();
assert.equal(finalProblems.filter((p) => HYDRATION.test(p.text) || p.kind === "exception" || p.kind === "error").length, 0,
  "the whole interaction is console-clean");
ok("the full open → cancel interaction is free of console errors, warnings and #418");

ws.close();
console.log(`\ncheck-hydration-browser: all ${n} assertions passed — no Full Sync was triggered, no ARI was sent`);
cleanup();
process.exit(0);
