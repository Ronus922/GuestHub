#!/usr/bin/env node
// ============================================================
// check:responsive — the mobile invariants, enforced in source.
//
// THE GAP THIS CLOSES. Before 2026-08-12 not one of the ~110 check:* guards
// asserted anything responsive. check:design polices tokens and RTL rigorously
// and says nothing about viewport, breakpoints, vh or overflow; the only
// viewport assertion in the whole suite is check-reservations-ui.mjs pinning a
// 1440px DESKTOP window. So the app could regress to desktop-only — as it
// largely had — and every guard would stay green.
//
// This is deliberately STATIC: no browser, no app, no DB, so it runs in the
// harness like the rest of the suite. The browser-side proof is a separate
// artefact (docs/audit/MOBILE_RESPONSIVE_INVENTORY.md + MOBILE-AUDIT-REPORT.md);
// what lives here is every invariant that can be decided from the source, which
// is exactly the set that silently rots.
//
// Static only: no DB, no network, no build. Usage: node scripts/check-responsive.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };
const rel = (p) => relative(ROOT, p);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const SRC = join(ROOT, "src");
const files = walk(SRC);
const cssFiles = files.filter((f) => f.endsWith(".css"));
const tsxFiles = files.filter((f) => f.endsWith(".tsx"));
const read = (f) => readFileSync(f, "utf8");

