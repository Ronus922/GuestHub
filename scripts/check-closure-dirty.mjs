#!/usr/bin/env node
// ============================================================
// check:closure-dirty — a form only asks about work that exists.
//
// THE DEFECT THIS EXISTS FOR, measured by the owner on main after
// fix/closure-panel-ux landed: clicking the door+lock shortcut in the booking
// wizard raised "יש שינויים שלא נשמרו — לסגור בכל זאת?" on a wizard nobody had
// typed into. The closure form would not open without an answer to a question
// with no subject.
//
// The cause was not the shortcut. It was the dirty check underneath it, which
// every exit route shares — the X, Escape, the overlay, and the shortcut. The
// baseline fingerprint was taken the instant the wizard opened, with "שולם" at
// 0; a few hundred milliseconds later the live quote came back and the wizard
// copied the total into that very field ITSELF. From then on the form differed
// from its own baseline, and said so, forever. A wizard opened from a calendar
// drag — the one path that has a room and dates to quote, and the one path the
// shortcut was built for — was therefore dirty before anyone touched it.
//
// So the claims here are about the RULE, not about the button: a field the form
// fills in by itself is not the operator's change, and a baseline must describe
// the state the form actually opened in.
//
// Runtime where it can be (lib/reservations/form-dirty.ts is compiled and
// CALLED), static where it cannot (a React state machine needs a browser).
// No DB, no network, no build.
// D127 collect-all: every failure is reported, then the guard fails once.
// Usage: node scripts/check-closure-dirty.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

// ---- compile the real pure module, same harness as check:closure-panel-ux ----
const tmp = mkdtempSync(join(tmpdir(), "gh-closuredirty-"));
const out = join(tmp, "out");
writeFileSync(
  join(tmp, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "commonjs", moduleResolution: "node10", target: "es2022",
      esModuleInterop: true, skipLibCheck: true, strict: true,
      baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
      rootDir: join(ROOT, "src"), outDir: out,
      typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
    },
    include: [join(ROOT, "src/lib/reservations/form-dirty.ts")],
  }),
);
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const req = createRequire(join(ROOT, "package.json"));
const { AUTO_FILLED, autoFilled, formFingerprint } = req(join(out, "lib/reservations/form-dirty.js"));

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const BOOKING = "src/components/reservations/BookingPanel.tsx";
const SIDEPANEL = "src/components/ui/SidePanel.tsx";
const SCREEN = "src/app/(dashboard)/calendar/CalendarScreen.tsx";

const booking = stripComments(read(BOOKING));
const sidepanel = stripComments(read(SIDEPANEL));
const screen = stripComments(read(SCREEN));

/** the source from `from` up to the first line that is exactly `}` or `);` */
const region = (src, from, to) => {
  const a = src.indexOf(from);
  if (a < 0) return "";
  const b = src.indexOf(to, a + from.length);
  return b < 0 ? src.slice(a) : src.slice(a, b + to.length);
};

// ============================================================
// 1. A wizard nobody has touched is not dirty — RUN over the real rule
//
// The wizard's own field list, in the wizard's own order, with the values a
// drag-opened wizard actually holds at the moment it appears.
// ============================================================
{
  const OPEN = {
    guest: { firstName: "", lastName: "", phone: "", email: "", idNumber: "", country: "ישראל", language: "עברית" },
    sourceId: "src-direct",
    stays: [{ key: "stay-1", roomId: "room-7", checkIn: "2026-09-01", checkOut: "2026-09-04", adults: 2, children: 0, infants: 0 }],
    pricing: { discountMode: "none", discountValue: 0, taxExempt: false, currency: "ILS" },
    paid: 0,
    paidTouched: false,
    method: "cash",
    notes: "",
    arrivalTime: "",
    asDraft: false,
    cc: { holder: "", number: "", exp: "", cvv: "", idNum: "", source: "back_office", billingNotes: "" },
  };
  // exactly the composition formSnapshot() performs in the wizard
  const fp = (o) => formFingerprint([
    o.guest, o.sourceId, o.stays, o.pricing,
    autoFilled(o.paidTouched, o.paid),
    o.method, o.notes, o.arrivalTime, o.asDraft, o.cc,
  ]);
  const at = (over) => fp({ ...OPEN, ...over });
  const baseline = at({});

  // THE regression, run: the quote lands, the wizard copies the total into
  // "שולם" by itself, and the operator has still done nothing.
  assert.equal(at({ paid: 1750 }), baseline,
    "the live quote landing in \"שולם\" is NOT an unsaved change — this is the defect: a drag-opened wizard rewrote that field itself and then reported work nobody had done");

  // …and the same value, once it is the operator's, counts in full
  assert.notEqual(at({ paid: 1750, paidTouched: true }), baseline,
    "an amount typed by hand IS a change — hiding the auto-fill must not hide the operator");
  assert.notEqual(at({ paidTouched: true }), baseline,
    "…and so is taking the field over at the same number ('לא שולם' on a zero total is a decision, not a no-op)");

  // one manual change of any other field, in either direction
  assert.notEqual(at({ notes: "מגיעים אחרי חצות" }), baseline, "a typed note is a change");
  assert.notEqual(at({ arrivalTime: "22:00" }), baseline, "a picked arrival time is a change");
  assert.notEqual(at({ sourceId: "src-booking-com" }), baseline, "a changed booking source is a change");
  assert.notEqual(at({ stays: [{ ...OPEN.stays[0], roomId: "room-9" }] }), baseline, "a changed room is a change");
  assert.notEqual(at({ guest: { ...OPEN.guest, firstName: "רונן" } }), baseline, "a typed guest name is a change");

  // …while the row identity React regenerates on every open is not content
  assert.equal(at({ stays: [{ ...OPEN.stays[0], key: "stay-2" }] }), baseline,
    "a regenerated stay key is not a change — it describes the render, and counting it would make every wizard dirty at birth");

  // the sentinel cannot be typed into a form by a person
  assert.notEqual(autoFilled(true, "auto-filled"), AUTO_FILLED,
    "a field genuinely holding the text 'auto-filled' does not read as auto-filled");

  ok("the rule, RUN: a field the form fills in by itself is not the operator's change, and every real edit still is");
}

