#!/usr/bin/env node
// ============================================================
// check:flex-card-shrink — the .card primitive may not be shrunk by a
// scrolling flex column.
//
// THE BUG THIS CLOSES. `.card` is `overflow: hidden` (design-system.css §6).
// Per CSS Flexbox §4.5, a flex item's automatic minimum size (`min-height:
// auto`) resolves to ZERO when its overflow is not `visible`. So a `.card`
// placed in a height-bounded `flex-direction: column` container SHRINKS below
// its content instead of overflowing — and its own `overflow: hidden` then
// clips the body away, leaving the scroll container with nothing to scroll.
//
// Measured twice in production, eight days apart:
//   D177 (2026-09-06) — the rate-cell drawer: at 1440x900 "מצב מסחרי" showed
//   328 of its 528 content pixels. Fixed with `.rc-sec { flex: none }`.
//   D178 (2026-09-07) — the send-message panel: at 390x844 the three cards
//   rendered 126/194, 248/384 and 200/309 px, and `.sm-body` was not
//   scrollable at all. Reverted in PR #245.
//
// D177 already encoded the lesson — in check-rate-cell-panel.mjs:221, as an
// assertion about `.rc-sec`. It was written about ONE PANEL instead of about
// the PRIMITIVE, so it could not see the next panel. This guard is the
// generalisation: `.card` is overflow:hidden everywhere, so every scrolling
// flex column in the code base is the next instance.
//
// WHY CLASS SETS AND NOT SELECTORS. The dangerous element is rarely described
// by one rule. `SidePanel.tsx` renders `dw-bd thin-scroll p-0 ${bodyClassName}`:
// `.dw-bd` contributes `overflow-y: auto` and the caller's `.rc-body`
// contributes `flex-direction: column`. Neither rule is a finding on its own —
// the ELEMENT is. So the guard unions the declarations of the classes that
// actually appear together on one element in the JSX, including one hop
// through a className prop.
//
// Static only: no DB, no network, no browser, no build.
// Usage: node scripts/check-flex-card-shrink.mjs
// ============================================================
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

// script-relative, never cwd — a guard that hardcodes the production root goes
// green on code you never wrote (see the guard ROOT defect class, check:guard-roots).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const walk = (dir, ext, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
};
const rel = (p) => relative(ROOT, p);

// ---- 1. CSS: declarations per class, from single-class rules -----------------
// Innermost-block regex: a nested at-rule (@layer, @media) never matches,
// because its body contains braces — so `.card` inside `@layer components`
// is read as the plain rule it is.
const BLOCK = /([^{}]+)\{([^{}]+)\}/g;
/** class -> merged declaration text (every simple-class rule that names it) */
const cssOf = new Map();
/** every rule as {selector, body}, for the descendant-selector escapes */
const allRules = [];

for (const file of walk(join(ROOT, "src"), ".css")) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, rawSel, body] of css.matchAll(BLOCK)) {
    const sel = rawSel.trim();
    if (!sel || sel.startsWith("@")) continue;
    allRules.push({ sel, body, file: rel(file) });
    // a "simple-class rule" describes ONE element: `.a`, or a comma list of
    // such. Anything with a combinator or a second class describes a
    // relationship, and belongs to the escape scan below, not here.
    for (const part of sel.split(",")) {
      const m = /^\s*\.([A-Za-z0-9_-]+)\s*$/.exec(part);
      if (m) cssOf.set(m[1], (cssOf.get(m[1]) ?? "") + body + ";");
    }
  }
}

const has = (decls, re) => re.test(decls);
const IS_COLUMN = /flex-direction:\s*column/;
const IS_SCROLL = /overflow(-y)?:\s*(auto|scroll)/;
const NO_SHRINK = /flex:\s*(none|0 0)|flex-shrink:\s*0/;
const OVERFLOW_OK = /overflow:\s*visible/;
const MIN_H = /min-height:\s*(?!auto)[^;]+/;