// Blank out comments while PRESERVING line structure, so reported line numbers
// stay real. (Same idiom as check-guard-roots.mjs.)
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// ---------------------------------------------------------------- 1. viewport
{
  // Comments stripped first: layout.tsx explains in prose WHY it never sets
  // maximumScale, and a naive scan would read its own rationale as a violation.
  const layout = read(join(SRC, "app/layout.tsx"))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(layout, /export const viewport\s*:\s*Viewport\s*=/,
    "src/app/layout.tsx must export a `viewport` — without it Next emits only its default and viewport-fit is unset, so every env(safe-area-inset-*) in the app resolves to 0");
  assert.match(layout, /viewportFit\s*:\s*["']cover["']/,
    "viewport.viewportFit must be 'cover' — it is what makes safe-area insets real");
  assert.match(layout, /width\s*:\s*["']device-width["']/,
    "viewport.width must be 'device-width'");
  // Zoom is an accessibility affordance. The iOS zoom-on-focus problem is solved
  // by the 17px touch font, never by taking pinch-zoom away from the user.
  assert.doesNotMatch(layout, /maximumScale\s*:/,
    "viewport must NOT set maximumScale — disabling pinch-zoom is an accessibility regression; the 17px touch font in responsive.css is the sanctioned fix");
  assert.doesNotMatch(layout, /userScalable\s*:\s*false/,
    "viewport must NOT set userScalable:false — see above");
  ok("root layout exports a viewport with viewport-fit:cover and never disables zoom");
}

// ------------------------------------------------- 2. overflow-x:hidden banned
{
  const hits = [];
  for (const f of [...cssFiles, ...tsxFiles]) {
    const body = f.endsWith(".css") ? stripCss(read(f)) : read(f);
    const re = /overflow-x\s*:\s*hidden|\boverflow-x-hidden\b/g;
    let m;
    while ((m = re.exec(body))) hits.push(`${rel(f)}:${lineOf(body, m.index)}`);
  }
  assert.deepEqual(hits, [],
    `overflow-x:hidden is banned — it conceals horizontal overflow instead of fixing its source. Find the box that is too wide. Hits: ${hits.join(", ")}`);
  ok("no overflow-x:hidden anywhere — overflow is fixed at the source, never masked");
}

// ------------------------------------------------------- 3. 100vh needs a dvh
{
  // `100vh` on iOS Safari is the LARGE viewport: it counts the address bar even
  // while the address bar covers the page. Any full-height surface must declare
  // a dvh fallback pair, and no component may use the bare Tailwind h-screen.
  const vhHits = [];
  for (const f of cssFiles) {
    const body = stripCss(read(f));
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      if (!/(?:^|[^-\w])height\s*:\s*100vh/.test(line)) return;
      const next = lines[i + 1] ?? "";
      if (!/height\s*:\s*100dvh/.test(next)) vhHits.push(`${rel(f)}:${i + 1}`);
    });
  }
  assert.deepEqual(vhHits, [],
    `every 'height: 100vh' must be immediately followed by 'height: 100dvh' (the fallback pair). Unpaired: ${vhHits.join(", ")}`);

  const screenHits = [];
  for (const f of tsxFiles) {
    const body = read(f);
    const re = /className=(?:"|'|\{`)[^"'`]*\bh-screen\b/g;
    let m;
    while ((m = re.exec(body))) screenHits.push(`${rel(f)}:${lineOf(body, m.index)}`);
  }
  assert.deepEqual(screenHits, [],
    `h-screen is 100vh and is cut off by mobile browser chrome — use the .app-shell / .vh-fill pair from app/styles/responsive.css. Hits: ${screenHits.join(", ")}`);
  ok("no bare 100vh full-height surface — every one carries its dvh pair");
}

// ------------------------------------------------ 4. iOS zoom-on-focus guard
{
  const responsive = join(SRC, "app/styles/responsive.css");
  assert.ok(existsSync(responsive), "src/app/styles/responsive.css must exist — it is the cross-cutting mobile layer");
  const body = read(responsive);
  assert.match(body, /@media\s*\(pointer:\s*coarse\)/,
    "responsive.css must carry a (pointer: coarse) block — a tablet at 768px+ is a touch device the width query would miss");
  assert.match(body, /font-size:\s*17px/,
    "responsive.css must raise form controls to 17px on touch — Safari zooms the page whenever a focused control renders below 16px, and .field-input is 15px. 17 (not 16) because §2's font-size set is closed and check:design rejects 16");
  // A bare `select` / `textarea` selector is (0,0,1) and LOSES the cascade to
  // `.field-input`'s (0,1,0), so the rule raised <input> only and every select and
  // textarea kept zooming — measured, not theorised: 17px/15px/15px on a touch
  // context at 820px. The `:root` prefix makes each selector (0,1,1).
  for (const el of ["select", "textarea"]) {
    assert.match(body, new RegExp(`:root\\s+${el}\\b`),
      `the 17px touch rule must select ${el} with a specificity-raising prefix (\`:root ${el}\`) — a bare element selector is outranked by .field-input's 15px and silently does nothing`);
  }
  const globals = read(join(SRC, "app/globals.css"));
  assert.match(globals, /@import\s+"\.\/styles\/responsive\.css"/,
    "globals.css must import responsive.css (last, so it can override the canonical primitives)");
  ok("form controls are raised to 17px on touch, and the mobile layer is wired into globals.css");
}

// --------------------------------------- 5. floating surfaces fit the viewport
{
  const ds = stripCss(read(join(SRC, "app/styles/design-system.css")));
  const responsive = stripCss(read(join(SRC, "app/styles/responsive.css")));
  const both = ds + "\n" + responsive;

  // .modal already sizes its width against the viewport; it must also cap its
  // height, or a tall dialog runs off the bottom with its actions unreachable.
  assert.match(both, /\.modal\b[\s\S]{0,900}?max-height:\s*[^;]*d?vh/,
    ".modal must cap its height against the viewport (max-height in dvh/vh) — otherwise a tall dialog pushes its footer actions off-screen with no way to scroll to them");
  // .popover was a hard 316px with no caps at all: narrower viewports clipped it
  // and a long menu could not be scrolled.
  assert.match(both, /\.popover\b[\s\S]{0,900}?max-width:/,
    ".popover must declare a max-width — a fixed 316px overflows any viewport narrower than ~340px");
  assert.match(both, /\.popover\b[\s\S]{0,900}?max-height:/,
    ".popover must declare a max-height with internal scrolling — a long menu is otherwise unreachable");
  ok(".modal and .popover are both capped against the viewport in width and height");
}

// -------------------------------------- 6. one source of truth for the ladder
{
  const bp = join(SRC, "lib/breakpoints.ts");
  assert.ok(existsSync(bp), "src/lib/breakpoints.ts must exist — the JS half of the breakpoint ladder");
  const hits = [];
  for (const f of [...tsxFiles, ...files.filter((x) => x.endsWith(".ts"))]) {
    if (f === bp) continue;
    const body = read(f);
    const re = /matchMedia\(\s*["'`][^"'`]*(?:min|max)-width[^"'`]*["'`]/g;
    let m;
    while ((m = re.exec(body))) hits.push(`${rel(f)}:${lineOf(body, m.index)}`);
  }
  assert.deepEqual(hits, [],
    `a width breakpoint written by hand into matchMedia() drifts from the md: utilities that actually move the layout — import BELOW_MD_QUERY / matchesBelowMd from @/lib/breakpoints instead. Hits: ${hits.join(", ")}`);
  ok("no hand-written width breakpoint in matchMedia — the ladder has one source of truth");
}

// ------------------------------------------- 7. no device-specific breakpoints
{
  // Responsive behaviour is content-driven. A query pinned to one handset's
  // width is a coincidence, not a rule, and breaks on the next device.
  const DEVICE_PX = [320, 360, 375, 390, 391, 393, 412, 414, 428, 430];
  const hits = [];
  for (const f of cssFiles) {
    const body = stripCss(read(f));
    const re = /@media[^{]*?(?:min|max)-width:\s*(\d+)px/g;
    let m;
    while ((m = re.exec(body))) {
      if (DEVICE_PX.includes(Number(m[1]))) hits.push(`${rel(f)}:${lineOf(body, m.index)} (${m[1]}px)`);
    }
  }
  assert.deepEqual(hits, [],
    `device-width media queries are banned — size to the content, not to one handset. Hits: ${hits.join(", ")}`);
  ok("no device-specific media queries — breakpoints are content-driven");
}

// ------------------------------- 8. a wide grid needs its own scroll container
{
  // A min-width past the phone viewport is fine — INSIDE a box that scrolls. The
  // same value with no scroll ancestor is a page-level sideways scroll, which is
  // the single most common mobile defect in this codebase's history.
  const WIDE = 640;
  const hits = [];
  for (const f of tsxFiles) {
    const body = read(f);
    const re = /\bmin-w-\[(\d+)px\]/g;
    let m;
    while ((m = re.exec(body))) {
      if (Number(m[1]) < WIDE) continue;
      // The scroll container is in the same file, in practice on the wrapper one
      // or two elements up — file-level presence is the check that stays stable
      // across refactors without hand-maintaining a selector registry.
      if (!/overflow-x-auto|overflow-auto|\boverflow-x:\s*auto/.test(body)) {
        hits.push(`${rel(f)}:${lineOf(body, m.index)} (min-w-[${m[1]}px])`);
      }
    }
  }
  assert.deepEqual(hits, [],
    `a min-w-[>=${WIDE}px] with no overflow-x scroll container in the same file scrolls the whole PAGE sideways. Wrap it. Hits: ${hits.join(", ")}`);

  // A partial may legitimately reuse a scroll container declared in ANOTHER
  // partial — guests.css deliberately rides the `rl-` list shell that lives in
  // reservations-list.css. Rather than weaken the rule for everyone, that case
  // says so in the open, on one line, naming where the scroll actually is:
  //   /* responsive-allow: scrolled by .rl-twrap (reservations-list.css) */
  // Same shape as check:design's `ds-allow:` and check:guard-roots'
  // `guard-roots: allow-absolute`.
  const ALLOW = /responsive-allow:\s*scrolled by\s+\S+/;
  const cssHits = [];
  for (const f of cssFiles) {
    const raw = read(f);
    const body = stripCss(raw);
    // Only ELEMENT min-widths. `@media (min-width:)` and `@container (min-width:)`
    // are breakpoints — they describe when a rule applies, they do not make any
    // box wide, and folding them in here just produces noise.
    const re = /(^|[^@\w-])min-width:\s*(\d+)px/g;
    let m;
    while ((m = re.exec(body))) {
      const at = m.index + m[1].length;
      const linePrefix = body.slice(body.lastIndexOf("\n", at) + 1, at);
      if (/@(?:media|container)\b/.test(linePrefix)) continue;
      if (Number(m[2]) < WIDE) continue;
      if (/overflow(?:-x)?:\s*auto/.test(body)) continue;
      // The opt-out must sit within the declaring rule, not anywhere in the file.
      const ruleStart = raw.lastIndexOf("{", raw.indexOf(`min-width: ${m[2]}px`));
      const nearby = raw.slice(Math.max(0, ruleStart - 600), raw.indexOf(`min-width: ${m[2]}px`));
      if (ALLOW.test(nearby)) continue;
      cssHits.push(`${rel(f)}:${lineOf(body, at)} (${m[2]}px)`);
    }
  }
  assert.deepEqual(cssHits, [],
    `same rule in CSS: a min-width >= ${WIDE}px needs an overflow:auto scroll container in the same partial. Hits: ${cssHits.join(", ")}`);
  ok("every grid wider than a phone scrolls inside its own container, never the page");
}

// ------------------------------------------------ 9. a min-width cannot GROW
{
  // guests.css shipped `min-width: 1240px` INSIDE `@media (max-width: 1200px)`:
  // the grid got wider as the screen got narrower. Catch the whole class.
  const hits = [];
  for (const f of cssFiles) {
    const body = stripCss(read(f));
    const re = /@media[^{]*max-width:\s*(\d+)px[^{]*\{/g;
    let m;
    while ((m = re.exec(body))) {
      const cap = Number(m[1]);
      // Scan the block that opens here, balancing braces.
      let depth = 0, i = m.index + m[0].length - 1, end = body.length;
      for (; i < body.length; i++) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      const block = body.slice(m.index, end);
      // Element min-widths only — a nested @media/@container prelude is a
      // breakpoint, not a box width (same distinction as rule 8).
      const inner = /(^|[^@\w-])min-width:\s*(\d+)px/g;
      let k;
      while ((k = inner.exec(block))) {
        const at = k.index + k[1].length;
        if (at === 0) continue; // the prelude of this very query
        const linePrefix = block.slice(block.lastIndexOf("\n", at) + 1, at);
        if (/@(?:media|container)\b/.test(linePrefix)) continue;
        if (Number(k[2]) > cap) {
          hits.push(`${rel(f)}:${lineOf(body, m.index + at)} (min-width:${k[2]}px inside max-width:${cap}px)`);
        }
      }
    }
  }
  assert.deepEqual(hits, [],
    `a min-width larger than the max-width of the query containing it makes the layout WIDER as the screen gets narrower. Hits: ${hits.join(", ")}`);
  ok("no min-width that exceeds the max-width of its own media query");
}


// -------------------------------------------- 10. touch targets are 44x44
{
  const body = stripCss(read(join(SRC, "app/styles/responsive.css")));
  // The measured baseline was 833 controls under 44x44, dominated by §4's own
  // canonical sizes (.icon-btn 36, .btn-sm 36, .chip 28). Those sizes are the
  // design system, so the HIT AREA is expanded with a centred transparent
  // ::after instead of the painted box — 44px floor, 100% otherwise, which makes
  // the rule self-limiting: a control already >=44 gets no expansion at all.
  const coarse = body.slice(body.indexOf("@media (pointer: coarse)"));
  assert.ok(coarse.length > 0, "responsive.css must carry a (pointer: coarse) block for touch targets");
  assert.match(coarse, /::after[\s\S]{0,400}?min-width:\s*44px/,
    "the coarse-pointer ::after must declare a 44px min-width — this is the mobile hit area");
  assert.match(coarse, /::after[\s\S]{0,400}?min-height:\s*44px/,
    "the coarse-pointer ::after must declare a 44px min-height");
  assert.match(coarse, /::after[\s\S]{0,400}?width:\s*100%/,
    "the ::after must also be width:100% — without it the rule would SHRINK controls that are already wider than 44px");
  // A disabled control must stay dead: no hit area, no expansion.
  assert.match(coarse, /:not\(:disabled\):not\(\[aria-disabled="true"\]\)::after/,
    "the hit area must be excluded for :disabled and [aria-disabled=true] — a disabled control must not become tappable");
  // The expansion is transparent by construction; a background here would be a
  // visible change to every small control in the app.
  const afterBlock = coarse.slice(coarse.indexOf("::after"), coarse.indexOf("::after") + 700);
  assert.doesNotMatch(afterBlock, /background:\s*(?!transparent)[a-z(#]/,
    "the touch hit area must stay transparent — it expands the target, it does not paint anything");
  ok("touch targets reach 44x44 on a coarse pointer, transparently, and never on a disabled control");
}

// ------------------------------------- 11. zoom is never disabled, restated
{
  // Belt and braces next to the touch rule: raising hit areas is the sanctioned
  // fix, taking pinch-zoom away is not.
  const layout = read(join(SRC, "app/layout.tsx"));
  assert.doesNotMatch(layout.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
    /user-scalable\s*=\s*no/, "viewport must never contain user-scalable=no");
  ok("pinch-zoom is never disabled anywhere in the viewport declaration");
}

console.log(`\n✓ responsive invariants: ${n}/${n} passed`);
