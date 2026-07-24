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
// Static + local compile only: no network, no DB, no browser.
// Usage: node scripts/check-channels-fullsync-ui.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const ROOT = "/var/www/guesthub";
const CHANNELS_DIR = "src/app/(dashboard)/channels";

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

// (The Full Sync flow-contract assertions that lived here targeted the removed
//  AriSyncSection card + its requestFullSyncAction. The Beds24 Full Sync card
//  (Beds24Section.tsx) is covered by the color-utility resolution check above —
//  the D72 invisible-button defect stays guarded for every /channels card.)

rmSync(CACHE, { recursive: true, force: true });
console.log(`\ncheck-channels-fullsync-ui: all ${n} assertions passed`);