// ---- 2. JSX: the class sets that actually land on one element ----------------
// `[^`]*` cannot cross a NESTED template literal, and SidePanel's body class is
// exactly that (`dw-bd thin-scroll${cond ? ` p-0 ${prop}` : ""}`) — so the
// capture runs to the closing "`}" and the interpolations are stripped by depth.
const CLASS_LIT = /className=(?:"([^"]*)"|\{`([\s\S]*?)`\})/g;
const PROP_LIT = /([A-Za-z][A-Za-z0-9]*ClassName)="([^"]*)"/g;

/** the classes a template literal states OUTRIGHT, plus the props it interpolates */
const splitTpl = (tpl) => {
  let text = "", depth = 0;
  const props = [];
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] === "$" && tpl[i + 1] === "{") {
      if (depth === 0) {
        const m = /^\$\{\s*([A-Za-z][A-Za-z0-9]*)/.exec(tpl.slice(i));
        if (m) props.push(m[1]);
      }
      depth++; i++; continue;
    }
    if (depth > 0) {
      if (tpl[i] === "{") depth++;
      else if (tpl[i] === "}") depth--;
      continue;
    }
    text += tpl[i];
  }
  return { text, props };
};

const tsx = walk(join(ROOT, "src"), ".tsx");
/** propName -> base classes of the element that interpolates it */
const propBase = new Map();
for (const file of tsx) {
  const src = readFileSync(file, "utf8");
  for (const [, , tpl] of src.matchAll(CLASS_LIT)) {
    if (!tpl) continue;
    const { text, props } = splitTpl(tpl);
    const base = text.split(/\s+/).filter(Boolean);
    for (const prop of props) propBase.set(prop, [...new Set([...(propBase.get(prop) ?? []), ...base])]);
  }
}

/** every element's class set, per file, WITH the source range it encloses */
// JSX is well-formed, so a tag-depth scan gives real containment — file-scoping
// alone attributes every card in a file to every container in it, which is how
// a guard earns false positives and then gets switched off.
const rangeOf = (src, at) => {
  const lt = src.lastIndexOf("<", at);
  const tag = /^<([A-Za-z][\w.]*)/.exec(src.slice(lt, lt + 40))?.[1];
  if (!tag) return null;
  const gt = src.indexOf(">", at);
  if (gt < 0) return null;
  if (src[gt - 1] === "/") return [gt, gt]; // self-closing: encloses nothing
  let depth = 1;
  const scan = new RegExp(`<${tag}[\\s/>]|</${tag}\\s*>`, "g");
  scan.lastIndex = gt + 1;
  for (let m; (m = scan.exec(src)); ) {
    if (m[0].startsWith("</")) { if (--depth === 0) return [gt, m.index]; }
    else {
      const close = src.indexOf(">", m.index);
      if (close > 0 && src[close - 1] !== "/") depth++;
    }
  }
  return [gt, src.length];
};

const elements = []; // {file, classes, at, range}
for (const file of tsx) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(CLASS_LIT)) {
    const text = m[1] ?? splitTpl(m[2] ?? "").text;
    const classes = text.split(/\s+/).filter(Boolean);
    if (classes.length) elements.push({ file: rel(file), classes, at: m.index, range: rangeOf(src, m.index) });
  }
  // one hop through a className prop: `bodyClassName="rc-body"` on the caller
  // is the SAME element as `dw-bd … ${bodyClassName}` inside SidePanel — and
  // its children are the ones written at the CALL SITE.
  for (const m of src.matchAll(PROP_LIT)) {
    const base = propBase.get(m[1]);
    if (!base) continue;
    const classes = [...new Set([...base, ...m[2].split(/\s+/).filter(Boolean)])];
    elements.push({ file: rel(file), classes, at: m.index, range: rangeOf(src, m.index) });
  }
}

const declsOfSet = (classes) => classes.map((c) => cssOf.get(c) ?? "").join(";");

