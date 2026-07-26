#!/usr/bin/env node
// ============================================================
// Rendered evidence for Booking Window V2 (docs/booking-window/shots/*).
//
// Renders the REAL shared pricing controls (src/components/reservations/
// PricingControls.tsx — the exact component both panels mount) with the REAL
// compiled Tailwind CSS + the repo's bw-* stylesheet, in headless Chrome over
// CDP (the house pattern — check-channels-fullsync-ui / check-reservations-ui:
// no server, no login). Screenshots land in docs/booking-window/shots/ and are
// committed as the fidelity evidence for SPEC step 3.
//
// Self-validating: asserts the RTL direction, the ltr-num/tabular numerals,
// the three price modes, four discount units, the VAT toggle and the balance
// boxes actually rendered before it screenshots anything.
// Usage: CHROME_BIN=/opt/google/chrome/chrome node scripts/render-pricing-evidence.mjs
// ============================================================
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const require_ = createRequire(join(ROOT, "package.json"));

// ---- 1. compile the real component graph to CJS ----
const tmp = mkdtempSync(join(tmpdir(), "gh-pricing-evidence-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    jsx: "react-jsx", esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node", "react"],
  },
  include: [join(ROOT, "src/components/reservations/PricingControls.tsx")],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

// ---- 2. bundle: micro-require over the compiled CJS + node_modules React ----
// React 19's exports map hides cjs/* subpaths — resolve each package's root
// entry and join the cjs file paths directly.
const pkgDir = (name) => dirname(require_.resolve(name));
const readMod = (p) => readFileSync(p, "utf8");
const modules = {
  "@/lib/vat": readMod(join(out, "lib/vat.js")),
  "@/lib/inventory-rules": readMod(join(out, "lib/inventory-rules.js")),
  "@/lib/pricing/totals": readMod(join(out, "lib/pricing/totals.js")),
  "./PricingControls": readMod(join(out, "components/reservations/PricingControls.js")),
  react: readMod(join(pkgDir("react"), "cjs/react.production.js")),
  "react/jsx-runtime": readMod(join(pkgDir("react"), "cjs/react-jsx-runtime.production.js")),
  "react-dom": readMod(join(pkgDir("react-dom"), "cjs/react-dom.production.js")),
  "react-dom/client": readMod(join(pkgDir("react-dom"), "cjs/react-dom-client.production.js")),
  scheduler: readMod(join(pkgDir("react-dom"), "../scheduler/cjs/scheduler.production.js")),
};
const bundle = `
window.process = { env: { NODE_ENV: "production" } };
const __mods = {};
const __defs = {};
function __require(id) {
  if (__mods[id]) return __mods[id].exports;
  const def = __defs[id];
  if (!def) throw new Error("module not found: " + id);
  const mod = (__mods[id] = { exports: {} });
  def(mod, mod.exports, __require);
  return mod.exports;
}
${Object.entries(modules).map(([id, src]) => `
__defs[${JSON.stringify(id)}] = function (module, exports, require) {
${src}
};`).join("\n")}
window.__require = __require;
`;

// ---- 3. the real CSS: Tailwind over PricingControls + repo stylesheets ----
const tailwindcss = require_("@tailwindcss/postcss");
const postcss = createRequire(require_.resolve("@tailwindcss/postcss"))("postcss");
// input.css must live under ROOT so `@import "tailwindcss"` resolves node_modules
const cssDir = join(ROOT, "node_modules/.cache/pricing-evidence");
rmSync(cssDir, { recursive: true, force: true });
mkdirSync(cssDir, { recursive: true });
const INPUT = join(cssDir, "input.css");
writeFileSync(INPUT, [
  `@import "tailwindcss" source(none);`,
  `@source "${join(ROOT, "src/components/reservations")}";`,
  `@import "${join(ROOT, "src/app/styles/base.css")}";`,
  `@import "${join(ROOT, "src/app/styles/booking-window.css")}";`,
  `@import "${join(ROOT, "src/app/styles/design-system.css")}";`,
  "",
].join("\n"));
const compiledCss = (
  await postcss([tailwindcss()]).process(readFileSync(INPUT, "utf8"), { from: INPUT })
).css;
assert.ok(compiledCss.includes("--color-primary"), "design-system tokens present");
assert.ok(compiledCss.includes(".bw-bal"), "bw-* stylesheet present");