// ============================================================
// 2. The wizard actually uses that rule, and its baseline tells the truth
//    about the state the form opened in
// ============================================================
{
  const snap = region(booking, "function formSnapshot(", "\n}");
  assert.ok(snap, "formSnapshot exists — one fingerprint, taken the same way on both sides of the comparison");
  assert.match(snap, /formFingerprint\(\[/,
    "…computed by the shared pure rule, so what the guard runs is what the wizard runs");
  assert.match(snap, /autoFilled\(paidTouched, paid\)/,
    "…with \"שולם\" compared through autoFilled — THE fix: the field the wizard writes by itself does not speak until the operator takes it over");
  assert.doesNotMatch(snap, /JSON\.stringify/,
    "…and no second, private stringify beside it, which is how the two sides drift apart");

  // the baseline is taken AFTER the defaults and the drag context are resolved
  const base = region(booking, "snapshotRef.current = formSnapshot(", ");");
  assert.ok(base, "the baseline is taken in the open-reset");
  for (const [value, why] of [
    ["initialSource", "the tenant's first booking source"],
    ["initialStays", "the row the calendar drag filled in"],
    ["initialMethod", "the default payment method"],
  ]) {
    assert.match(base, new RegExp(value),
      `the baseline is taken WITH ${why} already in it — a baseline of "empty" would call every default an unsaved change`);
  }
  assert.match(base, /0,\s*false,/,
    "…and with \"שולם\" marked untouched, which at open it is by definition");

  // the live side reads the same flag the auto-writer obeys
  const live = region(booking, "const dirty =", ";");
  assert.match(live, /paidTouched\.current/,
    "the live fingerprint asks the SAME flag that stops the auto-fill from overwriting a hand-edited amount — one source of truth for 'this is theirs now'");
  assert.match(booking, /if \(paidTouched\.current\) return;[\s\S]{0,200}setPaid\(/,
    "the wizard still fills \"שולם\" from the live total by itself — which is exactly WHY that field is compared through autoFilled");

  // a baseline may only hardcode a value the open-reset actually restores
  const resetAt = booking.indexOf("setStays(initialStays)");
  const baseAt = booking.indexOf("snapshotRef.current = formSnapshot(");
  const armAt = booking.indexOf('setArrivalTime("")');
  assert.ok(armAt > -1 && resetAt > -1 && baseAt > -1 && armAt > resetAt && armAt < baseAt,
    "שעת ההגעה is cleared in the open-reset, before the baseline claims it is empty — it used to survive from the previous wizard run, so the second booking opened dirty AND carried a stranger's arrival time into the save");

  ok("the wizard is compared against the state it opened in — defaults and drag context included — never against empty");
}

// ============================================================
// 3. No wizard, no question
// ============================================================
{
  assert.match(sidepanel, /\{open && \(/,
    "a closed SidePanel renders nothing — so nothing inside the wizard exists while it is closed, and nothing inside it can ask a question");
  // …and there is no longer any door INSIDE the wizard leading out of it. The
  // shortcut this guard was born over is gone (owner ruling this run): the
  // closure form is opened from the calendar, so the unsaved-changes question
  // can only ever be raised by the wizard's OWN exits — the X, Escape, the
  // overlay. A route that does not exist cannot ask about work nobody typed.
  assert.doesNotMatch(booking, /openClosureShortcut|closureAfterDiscard|bw-close-room|ClosurePanel/,
    "the wizard carries no closure shortcut at all — the one route that could raise the question on the way to a different job");

  // the calendar's ways into the closure form never pass through any of this
  assert.doesNotMatch(screen, /dirty/,
    "the calendar's closure entry points know nothing about wizard dirt — a header click with no wizard open cannot raise an unsaved-changes question");
  assert.match(screen, /<ClosurePanel\s+open=\{panel\?\.kind === "closure"\}/,
    "…they open the closure form straight from the board's panel state");

  ok("the unsaved-changes question belongs to an open wizard's own exits and to nothing else");
}

console.log(`\nAll ${n} dirty-check claim groups hold.`);