// A panel rarely writes its cards inline: D177's were rendered by a local
// <Section> helper in the same file. Without this hop the guard would report
// that drawer as holding zero cards — a blind spot exactly where the precedent
// lives. So map each file's locally-defined components to their own extent.
const localsOf = new Map(); // file -> [{name, lo, hi}]
for (const file of tsx) {
  const src = readFileSync(file, "utf8");
  const defs = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const)\s+([A-Z]\w*)/gm)].map((m) => ({
    name: m[1],
    lo: m.index,
  }));
  localsOf.set(
    rel(file),
    defs.map((d, i) => ({ ...d, hi: defs[i + 1]?.lo ?? src.length })),
  );
}
const srcOf = new Map(tsx.map((f) => [rel(f), readFileSync(f, "utf8")]));

/** every .card element laid out by this container: written inside it, or inside
 *  a local component the container instantiates. */
const cardsUnder = (box, elements) => {
  const [lo, hi] = box.range;
  const src = srcOf.get(box.file) ?? "";
  const spans = [[lo, hi]];
  for (const c of localsOf.get(box.file) ?? []) {
    if (new RegExp(`<${c.name}[\\s/>]`).test(src.slice(lo, hi))) spans.push([c.lo, c.hi]);
  }
  return elements.filter(
    (e) => e.file === box.file && e.classes.includes("card") && spans.some(([a, b]) => e.at > a && e.at < b),
  );
};

// ---- 3. the finding --------------------------------------------------------
const containers = elements.filter((el) => {
  const d = declsOfSet(el.classes);
  return has(d, IS_COLUMN) && has(d, IS_SCROLL);
});

// a card is safe when a class ON IT lifts the automatic minimum size, or when a
// rule from its container does it — either naming the card (`.rc-body .card`)
// or every child (`.gc-col > *`, the communications editor's own fix).
const cardSafe = (cardClasses, containerClasses) => {
  const own = declsOfSet(cardClasses);
  if (has(own, NO_SHRINK) || has(own, OVERFLOW_OK) || has(own, MIN_H)) return true;
  return allRules.some((r) => {
    if (!(NO_SHRINK.test(r.body) || OVERFLOW_OK.test(r.body) || MIN_H.test(r.body))) return false;
    const fromBox = containerClasses.some((c) => r.sel.includes(`.${c}`));
    if (!fromBox) return false;
    return cardClasses.some((c) => r.sel.includes(`.${c}`)) || /[>\s]\s*\*/.test(r.sel);
  });
};

console.log(`# scrolling flex columns found: ${containers.length}`);
let checked = 0;
for (const box of containers) {
  const label0 = box.classes.filter((c) => cssOf.has(c)).join(".");
  assert.ok(box.range, `${box.file}: could not resolve the JSX extent of the scrolling flex column .${label0} — the guard cannot see its children, so it must not report them clean`);
  if (!box.range) continue;
  const cards = cardsUnder(box, elements);
  const label = box.classes.filter((c) => cssOf.has(c)).join(".");
  console.log(`#   ${box.file}  .${label}  → ${cards.length} .card descendant(s)`);
  for (const card of cards) {
    checked++;
    assert.ok(
      cardSafe(card.classes, box.classes),
      `${box.file}: .card (${card.classes.join(" ")}) sits inside the scrolling flex column .${label} ` +
        `and nothing lifts its automatic minimum size — .card is overflow:hidden, so it SHRINKS below ` +
        `its content and clips its own body instead of letting the column scroll. Give it flex: none ` +
        `(precedents: .rc-sec D177 2026-09-06; .gc-col > * communications.css:359).`,
    );
  }
}

assert.ok(containers.length > 0, "the scan found at least one scrolling flex column — a zero here means the parser broke, not that the code base is clean");
console.log(`check-flex-card-shrink: ${checked} .card element(s) across ${containers.length} scrolling flex column(s) verified ✔`);