// ---- 4. the harness page: mount the REAL controls in three states ----
const harness = `
const React = __require("react");
const { createRoot } = __require("react-dom/client");
const PC = __require("./PricingControls");
const h = React.createElement;
function Demo() {
  const [mode, setMode] = React.useState("auto");
  const [rate, setRate] = React.useState(500);
  const [mt, setMt] = React.useState(1000.01);
  const [dm, setDm] = React.useState("percent_total");
  const [dv, setDv] = React.useState(10);
  const [exempt, setExempt] = React.useState(false);
  const [cur, setCur] = React.useState("ILS");
  return h("div", { className: "flex flex-col gap-6 p-6", dir: "rtl" },
    h("section", { className: "card p-4", "data-shot": "modes" },
      h("h2", { className: "mb-3 text-sm font-bold" }, "מצבי מחיר — חדר 1 · 2 לילות"),
      h(PC.StayPriceModeControls, {
        mode, onMode: setMode, nights: 2, autoRate: 510, autoTotal: 1020,
        ratePerNight: rate, onRatePerNight: setRate,
        manualTotal: mt, onManualTotal: setMt, canPriceOverride: true,
      })),
    h("section", { className: "card p-4", "data-shot": "discount" },
      h("h2", { className: "mb-3 text-sm font-bold" }, "הנחה"),
      h(PC.DiscountControls, { mode: dm, value: dv, onChange: (m, v) => { setDm(m); setDv(v); } })),
    h("section", { className: "card p-4", "data-shot": "vat-balance" },
      h(PC.VatToggleRow, { vatRate: 18, grandTotal: 918, taxExempt: exempt, onToggle: setExempt }),
      h("div", { className: "mt-3" }, h(PC.BalanceBoxes, { total: 918, paid: 300 })),
      h("div", { className: "mt-3" }, h(PC.CurrencySelector, { currencies: ["ILS", "USD", "EUR"], value: cur, onChange: setCur }))),
  );
}
createRoot(document.getElementById("root")).render(h(Demo));
`;
const page = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<style>${compiledCss}</style>
<style>body{background:var(--color-appbg);margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}</style>
</head><body><div id="root"></div>
<script>${bundle}</script>
<script>${harness}</script>
</body></html>`;
const pagePath = join(tmp, "evidence.html");
writeFileSync(pagePath, page);

// ---- 5. drive headless Chrome over raw CDP (house pattern) ----
const CHROME = process.env.CHROME_BIN || "/opt/google/chrome/chrome";
const PORT = Number(process.env.CDP_PORT || 9457);
const profile = mkdtempSync(join(tmpdir(), "gh-evidence-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });
try {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i++) {
    await new Promise((r) => setTimeout(r, 200));
    targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => null);
  }
  assert.ok(targets?.length, "Chrome CDP is up");
  const target = targets.find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const cmd = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await cmd("Page.enable");
  await cmd("Runtime.enable");

  const shoot = async (width, name) => {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: width < 500 });
    await cmd("Page.navigate", { url: "file://" + pagePath });
    await new Promise((r) => setTimeout(r, 1200));
    const { result } = await cmd("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const q = (s) => document.querySelectorAll(s).length;
        return {
          radiogroups: q('[role=radiogroup]'),
          modeButtons: q('[aria-label="מצב מחיר"] [role=radio]'),
          discountUnits: q('[aria-label="יחידת הנחה"] [role=radio]'),
          vatSwitch: q('[role=switch]'),
          balanceBoxes: q('.bw-bal'),
          ltrNums: q('.ltr-num'),
          rtl: document.documentElement.dir === 'rtl',
          currency: q('[aria-label="מטבע"]'),
        };
      })()`,
    });
    const v = result.value;
    assert.equal(v.rtl, true, "page renders RTL");
    assert.equal(v.modeButtons, 3, "three price modes rendered");
    assert.equal(v.discountUnits, 4, "four discount units rendered");
    assert.equal(v.vatSwitch, 1, "the VAT toggle rendered");
    assert.equal(v.balanceBoxes, 3, "three balance boxes rendered");
    assert.ok(v.ltrNums >= 3, "numeric values render ltr-num");
    assert.equal(v.currency, 1, "the currency selector rendered");
    const shot = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const outPath = join(ROOT, "docs/booking-window/shots", name);
    writeFileSync(outPath, Buffer.from(shot.data, "base64"));
    console.log(`✓ ${name} (${width}px) — controls verified + captured`);
  };

  mkdirSync(join(ROOT, "docs/booking-window/shots"), { recursive: true });
  await shoot(1024, "impl-pricing-controls-desktop.png");
  await shoot(390, "impl-pricing-controls-mobile.png");
  ws.close();
} finally {
  chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
console.log("\nrendered evidence written to docs/booking-window/shots/");
