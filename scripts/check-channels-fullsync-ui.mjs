// ============================================================
// /channels Full Sync UI checks (D72) — the invisible-primary-button defect.
//
// THE DEFECT. The confirmation's primary button was classed `bg-brand`, but the
// design system defines no `--color-brand` token (the brand color is
// `--color-primary`). Tailwind v4 generates utilities ONLY from @theme tokens,
// so `.bg-brand` was silently absent from the compiled CSS and the button
// rendered as WHITE TEXT ON A TRANSPARENT BACKGROUND on the white card —
// present in the DOM (so DOM/a11y checks passed), invisible to the operator.
//
// THE PROOF. This script compiles the REAL Tailwind pipeline (the project's own
// tailwindcss + @theme tokens) over the /channels route and asserts that every
// color-capable utility class referenced by the components was actually
// generated. An unresolvable token — `bg-brand`, or any future typo — fails.
// A canary asserts the harness rejects the original defective class.
//
// Also verified here (Full Sync flow contract, D68/D69/D72):
//   · confirmation renders BOTH buttons; cancel touches no server action
//   · the creation response's runId enters state IMMEDIATELY (no wait for the
//     first status fetch) and the progress area lives inside the ARI section
//   · the server action returns the persisted run id, never a fabricated one
//
// Static + local compile only: no network, no DB, no browser.
// Usage: node scripts/check-channels-fullsync-ui.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = "/var/www/guesthub";
const CHANNELS_DIR = "src/app/(dashboard)/channels";
const CARD = `${CHANNELS_DIR}/AriSyncSection.tsx`;
const ADMIN = "src/lib/channel/admin.ts";

const read = (f) => readFileSync(join(ROOT, f), "utf8");
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

// ---- compile the real Tailwind CSS for the /channels route ----
const require_ = createRequire(join(ROOT, "package.json"));
const postcss = require_("postcss");
const tailwindcss = require_("@tailwindcss/postcss");

const CACHE = join(ROOT, "node_modules/.cache/fullsync-ui-check");
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
const INPUT = join(CACHE, "input.css");
writeFileSync(INPUT, [
  `@import "tailwindcss" source(none);`,
  `@source "../../../src/app/(dashboard)/channels";`,
  `@import "../../../src/app/styles/base.css";`,
  "",
].join("\n"));

const compiled = (
  await postcss([tailwindcss()]).process(readFileSync(INPUT, "utf8"), { from: INPUT })
).css;
assert.ok(compiled.includes("--color-primary"), "the design-system tokens are in the compiled CSS");

// a used class resolves iff Tailwind emitted its (escaped) selector
const esc = (cls) => cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
const resolves = (cls) => compiled.includes(`.${esc(cls)}`);

// color-capable utilities: exactly the class of the defect. A non-arbitrary
// suffix must resolve to a generated rule; `bg-[#fff]`-style literals resolve
// by construction and are checked too.
const COLOR_UTILITY = /^((?:[a-z-]+:)*)(bg|text|border|divide|ring|fill|stroke|from|via|to|caret|accent|outline|decoration|placeholder)-[a-z[]/;

/** every whitespace-separated token inside quoted/backtick string literals */
function classCandidates(src) {
  const tokens = new Set();
  for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    const lit = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, " ");
    for (const t of lit.split(/\s+/)) {
      if (t && COLOR_UTILITY.test(t)) tokens.add(t);
    }
  }
  return [...tokens];
}

// ---- 1. every color-capable class on the /channels route resolves ----
{
  const unresolved = [];
  for (const f of readdirSync(join(ROOT, CHANNELS_DIR)).filter((x) => x.endsWith(".tsx"))) {
    for (const cls of classCandidates(code(`${CHANNELS_DIR}/${f}`))) {
      if (!resolves(cls)) unresolved.push(`${f}: ${cls}`);
    }
  }
  assert.deepEqual(unresolved, [],
    `classes that resolve to NO generated CSS rule (invisible styling): ${unresolved.join(", ")}`);
  ok("every color-capable utility class on /channels resolves to a real generated CSS rule");
}

// ---- 2. canary: the harness rejects the ORIGINAL defective class ----
{
  assert.equal(resolves("bg-brand"), false,
    "bg-brand must NOT resolve — if it ever does, this harness stopped proving anything");
  const candidates = classCandidates(`<button className="rounded-xl bg-brand px-4 py-2 text-white" />`);
  assert.ok(candidates.includes("bg-brand") && candidates.includes("text-white"),
    "the extractor sees the defective class exactly as it appeared in production");
  ok("canary: the original `bg-brand` is rejected by this harness — it would have failed pre-fix");
}

