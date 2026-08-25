// ============================================================
// GUIDELINES.md compliance check — the design system's enforcement.
//
// It reads the REAL declarations (CSS rules and Tailwind classes), not prose:
// a developer cannot get past it by renaming a class, because the check is on
// the values (font-size, radius, shadow, colour, height, physical direction),
// not on names.
//
//   node scripts/check-design-system.mjs          # fail on any violation
//   node scripts/check-design-system.mjs --report # group + count, exit 0
//
// One exception is declared, not inferred: the violations listed in
// scripts/check-design-system.baseline are recorded as frozen debt (D159) and
// suppressed. They are matched one entry per instance, so nothing new hides
// behind them, and an entry that stops matching fails the run. See the BASELINE
// block below — and note there is no way for a run to write that file.
// ============================================================
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const REPORT = process.argv.includes("--report");

// ---- the closed sets from GUIDELINES.md ----
const FONT_SIZES = [12, 13.5, 14, 15, 17, 19, 21, 32]; // §2
const RADII = [7, 8, 10, 12, 16]; // §1 four radii + the 10px icon-button (§4)
const ICON_SIZES = [13.5, 17, 20, 24]; // §10
// §1: only two shadows, plus the primary-button glow and the focus ring, both
// spelled out in the guideline itself.
const SHADOWS = [
  "0 6px 20px rgba(16,24,40,.03)",
  "0 24px 60px rgba(16,24,40,.26)",
  "0 4px 12px rgba(37,64,200,.2)",
  "0 0 0 3px rgba(37,64,200,.12)",
];
// §12.2 — the ONE permitted extra line value: internal calendar grid lines
const GRID_LINE = "#f3f5f9";

// design-system.css is where the tokens and the primitives are DECLARED; it is
// the only file allowed to hold raw values. Everything else must consume them.
const TOKEN_FILE = "src/app/styles/design-system.css";
// the TypeScript token modules: the §3.1 triplets and the derivation helpers.
// They DECLARE colour; every other .ts/.tsx must consume them.
const TS_TOKEN_FILES = ["src/lib/status-colors.ts", "src/lib/colors.ts"];
// base.css holds the Tailwind @theme mirror of the same tokens (§1) — the
// utilities must resolve to the token values, so the literals live there too.
const THEME_FILE = "src/app/styles/base.css";

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(css|tsx|ts)$/.test(p)) files.push(relative(ROOT, p));
  }
})(join(ROOT, "src"));

const violations = [];
// The normalized source line the current violation sits on. It is what makes a
// baseline entry identify ONE instance instead of a file+rule bucket (D159), so
// every violation carries it — set once per source line, below.
let snippet = "";
const normLine = (s) => s.trim().replace(/\s+/g, " ");
const add = (file, line, rule, detail) =>
  violations.push({ file, line, rule, detail, snippet });

const norm = (s) => s.replace(/\s+/g, "").toLowerCase();
const near = (v, set) => set.some((a) => Math.abs(a - v) < 0.01);

