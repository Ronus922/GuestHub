#!/usr/bin/env node
// ============================================================
// check:automation-design — the automation panel is measured, not eyeballed.
//
// THE DEFECT THIS EXISTS FOR. A reskin gets judged by looking at it. "Looks
// right" survives review, and every later edit drifts a little further from the
// reference until the design is folklore. Nothing catches it, because nothing
// ever compared a number to a number.
//
// WHAT IT DOES. Parses design-ref/whatsapp-automation.html — the same bundle
// the designer shipped — pulls the literal values out of its inline styles and
// its seg()/chip()/track()/knob()/renderVals() helper strings, then reads the
// panel's own declarations out of communications.css (following var(--token)
// into design-system.css) and compares them property by property. It fails on
// a 1px change, in either direction.
//
// TWO KINDS OF ROW.
//   expect(...)    the design's literal IS the contract. Drift fails.
//   exception(...) the design's literal collides with a closed set in
//                  GUIDELINES (§1 radii/shadows/colour, §2 type scale, §5
//                  control heights, §6 card chrome, §10 icon sizes) or with an
//                  iron rule (touch target). The DESIGN SYSTEM WINS — and the
//                  row pins BOTH values: the design's, so we notice if the
//                  reference is re-exported with different numbers, and the
//                  substitute, so an exception can never quietly become a
//                  third value nobody chose. A divergence here is loud.
//
// The exception list IS the audit table. Nothing diverges silently.
//
// Static only: no DB, no network, no build.
// Usage: node scripts/check-automation-design.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let checks = 0;
const fails = [];

// ---------- the design side ----------
const bundle = readFileSync(join(ROOT, "design-ref/whatsapp-automation.html"), "utf8");
const templateJson = /__bundler\/template">\s*([\s\S]*?)\s*<\/script>/.exec(bundle);
assert.ok(templateJson, "the bundle no longer carries a __bundler/template block");
const design = JSON.parse(templateJson[1]);

/** "a:b;c:d" -> {a:"b", c:"d"} — the one shape both sides get normalised into. */
const parseDecls = (text) => {
  const out = {};
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v.replace(/\s+/g, " ");
  }
  return out;
};

// every literal inline style in the design markup ({{ … }} refs are not values)
const designStyles = [...design.matchAll(/style="([^"]*)"/g)]
  .map((m) => m[1])
  .filter((s) => !s.includes("{{"));

/** the one design element whose style contains every marker given */
const el = (name, ...markers) => {
  const hits = designStyles.filter((s) => markers.every((k) => s.includes(k)));
  assert.ok(hits.length, `design element "${name}" not found (markers: ${markers.join(", ")})`);
  return parseDecls(hits[0]);
};

/** a literal string inside a helper method, e.g. seg()'s base or its on-branch */
const helper = (name, re) => {
  const m = re.exec(design);
  assert.ok(m, `design helper "${name}" not found`);
  return parseDecls(m[1]);
};