// ---- 3. the primary button is the REAL, visibly-painted action ----
{
  const card = code(CARD);
  const primary = card.match(/<button\b[^>]*className="([^"]*)"[^>]*>\s*בצע סנכרון מלא/s)
    ?? card.match(/<button\b[\s\S]{0,400}?className="([^"]*)"[\s\S]{0,200}?בצע סנכרון מלא/);
  assert.ok(primary, "the primary confirmation button exists with a literal className");
  const classes = primary[1].split(/\s+/);
  const bg = classes.find((c) => /^bg-/.test(c));
  assert.ok(bg, "the primary button declares a background color");
  assert.ok(resolves(bg), `the primary button's background (${bg}) is a real generated rule`);
  assert.ok(resolves("bg-primary") && compiled.match(/\.bg-primary\s*\{[^}]*var\(--color-primary\)/),
    "bg-primary paints with the design-system --color-primary token");
  assert.ok(!/hidden|sr-only|invisible|opacity-0(?:\s|")/.test(primary[1]),
    "the primary button has no hidden/invisible/zero-opacity variant");
  ok("the primary button paints bg-primary — a real token — and carries no hiding class");
}

// ---- 4. cancel creates nothing; creation is invoked from exactly one place ----
{
  const card = code(CARD);
  const calls = [...card.matchAll(/requestFullSyncAction\(/g)];
  assert.equal(calls.length, 1, "the canonical creation action is invoked from exactly one place");
  assert.ok(/onClick=\{\(\) => setConfirming\(false\)\}/.test(card),
    "cancel only closes the confirmation — it can reach no server action");
  assert.ok(/onClick=\{\(\) => setConfirming\(true\)\}/.test(card),
    "opening the confirmation only flips local state — it creates nothing");
  ok("cancel and open touch only local state; job creation has a single call site");
}

// ---- 5. the creation response transitions the UI immediately (§5) ----
{
  const card = code(CARD);
  const fnStart = card.indexOf("function confirmFullSync");
  assert.ok(fnStart !== -1, "confirmFullSync exists");
  const fn = card.slice(fnStart, card.indexOf("return (", fnStart));
  const setViewAt = fn.indexOf("setView(");
  const reloadAt = fn.lastIndexOf("await reload()");
  assert.ok(setViewAt !== -1, "the creation response is written into component state");
  assert.ok(reloadAt !== -1 && setViewAt < reloadAt,
    "…BEFORE any status fetch — the progress area appears without waiting for polling");
  assert.ok(/running:\s*true/.test(fn), "the optimistic state marks the run live (renders the 0% panel, starts the poller)");
  assert.ok(/runId:\s*res\.data\?\.runId/.test(fn), "the PERSISTED runId from the response enters state — the client fabricates none");
  assert.ok(/progress:\s*null/.test(fn), "a previous run's finished progress can never masquerade as the new run's");
  ok("a successful creation response immediately shows the persisted run — no wait for the first poll");
}

// ---- 6. the server action returns the persisted run id ----
{
  const admin = code(ADMIN);
  assert.ok(/runId: active\?\.id \?\? \("id" in enqueued \? enqueued\.id : null\)/.test(admin),
    "the response's runId is the DB row id (the live run's on a duplicate) — never invented");
  assert.ok(/idempotencyKey: `full_sync:\$\{conn\.id\}`/.test(admin),
    "duplicate prevention is keyed server-side per connection (uq_jobs_idempotency enforces it)");
  ok("requestFullSyncAction returns the persisted run id; duplicates report the live run");
}

// ---- 7. the progress area lives inside the ARI section, above the controls ----
{
  const card = read(CARD);
  const section = card.indexOf("סנכרון ARI");
  const runningPanel = card.indexOf("{running && progress && <RunningPanel");
  const controls = card.indexOf('{running ? "סנכרון מלא כבר מתבצע" : "סנכרון מלא"}');
  assert.ok(section !== -1 && runningPanel > section && controls > runningPanel,
    "progress renders inside the סנכרון ARI section, with the Full Sync controls in the same card area");
  ok("the progress area is inline in the Full Sync section — not on another page, not under unrelated cards");
}

rmSync(CACHE, { recursive: true, force: true });
console.log(`\ncheck-channels-fullsync-ui: all ${n} assertions passed`);