for (const file of files) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const lines = src.split("\n");
  const isTokenFile = file === TOKEN_FILE;
  const isThemeFile = file === THEME_FILE;
  const isCss = file.endsWith(".css");

  lines.forEach((raw, i) => {
    const n = i + 1;
    // strip comments so a documented value is never flagged
    const line = raw.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
    if (!line.trim()) return;
    snippet = normLine(line);

    // A `ds-allow:` marker (on this line or the one above) is an explicit,
    // reviewable exception to a VALUE rule (colour / font-size / radius / shadow
    // / control-height): a reference the product owner supplied overrides the
    // closed set for that one declaration. Structural rules (physical-direction,
    // duplicate-primitive, icon-library) are NOT values and ignore this marker —
    // they still fail. `vadd` records a value violation only when not exempted.
    const dsAllow = /ds-allow:/.test(raw) || /ds-allow:/.test(lines[i - 1] ?? "");
    const vadd = (rule, detail) => {
      if (!dsAllow) add(file, n, rule, detail);
    };

    // ---- §2 typography: CSS font-size ----
    for (const m of line.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      const v = Number(m[1]);
      if (!near(v, FONT_SIZES))
        vadd("font-size", `${v}px — not in the §2 scale`);
    }
    // ---- §2 typography: Tailwind arbitrary + non-scale utilities ----
    for (const m of line.matchAll(/text-\[([0-9.]+)px\]/g)) {
      const v = Number(m[1]);
      if (!near(v, FONT_SIZES))
        vadd("font-size", `text-[${v}px] — not in the §2 scale`);
    }
    for (const m of line.matchAll(
      /\b(?<!\w)(text-base|text-lg|text-xl|text-2xl|text-3xl|text-4xl|text-\[[0-9.]+rem\])(?!\w)/g,
    )) {
      vadd("font-size", `${m[1]} — resolves outside the §2 scale`);
    }

    // ---- §1 radii ----
    for (const m of line.matchAll(/border-radius:\s*([^;]+);/g)) {
      const v = norm(m[1]);
      if (isTokenFile || isThemeFile) continue;
      if (/var\(--r-(lg|md|sm|xs)\)/.test(v)) continue;
      if (/^(50%|999px|9999px|0)$/.test(v)) continue; // circles / dots / reset
      const px = v.match(/^([0-9.]+)px/);
      if (px && near(Number(px[1]), RADII)) continue;
      // multi-corner radius (header/footer of a card) — every corner must be legal
      const parts = v.split(/\s+/).filter(Boolean);
      if (
        parts.length > 1 &&
        parts.every(
          (p) =>
            p === "0" ||
            (/^([0-9.]+)px$/.test(p) &&
              near(Number(p.replace("px", "")), RADII)),
        )
      )
        continue;
      vadd("radius", `${m[1].trim()} — not one of {16,12,10,8,7}`);
    }
    for (const m of line.matchAll(/\brounded-\[([0-9.]+)px\]/g)) {
      if (!near(Number(m[1]), RADII))
        vadd("radius", `rounded-[${m[1]}px] — not an approved radius`);
    }
    for (const m of line.matchAll(
      /\b(rounded-sm|rounded-md|rounded-3xl|rounded-4xl)(?!\w)/g,
    )) {
      vadd("radius", `${m[1]} — not an approved radius`);
    }

    // ---- §1 shadows ----
    if (!isTokenFile && !isThemeFile) {
      for (const m of line.matchAll(/box-shadow:\s*([^;]+);/g)) {
        const v = norm(m[1]);
        if (/var\(--(shadow-card|shadow-float|brand-shadow|focus-ring)\)/.test(v))
          continue;
        if (/^inset0001\.5pxvar\(--brand\)$/.test(v)) continue; // §3 filter chip
        if (v === "none") continue;
        if (SHADOWS.some((s) => norm(s) === v)) continue;
        vadd("shadow", `${m[1].trim()} — not one of the two tokens`);
      }
      for (const m of line.matchAll(/\bshadow-\[[^\]]+\]/g))
        vadd("shadow", `${m[0]} — arbitrary shadow`);
    }

    // ---- §1 colours: raw hex outside the token/theme files ----
    if (!isTokenFile && !isThemeFile && !TS_TOKEN_FILES.includes(file)) {
      // a 3-digit "#418" inside prose is a React error code, not a colour, so
      // only CSS keeps the shorthand form; TS/TSX must spell a colour in full.
      const hexRe = isCss ? /#[0-9a-fA-F]{3,8}\b/g : /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g;
      const allowed = dsAllow;
      for (const m of line.matchAll(hexRe)) {
        if (allowed) continue;
        const hex = m[0].toLowerCase();
        if (hex === GRID_LINE) continue; // §12.2
        if (hex === "#fff" || hex === "#ffffff") continue; // --surface literal
        add(file, n, "color", `${m[0]} — raw colour; use a token`);
      }
      for (const m of line.matchAll(/\b(?:bg|text|border)-\[#[0-9a-fA-F]{3,8}\]/g))
        add(file, n, "color", `${m[0]} — raw colour utility`);
    }

    // ---- §4/§5 control heights ----
    if (isCss && !isTokenFile) {
      for (const m of line.matchAll(/height:\s*([0-9.]+)px/g)) {
        const v = Number(m[1]);
        if ([38, 40, 42, 46, 48, 52].includes(v))
          vadd(
            "control-height",
            `${v}px — buttons/fields are 44px (36px only in a popover/row)`,
          );
      }
      // the same heights hidden behind a custom property (height: var(--x)) —
      // legal ONLY for documented grid geometry, marked `ds-geometry:` at the
      // declaration. Renaming the var does not evade this; removing the marker
      // re-flags it.
      for (const m of line.matchAll(/(--[\w-]+):\s*(38|40|42|46|48|52)px/g)) {
        const marked =
          /ds-geometry:/.test(raw) || /ds-geometry:/.test(lines[i - 1] ?? "") || /ds-geometry:/.test(lines[i - 2] ?? "");
        if (!marked)
          add(
            file,
            n,
            "control-height",
            `${m[1]}: ${m[2]}px — a forbidden control height behind a variable (mark grid geometry with ds-geometry:)`,
          );
      }
    }

    // ---- §10 icons ----
    if (/from "lucide-react"|require\("lucide-react"\)/.test(line))
      add(file, n, "icon-library", "lucide-react — Material Symbols only (§10)");
    if (
      /<svg\b/.test(line) &&
      !file.includes("Icon.tsx") &&
      !/ds-allow:/.test(line) &&
      !/ds-allow:/.test(lines[i - 1] ?? "")
    )
      add(file, n, "icon-library", "inline <svg> — use <Icon> (§10)");

    // ---- §11 physical direction properties ----
    if (isCss && !isTokenFile) {
      for (const m of line.matchAll(
        /(?:^|\s)(margin-(?:left|right)|padding-(?:left|right)|border-(?:left|right)(?:-\w+)?|text-align:\s*(?:left|right))\s*:?/g,
      )) {
        add(file, n, "physical-direction", `${m[1]} — use a logical property (§11)`);
      }
    }

    // ---- duplicate primitives: nobody re-declares a canonical class ----
    if (isCss && !isTokenFile) {
      const dup = line.match(
        /^\s*\.(btn|btn-primary|btn-secondary|btn-tertiary|btn-sm|icon-btn|chip|field|field-input|field-label|card|card-hd|card-bd|popover|modal)\s*[,{]/,
      );
      if (dup)
        add(
          file,
          n,
          "duplicate-primitive",
          `.${dup[1]} is re-declared — the canonical one lives in design-system.css`,
        );
    }
  });
}

// ---- the Icon component is the only place an icon size is chosen (§10) ----
snippet = ""; // whole-file findings below sit on no particular source line
const iconSrc = readFileSync(join(ROOT, "src/components/shared/Icon.tsx"), "utf8");
if (!/const ALLOWED_SIZES = \[13.5, 17, 20, 24\]/.test(iconSrc))
  add("src/components/shared/Icon.tsx", 0, "icon-size", "the allowed icon sizes were changed");
if (!/snapIconSize/.test(iconSrc))
  add("src/components/shared/Icon.tsx", 0, "icon-size", "icon sizes are no longer snapped to the allowed set");
void ICON_SIZES;

// ============================================================
// BASELINE (D159) — declared-frozen violations.
//
// The housekeeping module is frozen by owner decision (STATE.md), so its six
// original violations cannot be fixed and must not keep the guard red forever.
// They are written down in scripts/check-design-system.baseline, one line per
// INSTANCE, and matched on content:
//
//   rule + file + detail + the normalized source line
//
// Line NUMBERS are deliberately not part of the key — the baseline must not
// break on an unrelated shift. The source line IS part of it: it is the only
// thing that tells the two identical `text-base` entries apart, and it makes an
// entry go stale the moment the offending line is edited.
//
// A matched entry is CONSUMED: one entry suppresses exactly ONE violation. A
// second identical violation therefore has no entry left and stays red. That is
// the property the whole mechanism exists for — a new violation of the same rule
// in the same file is never absorbed by an existing entry.
//
// Nothing here writes the file. There is no --update-baseline and no
// regeneration path, by decision: a baseline a run can rewrite is not a ratchet.
// ============================================================
const BASELINE_FILE = "scripts/check-design-system.baseline";
// NUL joins the four fields: it cannot occur in any of them, so no combination
// of rule/file/detail/snippet can be re-cut into a different one that collides.
const keyOf = (x) => [x.rule, x.file, x.detail, x.snippet].join("\u0000");

const parseBaseline = (text) =>
  text
    .split("\n")
    .map((raw, i) => ({ raw, n: i + 1 }))
    .filter(({ raw }) => raw.trim() && !raw.trimStart().startsWith("#"))
    .map(({ raw, n }) => {
      const parts = raw.split(" | ");
      if (parts.length < 4)
        throw new Error(
          `${BASELINE_FILE}:${n} — malformed entry; expected "rule | file | detail | source line"`,
        );
      // the source line is LAST and is re-joined, so a "|" inside code is safe
      return {
        n,
        rule: parts[0].trim(),
        file: parts[1].trim(),
        detail: parts[2].trim(),
        snippet: normLine(parts.slice(3).join(" | ")),
      };
    });

// Pure. Returns what stays red, what was suppressed, and which entries matched
// nothing (the ratchet: the baseline may only shrink).
const applyBaseline = (found, entries) => {
  const pool = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(e);
  }
  const used = new Set();
  const remaining = [];
  const suppressed = [];
  for (const v of found) {
    const free = pool.get(keyOf(v))?.find((e) => !used.has(e));
    if (free) {
      used.add(free);
      suppressed.push(v);
    } else remaining.push(v);
  }
  return { remaining, suppressed, stale: entries.filter((e) => !used.has(e)) };
};

// ---- B2: the matcher is re-run against synthetic cases on EVERY run ----
// Neutralize the key and these fail — the mechanism cannot rot silently while
// the real baseline still appears to work.
{
  const V = (rule, detail, snip) => ({
    file: "f.tsx", line: 1, rule, detail, snippet: snip,
  });
  const E = (rule, detail, snip) => ({
    n: 1, file: "f.tsx", rule, detail, snippet: snip,
  });
  const must = (cond, why) => {
    if (!cond) throw new Error(`baseline self-test failed: ${why}`);
  };
  const run = (vs, es) => applyBaseline(vs, es);

  const a = V("font-size", "text-base — x", "<p class=A>");
  const aEntry = E("font-size", "text-base — x", "<p class=A>");

  let r = run([a], [aEntry]);
  must(r.suppressed.length === 1 && !r.remaining.length && !r.stale.length,
    "an exact instance must be suppressed");

  // P1 — the case this whole mechanism turns on: same rule, same file, same
  // detail, different line. The baselined one is suppressed, the new one is not.
  r = run([a, V("font-size", "text-base — x", "<p class=B>")], [aEntry]);
  must(r.suppressed.length === 1 && r.remaining.length === 1
    && r.remaining[0].snippet === "<p class=B>",
    "a NEW violation of the same rule in the same file must not be absorbed");

  // and neither is a second identical one — an entry is consumed, not reusable
  r = run([a, { ...a }], [aEntry]);
  must(r.suppressed.length === 1 && r.remaining.length === 1,
    "one entry must suppress exactly one instance, not every instance like it");

  // two identical details on different lines need their own entries each
  const b = V("font-size", "text-base — x", "<p class=B>");
  r = run([a, b], [aEntry, E("font-size", "text-base — x", "<p class=B>")]);
  must(r.suppressed.length === 2 && !r.remaining.length && !r.stale.length,
    "two instances that differ only by source line must each match their own entry");

  // P2 — the key holds across a line-number shift, and only that
  r = run([{ ...a, line: 999 }], [aEntry]);
  must(r.suppressed.length === 1, "a line-number shift alone must not break an entry");

  // P3 — an entry that matches nothing is stale, and the run must say so
  r = run([], [aEntry]);
  must(r.stale.length === 1, "an entry matching nothing must be reported stale");

  // an entry differing in ANY field matches nothing: it is stale AND the
  // violation stays red — no near-miss is ever silently forgiven
  for (const near of [
    E("radius", "text-base — x", "<p class=A>"),
    E("font-size", "text-lg — x", "<p class=A>"),
    E("font-size", "text-base — x", "<p class=Z>"),
    { ...aEntry, file: "other.tsx" },
  ]) {
    r = run([a], [near]);
    must(r.remaining.length === 1 && r.stale.length === 1,
      "an entry that differs in any field must neither match nor forgive");
  }
}

const baselineText = existsSync(join(ROOT, BASELINE_FILE))
  ? readFileSync(join(ROOT, BASELINE_FILE), "utf8")
  : ""; // a deleted baseline is an empty one — the exit plan needs no code change
const baseline = parseBaseline(baselineText);
const { remaining, suppressed, stale } = applyBaseline(violations, baseline);

// ---- report ----
const byRule = new Map();
for (const v of remaining) {
  if (!byRule.has(v.rule)) byRule.set(v.rule, []);
  byRule.get(v.rule).push(v);
}
const order = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [rule, list] of order) {
  console.log(`\n${rule} — ${list.length}`);
  const byFile = new Map();
  for (const v of list) byFile.set(v.file, (byFile.get(v.file) ?? 0) + 1);
  for (const [f, c] of [...byFile.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(c).padStart(4)}  ${f}`);
  if (!REPORT)
    for (const v of list.slice(0, 8))
      console.log(`        ${v.file}:${v.line} — ${v.detail}`);
}

if (suppressed.length)
  console.log(
    `\n${suppressed.length} baselined violations (D159, frozen module) — suppressed`,
  );

if (stale.length) {
  console.log(`\nstale baseline entry, remove it — ${BASELINE_FILE}:`);
  for (const e of stale)
    console.log(`  ${BASELINE_FILE}:${e.n} — ${e.rule} · ${e.file} · ${e.detail}`);
  console.log(
    "  the violation it recorded is gone. The baseline may only shrink: delete the line.",
  );
}

if (!remaining.length && !stale.length) {
  console.log("check-design-system: the app complies with GUIDELINES.md ✔");
  process.exit(0);
}
if (remaining.length) console.log(`\nTOTAL: ${remaining.length} violation(s)`);
process.exit(REPORT ? 0 : 1);