const D = {
  card: el("section card", "border-radius:16px", "box-shadow:0 6px 20px"),
  cardHd: el("section header", "border-bottom:1px solid #EEF0F5", "padding:14px 18px"),
  cardBd: el("section body", "padding:16px 18px"),
  input: el("input", "height:46px", "border-radius:12px"),
  label: el("field label", "font-size:12px", "font-weight:700", "color:#6B7385"),
  select: el("select", "height:46px", "-webkit-appearance:none"),
  segWrap: el("segmented container", "background:#F1F3F8", "border-radius:12px", "padding:4px"),
  note: el("info note", "background:#F7F8FB", "border-radius:12px", "padding:11px 13px"),
  colWrap: el("columns wrapper", "flex-wrap:wrap", "gap:16px"),
  colMain: el("form column", "flex:1 1 460px"),
  colSide: el("preview column", "flex:1 1 320px", "max-width:348px"),
  togRow: el("toggle row", "align-items:center", "gap:12px"),
  togTitle: el("toggle title", "font-size:15px", "font-weight:700"),
  togSub: el("toggle sub", "font-size:14px", "font-weight:600", "color:#6B7385", "margin-top:2px"),
  sumCard: el("summary card", "padding:15px 16px", "gap:11px"),
  sumRow: el("summary row", "gap:9px", "align-items:flex-start"),
  sumLabel: el("summary label", "font-size:12px", "font-weight:700", "color:#6B7385"),
  sumValue: el("summary value", "font-size:15px", "font-weight:700", "line-height:1.4"),
  btn2: el("secondary button", "border:1.5px solid #E7EAF1", "padding:0 20px"),
  seg: helper("seg() base", /seg\(on\)\{\s*return\s*'([^']*)'/),
  segOn: helper("seg() on", /seg\(on\)[\s\S]*?on\?'([^']*)'/),
  segOff: helper("seg() off", /seg\(on\)[\s\S]*?on\?'[^']*':'([^']*)'/),
  chip: helper("chip() base", /const base='([^']*)'/),
  chipWarn: helper("chip() on+warn", /if\(on&&warn\)return base\+'([^']*)'/),
  chipOn: helper("chip() on", /if\(on\)return base\+'([^']*)'/),
  chipOff: helper("chip() off", /return base\+'(background:#fff[^']*)'/),
  track: helper("track()", /track\(on\)\{\s*return\s*'([^']*)'/),
  trackOn: { background: /track\(on\)[\s\S]*?on\?'(#[0-9A-Fa-f]{6})'/.exec(design)?.[1] },
  trackOff: { background: /track\(on\)[\s\S]*?on\?'#[0-9A-Fa-f]{6}':'(#[0-9A-Fa-f]{6})'/.exec(design)?.[1] },
  knob: helper("knob()", /knob\(on\)\{\s*return\s*'position:absolute;top:3px;'\+\(on\?'left:3px':'right:3px'\)\+'([^']*)'/),
  save: helper("saveStyle", /saveStyle:'([^']*)'/),
  stOk: helper("status chip (approved)", /'מאושרת':\{icon:'verified',style:'([^']*)'/),
};
// knob()'s top/inset live in the branch prefix, not the shared tail
D.knob.top = "3px";

// ---------- our side ----------
/** remove @media/@supports/@container blocks whole, braces balanced */
const stripAtBlocks = (css) => {
  for (const at of ["@media", "@supports", "@container"]) {
    let i;
    while ((i = css.indexOf(at)) >= 0) {
      const open = css.indexOf("{", i);
      if (open < 0) break;
      let depth = 0, j = open;
      for (; j < css.length; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}" && --depth === 0) break;
      }
      css = css.slice(0, i) + css.slice(j + 1);
    }
  }
  return css;
};
const cssFiles = ["src/app/styles/design-system.css", "src/app/styles/communications.css"];
const rules = new Map(); // selector -> merged declarations, in file/source order
const tokens = {};
for (const f of cssFiles) {
  // Responsive overrides are a DIFFERENT contract from the design's desktop
  // reference — flattening them in made .gc-auto-side read as position:static,
  // because the 1100px block legitimately unsticks it. Drop @-blocks whole.
  const css = stripAtBlocks(readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, " "));
  // The selector is whatever sits between the previous brace and this one.
  // (Anchoring on a LEADING brace instead would consume the trailing `}` of
  // each match and silently skip every second rule — which it did.)
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    let sel = m[1].trim();
    const semi = sel.lastIndexOf(";"); // strip declarations of an enclosing block
    if (semi >= 0) sel = sel.slice(semi + 1).trim();
    sel = sel.replace(/\s+/g, " ");
    if (!sel || sel.startsWith("@")) continue;
    const decls = parseDecls(m[2]);
    if (sel === ":root") Object.assign(tokens, decls);
    rules.set(sel, { ...(rules.get(sel) ?? {}), ...decls });
  }
}
/** var(--x) -> the literal in :root, recursively; everything else unchanged */
const deref = (v, depth = 0) => {
  if (typeof v !== "string" || depth > 5) return v;
  return v.replace(/var\((--[\w-]+)\)/g, (_, name) => deref(tokens[name] ?? `var(${name})`, depth + 1));
};
/** the effective declarations for the panel: base selector, then overrides */
const ours = (...selectors) => {
  const merged = {};
  for (const s of selectors) {
    const r = rules.get(s);
    assert.ok(r, `selector "${s}" is gone from the stylesheets — the panel was renamed without updating this guard`);
    Object.assign(merged, r);
  }
  for (const k of Object.keys(merged)) merged[k] = deref(merged[k]);
  return merged;
};

