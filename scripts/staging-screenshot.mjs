// ============================================================
// Authenticated STAGING screenshot driver (D97).
//
// The three UI tasks of 2026-07-24 were all blocked by the same wall: every
// screen sits behind the auth middleware, and the only known way to mint a
// session pointed at PRODUCTION Supabase auth. This script is the unblock: it
// mints a session against the STAGING GoTrue (see docs/STAGING_UI_VERIFICATION.md),
// installs it as the @supabase/ssr cookie, drives headless Chrome over CDP and
// writes a PNG.
//
// It REFUSES to run against anything but a loopback app and a loopback auth
// endpoint — it can never authenticate against production by accident.
//
// Usage:
//   HYDRATION_BASE_URL=http://127.0.0.1:3017 \
//   HYDRATION_EMAIL=… HYDRATION_PASSWORD=… \
//   node --experimental-websocket --env-file=.env.local scripts/staging-screenshot.mjs \
//     --url /rooms --out docs/screenshots/rooms.png \
//     [--wait-text "…"] [--script "<js run in the page before capture>"]
//     [--clip "<css selector to crop to>"] [--width 1440] [--height 1000] [--settle 2500]
//
// Node 20 has no global WebSocket without --experimental-websocket.
// ============================================================
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};

const BASE = process.env.HYDRATION_BASE_URL;
const EMAIL = process.env.HYDRATION_EMAIL;
const PASSWORD = process.env.HYDRATION_PASSWORD;
const SUP = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const CHROME = process.env.CHROME_BIN || "/opt/google/chrome/chrome";
const CDP_PORT = Number(process.env.CDP_PORT || 9455);

for (const [k, v] of Object.entries({ HYDRATION_BASE_URL: BASE, HYDRATION_EMAIL: EMAIL, HYDRATION_PASSWORD: PASSWORD, NEXT_PUBLIC_SUPABASE_URL: SUP, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON })) {
  if (!v) { console.error(`missing required env ${k}`); process.exit(1); }
}
if (typeof WebSocket === "undefined") { console.error("run with: node --experimental-websocket"); process.exit(1); }

// --- fail-closed: staging only. Production auth must be unreachable from here. ---
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
for (const [label, u] of [["HYDRATION_BASE_URL", BASE], ["NEXT_PUBLIC_SUPABASE_URL", SUP]]) {
  const host = new URL(u).hostname;
  if (!LOOPBACK.includes(host)) {
    console.error(`ABORT: ${label} host "${host}" is not loopback — this driver runs against STAGING only.`);
    process.exit(2);
  }
}

const PATH_ = arg("url", "/");
const OUT = resolve(arg("out", "docs/screenshots/shot.png"));
const WAIT_TEXT = arg("wait-text", null);
const SCRIPT = arg("script", null);
const CLIP = arg("clip", null);
const WIDTH = Number(arg("width", 1440));
const HEIGHT = Number(arg("height", 1000));
const SETTLE = Number(arg("settle", 2500));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mint the session the way @supabase/ssr stores it ----
const res = await fetch(`${SUP}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const body = await res.text();
assert.ok(res.ok, `staging login failed: ${res.status} ${body}`);
const session = JSON.parse(body);
// @supabase/ssr names the cookie after the project ref = first label of the
// Supabase host. Staging is "127.0.0.1", so the ref is "127" — unusual-looking
// but it is exactly what the browser client computes, which is what matters.
const ref = new URL(SUP).host.split(".")[0];
const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
const CHUNK = 3180;
const cookies = value.length <= CHUNK
  ? [{ name: `sb-${ref}-auth-token`, value }]
  : Array.from({ length: Math.ceil(value.length / CHUNK) }, (_, i) => ({ name: `sb-${ref}-auth-token.${i}`, value: value.slice(i * CHUNK, (i + 1) * CHUNK) }));

const profile = mkdtempSync(join(tmpdir(), "staging-shot-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", "--font-render-hinting=none",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
], { stdio: "ignore" });
const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch {}
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
};
process.on("exit", cleanup);

let ver;
for (let i = 0; i < 40 && !ver; i++) {
  try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await sleep(300); }
}
assert.ok(ver, "Chrome did not expose a CDP endpoint");

const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const consoleErrors = [];
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? {}); pending.delete(msg.id); }
  else if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? "");
};
const raw = (method, params = {}, sessionId) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => raw(m, p, sessionId);
const evalJs = async (expression) => (await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await S("Runtime.enable");
await S("Page.enable");
await S("Network.enable");
await S("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
await S("Emulation.setTimezoneOverride", { timezoneId: "Asia/Jerusalem" });
const host = new URL(BASE).hostname;
for (const c of cookies) await S("Network.setCookie", { ...c, domain: host, path: "/" });

const target = `${BASE}${PATH_}`;
await S("Page.navigate", { url: target });
for (let i = 0; i < 80; i++) {
  if (await evalJs(`document.readyState === "complete"`)) break;
  await sleep(250);
}
await sleep(SETTLE);

// The proof the session actually took: the middleware bounces every
// unauthenticated request to /login, so landing anywhere else means authenticated.
const landed = await evalJs("location.pathname");
assert.notEqual(landed, "/login", `NOT AUTHENTICATED — the app redirected to /login (asked for ${PATH_})`);

if (WAIT_TEXT) {
  let seen = false;
  for (let i = 0; i < 40; i++) {
    if (await evalJs(`document.body.innerText.includes(${JSON.stringify(WAIT_TEXT)})`)) { seen = true; break; }
    await sleep(500);
  }
  assert.ok(seen, `timed out waiting for text: ${WAIT_TEXT}`);
}

if (SCRIPT) {
  const r = await evalJs(`(async () => { ${SCRIPT} })()`);
  if (r === false) { console.error("the --script step returned false (its target was not found)"); process.exit(1); }
  await sleep(SETTLE);
}

// RTL evidence, asserted rather than eyeballed.
const dir = await evalJs(`document.documentElement.getAttribute("dir")`);
const lang = await evalJs(`document.documentElement.getAttribute("lang")`);
const hebrew = await evalJs(`/[\\u0590-\\u05FF]/.test(document.body.innerText)`);
assert.equal(dir, "rtl", `expected <html dir="rtl">, got ${dir}`);
assert.ok(hebrew, "expected Hebrew text in the rendered page");

let clip;
if (CLIP) {
  clip = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(CLIP)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const pad = 16;
    return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2, scale: 2 };
  })()`);
  assert.ok(clip, `--clip selector matched nothing: ${CLIP}`);
  await sleep(400);
}

const shot = await S("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : { captureBeyondViewport: false }) });
assert.ok(shot.data, "Chrome returned no image data");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));

console.log(`✓ ${OUT}`);
console.log(`  url=${target} landed=${landed} html[dir]=${dir} html[lang]=${lang} hebrew=${hebrew}`);
if (consoleErrors.length) console.log(`  note: ${consoleErrors.length} page exception(s) — first: ${consoleErrors[0].slice(0, 160)}`);
ws.close();
cleanup();
process.exit(0);