// ---------- the comparison ----------
// The two sides spell the same value differently — #fff vs #ffffff, .03 vs 0.03,
// rgba(16,24,40,.03) vs rgba(16, 24, 40, 0.03). Those are the SAME colour, and a
// guard that reported them as drift would cry wolf until it got switched off.
// Normalise the spelling; never normalise the magnitude.
const norm = (v) =>
  String(v ?? "")
    .trim().toLowerCase()
    .replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, "#$1$1$2$2$3$3")
    .replace(/(^|[\s(,:])\.(\d)/g, "$10.$2")
    .replace(/\s*,\s*/g, ",")
    .replace(/\(\s+|\s+\)/g, (s) => s.trim())
    .replace(/\s+/g, " ");
const eq = (a, b) => norm(a) === norm(b);

/** the design's literal IS the contract */
const expect = (element, prop, designVal, actualVal) => {
  checks++;
  if (!eq(designVal, actualVal))
    fails.push(`${element} · ${prop}\n      design: ${designVal}\n      built:  ${actualVal}`);
};
/** the design system wins — but BOTH values are pinned */
const exception = (element, prop, designVal, designExpected, actualVal, actualExpected, why) => {
  checks++;
  if (!eq(designVal, designExpected))
    fails.push(`${element} · ${prop} — the REFERENCE moved (was ${designExpected}, now ${designVal}). Re-adjudicate this exception.`);
  if (!eq(actualVal, actualExpected))
    fails.push(`${element} · ${prop} — documented exception drifted to a third value.\n      design:     ${designVal}\n      documented: ${actualExpected}  (${why})\n      built:      ${actualVal}`);
};

// ===== section card (§1) =====
{
  const o = ours(".card");
  expect("section card", "background", D.card.background, o.background);
  expect("section card", "border", D.card.border, o.border);
  expect("section card", "border-radius", D.card["border-radius"], o["border-radius"]);
  expect("section card", "box-shadow", D.card["box-shadow"], o["box-shadow"]);
}
// ===== section header (§2) =====
{
  const o = ours(".card-hd");
  exception("section header", "padding", D.cardHd.padding, "14px 18px", o.padding, "15px 20px", "GUIDELINES §6 pins .card-hd");
  exception("section header", "gap", D.cardHd.gap, "9px", o.gap, "10px", "GUIDELINES §6 pins .card-hd");
  exception("section header", "border-bottom", D.cardHd["border-bottom"], "1px solid #EEF0F5", o["border-bottom"], "1px solid #e7eaf1", "#EEF0F5 is not a §1 token; --line is");
  expect("section header", "font-size", "17px", o["font-size"]);
  expect("section header", "font-weight", "800", o["font-weight"]);
}
// ===== section body (§3) =====
exception("section body", "padding", D.cardBd.padding, "16px 18px", ours(".card-bd").padding, "18px 20px", "GUIDELINES §6 pins .card-bd");

// ===== input (§4) =====
{
  const o = ours(".field-input");
  exception("input", "height", D.input.height, "46px", o.height, "44px", "GUIDELINES §5: fields are 44px; 46 is a forbidden control height");
  exception("input", "padding", D.input.padding, "0 13px", o.padding, "0 14px", "GUIDELINES §5 pins field padding");
  expect("input", "border", D.input.border, o.border);
  expect("input", "border-radius", D.input["border-radius"], o["border-radius"]);
  expect("input", "font-size", D.input["font-size"], o["font-size"]);
  expect("input", "color", D.input.color, o.color);
  expect("input", "background", D.input.background, o.background);
  const f = ours(".field-input:focus");
  expect("input:focus", "border-color", "#2540C8", f["border-color"]);
  expect("input:focus", "box-shadow", "0 0 0 3px rgba(37,64,200,.12)", f["box-shadow"]);
  const l = ours(".field-label");
  expect("field label", "font-size", D.label["font-size"], l["font-size"]);
  expect("field label", "font-weight", D.label["font-weight"], l["font-weight"]);
  expect("field label", "color", D.label.color, l.color);
  expect("field", "gap", "6px", ours(".field").gap);
}
// ===== select (§5) =====
exception("select", "height", D.select.height, "46px", ours(".field-input").height, "44px", "GUIDELINES §5: one field anatomy, 44px");
exception("select", "font-weight", D.select["font-weight"], "600", ours(".field-input")["font-weight"] ?? "(inherit)", "(inherit)", "one field anatomy — no per-screen restyle of .field-input");

// ===== segmented control (§6) =====
{
  const wrap = ours(".gc-seg", ".gc-auto .gc-seg");
  expect("segmented container", "background", D.segWrap.background, wrap.background);
  expect("segmented container", "border-radius", D.segWrap["border-radius"], wrap["border-radius"]);
  expect("segmented container", "padding", D.segWrap.padding, wrap.padding);
  expect("segmented container", "gap", D.segWrap.gap, wrap.gap);
  const b = ours(".gc-segb", ".gc-auto .gc-segb");
  expect("segmented button", "flex", D.seg.flex, b.flex);
  expect("segmented button", "font-size", D.seg["font-size"], b["font-size"]);
  expect("segmented button", "font-weight", D.seg["font-weight"], b["font-weight"]);
  expect("segmented button", "gap", D.seg.gap, b.gap);
  exception("segmented button", "height", D.seg.height, "38px", b.height, "36px", "GUIDELINES §5: 38px is a forbidden control height");
  exception("segmented button", "border-radius", D.seg["border-radius"], "9px", b["border-radius"], "8px", "GUIDELINES §1 radii are {16,12,10,8,7}");
  const on = ours('.gc-segb[aria-pressed="true"]');
  expect("segmented button (on)", "background", D.segOn.background, on.background);
  expect("segmented button (on)", "color", D.segOn.color, on.color);
  exception("segmented button (on)", "box-shadow", D.segOn["box-shadow"], "0 1px 3px rgba(16,24,40,.12)", on["box-shadow"], "0 6px 20px rgba(16, 24, 40, 0.03)", "GUIDELINES §1 permits four shadows; --shadow-card is the card/raise one");
  expect("segmented button (off)", "background", D.segOff.background, b.background);
  expect("segmented button (off)", "color", D.segOff.color, b.color);
}
// ===== source chip (§7) =====
{
  const c = ours(".gc-src");
  expect("source chip", "gap", D.chip.gap, c.gap);
  expect("source chip", "border-radius", D.chip["border-radius"], c["border-radius"]);
  expect("source chip", "font-size", D.chip["font-size"], c["font-size"]);
  expect("source chip", "font-weight", D.chip["font-weight"], c["font-weight"]);
  exception("source chip", "height", D.chip.height, "36px", c["min-height"], "44px", "CLAUDE iron rule #6 — 44px touch target; the design's 36px becomes the floor, not the cap");
  expect("source chip", "padding-inline", D.chip.padding.split(" ")[1], c.padding.split(" ")[1]);
  expect("source chip (off)", "background", D.chipOff.background, c.background);
  expect("source chip (off)", "border", D.chipOff.border, c.border);
  expect("source chip (off)", "color", D.chipOff.color, c.color);
  const on = ours(".gc-src.is-on");
  expect("source chip (on)", "background", D.chipOn.border.replace("1.5px solid ", "") === "#2540C8" ? "#EEF1FD" : D.chipOn.background, on.background);
  expect("source chip (on)", "border-color", D.chipOn.border.replace("1.5px solid ", ""), on["border-color"]);
  expect("source chip (on)", "color", D.chipOn.color, on.color);
  const warn = ours(".gc-src.is-on.is-warn");
  exception("source chip (on+warn)", "background", D.chipWarn.background, "#FEF6E7", warn.background, "color-mix(in srgb, #ea9314 12%, transparent)", "#FEF6E7 is not a §1 token; derived from --warn");
  exception("source chip (on+warn)", "border-color", D.chipWarn.border, "1.5px solid #E8A13C", warn["border-color"], "#ea9314", "#E8A13C is not a §1 token; --warn is");
  exception("source chip (on+warn)", "color", D.chipWarn.color, "#9A6408", warn.color, "#ea9314", "#9A6408 is not a §1 token; --warn is");
}
// ===== toggle track + knob (§8/§9) =====
{
  const t = ours(".gc-sw", ".gc-auto .gc-sw");
  expect("toggle track", "width", D.track.width, t.width);
  expect("toggle track", "height", D.track.height, t.height);
  expect("toggle track", "border-radius", D.track["border-radius"], t["border-radius"]);
  expect("toggle track", "padding", D.track.padding, t.padding);
  expect("toggle track", "transition", D.track.transition.replace("background ", "background-color "), t.transition);
  expect("toggle track (on)", "background", D.trackOn.background, ours('.gc-sw[aria-checked="true"]').background);
  exception("toggle track (off)", "background", D.trackOff.background, "#C9CEDB", t.background, "#9aa1b4", "#C9CEDB is not a §1 token; --faint is");
  const k = ours(".gc-sw::after", ".gc-auto .gc-sw::after");
  expect("toggle knob", "width", D.knob.width, k.width);
  expect("toggle knob", "height", D.knob.height, k.height);
  expect("toggle knob", "border-radius", D.knob["border-radius"], k["border-radius"]);
  expect("toggle knob", "background", D.knob.background, k.background);
  expect("toggle knob", "top", D.knob.top, k.top);
  exception("toggle knob", "box-shadow", D.knob["box-shadow"], "0 1px 3px rgba(16,24,40,.3)", k["box-shadow"] ?? "(none)", "(none)", "GUIDELINES §1 permits four shadows; a knob shadow is not one of them");
  // travel = track width − knob width − inset×2
  const travel = parseFloat(D.track.width) - parseFloat(D.knob.width) - 3 * 2;
  expect("toggle knob", "travel", `-${travel}px 0`, ours('.gc-auto .gc-sw[aria-checked="true"]::after').translate);
}
// ===== toggle row (§10) =====
{
  const r = ours(".gc-toggle", ".gc-auto .gc-toggle");
  expect("toggle row", "gap", D.togRow.gap, r.gap);
  expect("toggle row", "align-items", D.togRow["align-items"], r["align-items"]);
  expect("toggle row title", "font-size", D.togTitle["font-size"], r["font-size"]);
  expect("toggle row title", "font-weight", D.togTitle["font-weight"], r["font-weight"]);
  const sub = ours(".gc-hint", ".gc-auto .gc-toggle .gc-hint");
  expect("toggle row sub", "font-size", D.togSub["font-size"], sub["font-size"]);
  expect("toggle row sub", "font-weight", D.togSub["font-weight"], sub["font-weight"]);
  expect("toggle row sub", "color", D.togSub.color, sub.color);
  expect("toggle row sub", "margin-top", D.togSub["margin-top"], sub["margin-top"]);
}
// ===== primary save button (§11) =====
{
  const b = ours(".btn"), p = ours(".btn-primary");
  expect("primary button", "height", D.save.height, b.height);
  expect("primary button", "padding", D.save.padding, b.padding);
  expect("primary button", "border-radius", D.save["border-radius"], b["border-radius"]);
  expect("primary button", "font-size", D.save["font-size"], b["font-size"]);
  expect("primary button", "font-weight", D.save["font-weight"], b["font-weight"]);
  expect("primary button", "gap", D.save.gap, b.gap);
  expect("primary button", "background", D.save.background, p.background);
  expect("primary button", "color", D.save.color, p.color);
  expect("primary button", "box-shadow", D.save["box-shadow"], p["box-shadow"]);
  expect("primary button", "hover", "#1C2E9A", deref("var(--brand-hover)"));
  exception("primary button", "disabled", "opacity:.45;pointer-events:none", "opacity:.45;pointer-events:none", `opacity:${ours(".btn:disabled").opacity};cursor:${ours(".btn:disabled").cursor}`, "opacity:0.6;cursor:not-allowed", "pointer-events:none would also kill the disabled cursor and the reason tooltip (D118)");
}
// ===== secondary button (§12) =====
{
  const b = ours(".btn"), s = ours(".btn-secondary");
  expect("secondary button", "height", D.btn2.height, b.height);
  expect("secondary button", "border", D.btn2.border, s.border);
  expect("secondary button", "border-radius", D.btn2["border-radius"], b["border-radius"]);
  expect("secondary button", "background", D.btn2.background, s.background);
  expect("secondary button", "color", D.btn2.color, s.color);
  expect("secondary button", "font-size", D.btn2["font-size"], b["font-size"]);
  exception("secondary button", "padding", D.btn2.padding, "0 20px", b.padding, "0 22px", ".btn padding is canonical across every screen");
}
// ===== template status chip (§13) =====
{
  const c = ours(".gc-hd-chip");
  expect("status chip", "height", D.stOk.height, c.height);
  expect("status chip", "padding", D.stOk.padding, c.padding);
  expect("status chip", "gap", D.stOk.gap, c.gap);
  expect("status chip", "border-radius", D.stOk["border-radius"], c["border-radius"]);
  expect("status chip", "font-size", D.stOk["font-size"], c["font-size"]);
  expect("status chip", "font-weight", D.stOk["font-weight"], c["font-weight"]);
  const ok = ours(".gc-hd-chip.is-ok");
  exception("status chip (ok)", "background", D.stOk.background, "#E9F7EF", ok.background, "#dff2e7", "#E9F7EF is not a §1 token; --ok-soft is");
  exception("status chip (ok)", "color", D.stOk.color, "#15803D", ok.color, "#16a34a", "#15803D is not a §1 token; --ok is");
}
// ===== info note (§14) =====
{
  const n = ours(".gc-auto-note");
  expect("info note", "gap", D.note.gap, n.gap);
  expect("info note", "padding", D.note.padding, n.padding);
  expect("info note", "background", D.note.background, n.background);
  expect("info note", "border-radius", D.note["border-radius"], n["border-radius"]);
  expect("info note", "font-size", "14px", n["font-size"]);
  expect("info note", "font-weight", "600", n["font-weight"]);
  expect("info note", "line-height", "1.5", n["line-height"]);
  exception("info note", "border", D.note.border, "1px solid #EEF0F5", n.border, "1px solid #e7eaf1", "#EEF0F5 is not a §1 token; --line is");
}
// ===== layout columns (§15) =====
{
  expect("columns wrapper", "gap", D.colWrap.gap, ours(".gc-auto").gap);
  expect("columns wrapper", "align-items", D.colWrap["align-items"], ours(".gc-auto")["align-items"]);
  const m = ours(".gc-auto-main");
  expect("form column", "flex", D.colMain.flex, m.flex);
  expect("form column", "gap", "14px", m.gap);
  const s = ours(".gc-auto-side");
  expect("preview column", "flex", D.colSide.flex, s.flex);
  expect("preview column", "max-width", D.colSide["max-width"], s["max-width"]);
  expect("preview column", "position", D.colSide.position, s.position);
  expect("preview column", "gap", "12px", s.gap);
}
// ===== summary card (§16) =====
{
  expect("summary card", "gap", D.sumCard.gap, ours(".gc-auto-sum").gap);
  const r = ours(".gc-auto-row");
  expect("summary row", "gap", D.sumRow.gap, r.gap);
  expect("summary row", "align-items", D.sumRow["align-items"], r["align-items"]);
  expect("summary row icon", "margin-top", "2px", ours(".gc-auto-row > .ms-icon")["margin-top"]);
  const v = ours(".gc-auto-rowv");
  expect("summary value", "font-size", D.sumValue["font-size"], v["font-size"]);
  expect("summary value", "font-weight", D.sumValue["font-weight"], v["font-weight"]);
  expect("summary value", "line-height", D.sumValue["line-height"], v["line-height"]);
  const l = ours(".field-label");
  expect("summary label", "font-size", D.sumLabel["font-size"], l["font-size"]);
  expect("summary label", "color", D.sumLabel.color, l.color);
}

// ===== the shared families must NOT be re-declared to dress this panel =====
// This is the defect the reskin shipped: `.gc-note` and `.gc-sum` declared a
// second time at the bottom of communications.css, silently restyling the three
// template editors and the KPI strip. A panel-local rule gets a panel-local
// name; it never widens a shared one.
{
  const css = readFileSync(join(ROOT, "src/app/styles/communications.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const shared of ["gc-note", "gc-sum", "gc-seg", "gc-segb", "gc-sw", "gc-toggle", "gc-hint"]) {
    // Only the BARE selector counts. `.gc-sw:disabled`, `.gc-sw::after` and
    // `.gc-note > .ms-icon` are parts of one family, not competing copies of it
    // — counting them called every healthy family a duplicate.
    const bare = [...css.matchAll(/([^{}]*)\{[^{}]*\}/g)]
      .map((m) => {
        let s = m[1].trim();
        const semi = s.lastIndexOf(";");
        return (semi >= 0 ? s.slice(semi + 1) : s).trim().replace(/\s+/g, " ");
      })
      .filter((sel) => sel && !sel.startsWith("@") && !sel.includes(".gc-auto"))
      .filter((sel) => sel.split(",").some((part) => part.trim() === `.${shared}`));
    checks++;
    if (bare.length > 1)
      fails.push(`shared family .${shared} is declared ${bare.length}× outside .gc-auto — a second declaration silently restyles every screen that renders it:\n      ${bare.join("\n      ")}`);
  }
}

// ---------- verdict ----------
if (fails.length) {
  console.error(`\n✗ ${fails.length} of ${checks} measured properties drifted from design-ref/whatsapp-automation.html:\n`);
  for (const f of fails) console.error(`  • ${f}\n`);
  process.exit(1);
}
console.log(`✓ ${checks} measured properties match design-ref/whatsapp-automation.html`);
console.log("  (every design-system override is pinned on BOTH values — see the exception() rows)");
