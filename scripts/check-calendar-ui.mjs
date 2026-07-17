// Runnable checks for the pure calendar interaction/geometry module (same
// pattern as check-calendar.mjs): compiles the pure module with tsc,
// imports it and asserts the click-vs-drag, snapping, geometry and
// read-only rules the grid relies on. Usage: node scripts/check-calendar-ui.mjs
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "calendar-ui-"));
execSync(
  `pnpm exec tsc src/lib/dates.ts src/lib/calendar-interactions.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const ix = require(join(out, "calendar-interactions.js"));

// ---- movement threshold (§6): below 6px = click, above = drag ----
assert.equal(ix.DRAG_THRESHOLD_PX, 6);
assert.equal(ix.dragActivated(0, 0), false, "no movement is a click");
assert.equal(ix.dragActivated(6, 0), false, "at the threshold still a click");
assert.equal(ix.dragActivated(7, 0), true, "past the threshold horizontally = drag");
assert.equal(ix.dragActivated(0, -7), true, "past the threshold vertically = drag");
assert.equal(ix.dragActivated(-4, 5), false, "diagonal jitter under threshold = click");

// ---- click vs drag/resize outcomes (§3/§4). A plain click opens the side
// panel; an activated move/resize of an EXISTING reservation CONFIRMS (never
// opens, never persists yet); an empty-cell drag commits to the new-booking
// panel. ----
assert.equal(ix.dragEndAction("move", false), "open", "1. plain click on the card opens the side panel");
assert.equal(ix.dragEndAction("move", true), "confirm", "2/3. an activated room/date move confirms, never opens");
assert.equal(ix.dragEndAction("resize", false), "none", "clicking the resize handle NEVER opens");
assert.equal(ix.dragEndAction("resize", true), "confirm", "4/5. a resize extend/reduce confirms, never opens");
assert.equal(ix.dragEndAction("create", false), "none", "a plain click on an empty cell never opens anything");
assert.equal(ix.dragEndAction("create", true), "commit", "9. an activated cell drag hands off to the new-booking panel");

// ---- operation classification for the confirmation dialog (§2) ----
const RA = "room-a", RB = "room-b";
assert.equal(
  ix.describeReschedule({ roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-03" },
    { roomId: RB, checkIn: "2026-08-01", checkOut: "2026-08-03" }), "room",
  "same dates, different room → שינוי חדר");
assert.equal(
  ix.describeReschedule({ roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-03" },
    { roomId: RA, checkIn: "2026-08-02", checkOut: "2026-08-04" }), "dates",
  "same nights, shifted → שינוי תאריכים");
assert.equal(
  ix.describeReschedule({ roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-03" },
    { roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-05" }), "extend",
  "later checkout → הארכת שהות");
assert.equal(
  ix.describeReschedule({ roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-05" },
    { roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-03" }), "shorten",
  "earlier checkout → קיצור שהות");
assert.equal(
  ix.describeReschedule({ roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-03" },
    { roomId: RB, checkIn: "2026-08-02", checkOut: "2026-08-05" }), "room_dates",
  "room + dates → שינוי חדר ותאריכים");
assert.equal(
  ix.describeReschedule({ roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-03" },
    { roomId: RA, checkIn: "2026-08-01", checkOut: "2026-08-03" }), "none",
  "no change → none");

// ---- hover tooltip timing (§2): deliberate open, shorter close grace ----
assert.ok(ix.TOOLTIP_OPEN_MS >= 200 && ix.TOOLTIP_OPEN_MS <= 800, "tooltip opens after a short, deliberate delay");
assert.ok(ix.TOOLTIP_CLOSE_MS > 0 && ix.TOOLTIP_CLOSE_MS < ix.TOOLTIP_OPEN_MS, "close grace is shorter than the open delay");

// ---- empty-cell selection activation (§4): horizontal-dominant only ----
assert.equal(ix.createActivated(7, 3), true, "horizontal drag past threshold starts a selection");
assert.equal(ix.createActivated(-7, 3), true, "both horizontal directions work");
assert.equal(ix.createActivated(7, 8), false, "vertical-dominant movement is a scroll, not a selection");
assert.equal(ix.createActivated(5, 0), false, "below the threshold nothing activates");

// ---- empty-cell range target (§4): whole nights, exclusive checkout ----
let cr = ix.createRangeTarget("2026-07-10", 0);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-10", "2026-07-11", 1], "single cell = one night");
cr = ix.createRangeTarget("2026-07-10", 2);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-10", "2026-07-13", 3], "dragging left (RTL) selects later nights");
cr = ix.createRangeTarget("2026-07-10", -2);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-08", "2026-07-11", 3], "dragging right selects earlier nights, anchor stays a night");
cr = ix.createRangeTarget("2026-07-10", 0, 2);
assert.deepEqual([cr.ci, cr.co, cr.nights], ["2026-07-10", "2026-07-12", 2], "cell min-stay stretches a single-cell selection");

// ---- selection band geometry: full cells, not mid-cell ----
let cg = ix.cellRangeGeometry("2026-07-04", 21, "2026-07-08", "2026-07-11");
assert.ok(Math.abs(cg.start - 4 / 21) < 1e-9, "selection starts at the cell edge");
assert.ok(Math.abs(cg.width - 3 / 21) < 1e-9, "3 selected nights = exactly 3 whole cells");
cg = ix.cellRangeGeometry("2026-07-04", 21, "2026-07-01", "2026-07-06");
assert.equal(cg.start, 0, "selection clips at the visible range start");
cg = ix.cellRangeGeometry("2026-07-04", 21, "2026-07-20", "2026-08-02");
assert.ok(Math.abs(cg.start + cg.width - 1) < 1e-9, "selection clips at the visible range end");

// ---- RTL day snapping: dragging left = later dates ----
assert.equal(ix.snapDayDelta(500, 500, 65), 0);
assert.equal(ix.snapDayDelta(500, 435, 65), 1, "one column left = +1 day");
assert.equal(ix.snapDayDelta(500, 565, 65), -1, "one column right = -1 day");
assert.equal(ix.snapDayDelta(500, 470, 65), 0, "less than half a column snaps back");
assert.equal(ix.snapDayDelta(500, 466, 65), 1, "more than half a column snaps forward");
assert.equal(ix.snapDayDelta(500, 400, 0), 0, "zero column width never divides by zero");
assert.equal(ix.snapRowDelta(300, 356, 56), 1);
assert.equal(ix.snapRowDelta(300, 245, 56), -1);

// ---- move target: clamped to the room list, dates shift together ----
const stay = { check_in: "2026-07-10", check_out: "2026-07-13" };
let t = ix.moveTarget(stay, 2, 1, 1, 12);
assert.deepEqual([t.roomIndex, t.ci, t.co, t.changed], [3, "2026-07-11", "2026-07-14", true]);
t = ix.moveTarget(stay, 0, 0, -5, 12);
assert.equal(t.roomIndex, 0, "room delta clamps at the first room");
t = ix.moveTarget(stay, 11, 0, 9, 12);
assert.equal(t.roomIndex, 11, "room delta clamps at the last room");
t = ix.moveTarget(stay, 4, 0, 0, 12);
assert.equal(t.changed, false, "no delta = nothing to commit");

// ---- resize target: checkout-exclusive, minimum one night ----
let r = ix.resizeTarget(stay, 2);
assert.deepEqual([r.co, r.extending, r.changed], ["2026-07-15", true, true]);
r = ix.resizeTarget(stay, -2);
assert.deepEqual([r.co, r.extending, r.changed], ["2026-07-11", false, true]);
r = ix.resizeTarget(stay, -10);
assert.equal(r.co, "2026-07-11", "checkout never drops below check-in + 1");
r = ix.resizeTarget(stay, 0);
assert.equal(r.changed, false);

// ---- delta-only resize preview (§J): committed pill untouched ----
assert.equal(ix.resizeDeltaRange(stay, "2026-07-13"), null, "no delta, no preview");
let d = ix.resizeDeltaRange(stay, "2026-07-15");
assert.deepEqual([d.from, d.to, d.extending], ["2026-07-13", "2026-07-15", true], "extension previews only the added nights");
d = ix.resizeDeltaRange(stay, "2026-07-11");
assert.deepEqual([d.from, d.to, d.extending], ["2026-07-11", "2026-07-13", false], "shortening previews only the removed nights");

// ---- bar geometry: mid-cell to mid-cell fractions, clip at range edges ----
const days = 21;
let g = ix.barGeometry("2026-07-04", days, "2026-07-08", "2026-07-11");
assert.ok(Math.abs(g.start - 4.5 / 21) < 1e-9, "starts at check-in midpoint");
assert.ok(Math.abs(g.width - 3 / 21) < 1e-9, "3 nights = exactly 3 columns");
assert.equal(g.clippedStart, false);
assert.equal(g.clippedEnd, false);
g = ix.barGeometry("2026-07-04", days, "2026-07-10", "2026-07-11");
assert.ok(Math.abs(g.width - 1 / 21) < 1e-9, "one-night stay = exactly one column");
g = ix.barGeometry("2026-07-04", days, "2026-07-01", "2026-07-06");
assert.equal(g.clippedStart, true, "check-in before the window clips flat");
assert.equal(g.start, 0);
assert.ok(Math.abs(g.width - 2.5 / 21) < 1e-9, "clipped start still ends mid-checkout-cell");
g = ix.barGeometry("2026-07-04", days, "2026-07-20", "2026-08-02");
assert.equal(g.clippedEnd, true, "checkout after the window clips flat");
assert.ok(Math.abs(g.start + g.width - 1) < 1e-9, "clipped end reaches the range edge");
g = ix.barGeometry("2026-07-04", days, "2026-07-01", "2026-07-04");
assert.ok(Math.abs(g.width - 0.5 / 21) < 1e-9, "checkout on the first visible morning = half-column stub, like the reference");
// same math a drag ghost uses — previews and committed pills cannot drift
const ghost = ix.barGeometry("2026-07-04", days, "2026-07-08", "2026-07-11");
assert.deepEqual(ghost, ix.barGeometry("2026-07-04", days, "2026-07-08", "2026-07-11"));

// ---- read-only rule (§11): no edit permission / pending commit = no drag ----
assert.equal(ix.canDragCard(true, false), true);
assert.equal(ix.canDragCard(false, false), false, "read-only users get no drag affordance");
assert.equal(ix.canDragCard(true, true), false, "a card mid-commit cannot be dragged again");

// ============================================================
// D41 interaction-model rules, asserted against the real sources:
// informational tooltip + side-panel booking/editing (no full-screen path)
// ============================================================
const { readFileSync, existsSync } = await import("node:fs");
// comments stripped — rules are about code, not the explanatory notes
const src = (p) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// tooltip is informational only — zero write paths, and NON-INTERACTIVE (D44)
const tooltip = src("src/app/(dashboard)/calendar/ReservationTooltip.tsx");
assert.ok(!tooltip.includes("אישור הזמנה"), "tooltip has NO confirmation button");
assert.ok(!/updateReservationAction|createReservationAction|cancelReservationAction|Action\(/.test(tooltip),
  "tooltip calls no server action at all");
assert.ok(!/useTransition|toast\./.test(tooltip), "tooltip has no mutation/loading state");
assert.ok(/role="tooltip"/.test(tooltip), "accessibility role preserved");
assert.ok(/draft/.test(tooltip), "pending/draft badge stays as informational content");
// (the old "multi-room information preserved" invariant is gone: the approved
// card — InvitationCard.png — carries four rows and no multi-room row. The D88
// structure block below is the authority on what the card shows.)
// D44 §1/§7: the tooltip cannot be a pointer/click/drag target at all
const cssPop = readFileSync("src/app/styles/calendar.css", "utf8")
  .match(/\.cb-pop\s*\{[^}]*\}/);
assert.ok(cssPop && /pointer-events:\s*none/.test(cssPop[0]), "1/7. tooltip is pointer-events:none");
assert.ok(!/onPointerDown|onPointerUp|onClick|onPointerEnter|onPointerLeave/.test(tooltip),
  "7. tooltip binds no pointer/click handlers (cannot capture or become a drop target)");
assert.ok(!/onEdit|cb-pbtn/.test(tooltip), "7. tooltip has NO interactive edit button");
assert.ok(/const GAP/.test(tooltip) && /anchor\.top - h - GAP/.test(tooltip) && /anchor\.bottom \+ GAP/.test(tooltip),
  "2. tooltip is offset OUTSIDE the pill (above with a gap, flipping below)");

// booking + edit flows live in the shared SidePanel shell — no full screen
assert.ok(!existsSync("src/components/ui/FullWindow.tsx"), "FullWindow was removed");
const booking = src("src/components/reservations/BookingPanel.tsx");
const editor = src("src/components/reservations/EditReservationPanel.tsx");
for (const [name, s] of [["BookingPanel", booking], ["EditReservationPanel", editor]]) {
  assert.ok(/from "@\/components\/ui\/SidePanel"/.test(s), `${name} renders inside the SidePanel shell`);
  assert.ok(!/FullWindow/.test(s), `${name} has no full-screen window`);
  assert.ok(/requestClose/.test(s) && /confirmDiscard/.test(s), `${name} has dirty-state close protection`);
}

// one open panel at a time — a single source of truth on the screen.
// New booking is NOT a calendar-local panel: since D48 it goes through the ONE
// shared BookingPanel behind useNewReservation() (mounted once in the Shell), so
// the sidebar and the calendar open the very same editor. The calendar's own
// PanelState therefore covers edit + closure only.
const screen = src("src/app/(dashboard)/calendar/CalendarScreen.tsx");
assert.ok(/PanelState/.test(screen) && /setPanel\(\{ kind: "edit"/.test(screen),
  "edit/closure share ONE calendar panel state");
assert.ok(/useNewReservation\(\)/.test(screen) && !/setPanel\(\{ kind: "booking"/.test(screen),
  "new booking goes through the shared global BookingPanel — never a calendar-local duplicate");
assert.ok(!/FullWindow/.test(screen), "the calendar screen never opens a full-screen window");

// the panel stacks above every calendar layer (tooltip 60, date picker 80)
const sidePanel = src("src/components/ui/SidePanel.tsx");
assert.ok(/z-\[90\]/.test(sidePanel), "side panel renders above tooltip/context-menu/date-picker");

// ============================================================
// D44 deterministic interaction lifecycle + tooltip, asserted on the sources
// (the real browser sequence is exercised by scripts/verify-calendar-browser)
// ============================================================
const grid = src("src/app/(dashboard)/calendar/CalendarGrid.tsx");
// a completed move/resize opens the confirmation dialog and does NOT persist at
// pointer-up — the reschedule action is reachable ONLY from the dialog's confirm
// handler (runReschedule), never directly from openConfirm.
assert.ok(/action === "confirm"/.test(grid) && /openConfirm\(s\)/.test(grid),
  "a confirmed drag/resize opens the confirmation flow, not the panel");
assert.ok(/setConfirmMove\(/.test(grid) && /MoveConfirmDialog/.test(grid),
  "6. a completed drag/resize renders the floating confirmation dialog");
const openConfirmBody = grid.match(/const openConfirm = useCallback\(([\s\S]*?)\n  \);/);
assert.ok(openConfirmBody && !/rescheduleReservationRoomAction/.test(openConfirmBody[1]),
  "8/18. openConfirm NEVER persists — it only proposes; the server runs on confirm");
assert.ok(/const runReschedule =[\s\S]*?rescheduleReservationRoomAction\(/.test(grid),
  "8/18. persistence happens only in runReschedule (the אישור handler)");
// deterministic lifecycle (D44) — an explicit phase model, NOT a one-shot flag
assert.ok(/phaseRef = useRef<[\s\S]*?"awaiting_confirmation"/.test(grid),
  "3. an explicit interaction phase model exists (idle→pressed→dragging/resizing→awaiting_confirmation)");
assert.ok(/phaseRef\.current = s\.mode === "resize" \? "resizing" : "dragging"/.test(grid),
  "3. crossing the threshold records dragging/resizing");
// 4/13/14: the post-drag synthetic click is swallowed in the CAPTURE phase,
// tied to the pointer id (not a timeout), before any handler can open the editor
assert.ok(/suppressClickRef = useRef<number \| null>/.test(grid),
  "4/13. the completed-drag marker is the pointer id (deterministic, not a boolean+timeout)");
assert.ok(/suppressClickRef\.current = e\.pointerId/.test(grid) && !/setTimeout\(\(\) => \(suppressClickRef/.test(grid),
  "4. the marker is set on the activated pointer-up and NOT reset on a timeout");
assert.ok(/onBodyClickCapture[\s\S]*?stopPropagation\(\)[\s\S]*?preventDefault\(\)/.test(grid),
  "4/14. a capture-phase suppressor consumes the synthetic click and blocks bubbling");
assert.ok(/onClickCapture=\{onBodyClickCapture\}/.test(grid),
  "14. the capture handler is bound on the grid body so parents cannot reopen the editor");
const openEditorBody = grid.match(/const openEditor = useCallback\(([\s\S]*?)\n  \);/);
assert.ok(openEditorBody &&
  /suppressClickRef\.current !== null/.test(openEditorBody[1]) &&
  /phaseRef\.current === "awaiting_confirmation"/.test(openEditorBody[1]),
  "6–12. openEditor opens ONLY on a genuine click — never mid/after a drag or while confirming");
// tooltip hides on pointer-down and never shows during drag/confirm
assert.ok(/const onBarPointerDown[\s\S]*?phaseRef\.current = "pressed"[\s\S]*?setTip\(null\)/.test(grid),
  "3. pointer-down on a reservation hides the tooltip immediately");
assert.ok(/const onBarHoverStart[\s\S]*?phaseRef\.current !== "idle"[\s\S]*?return/.test(grid),
  "4. the tooltip never reopens during a drag/resize or pending confirmation");
// 17: empty-cell drag still opens the new-booking panel
assert.ok(/onCellPointerUp[\s\S]*?onNewBooking\(/.test(grid),
  "17. an empty-cell drag still opens the new-reservation panel");
// the tooltip is rendered non-interactively (only target + statusLabel props)
assert.ok(/<ReservationTooltip target=\{tip\} statusLabel=\{statusLabel\} \/>/.test(grid),
  "1. the tooltip is rendered with no interaction callbacks");

// the dialog: confirm persists, reject is a pure no-op, Escape/outside reject
const dialog = src("src/app/(dashboard)/calendar/MoveConfirmDialog.tsx");
assert.ok(/previewRescheduleAction\(/.test(dialog), "the dialog shows a server-computed pre-commit price");
assert.ok(/onConfirm\b/.test(dialog) && /onReject\b/.test(dialog), "אישור / דחייה actions");
assert.ok(!/rescheduleReservationRoomAction/.test(dialog),
  "7. rejecting/mounting the dialog never persists (no commit action inside it)");
assert.ok(/e\.key === "Escape"/.test(dialog) && /onReject\(\)/.test(dialog), "Escape rejects");
assert.ok(/onClick=\{onReject\}/.test(dialog), "outside (backdrop) click rejects");

// ---- reference-redesign invariants ----
// Geometry is ONE source. The drag math needs numbers, the stylesheet needs
// lengths; before the redesign the same pixels were hand-copied into both, so a
// row-height change silently desynced the grid from its drop target. The grid
// now publishes the constants as custom properties and the CSS consumes them.
const gridSrc = src("src/app/(dashboard)/calendar/CalendarGrid.tsx");
const css = src("src/app/styles/calendar.css");

assert.ok(/const BAR_H = ROW_H - BAR_TOP \* 2;/.test(gridSrc),
  "pill height is DERIVED from the row height and inset — never a third hardcoded number");
assert.ok(/GEOMETRY_VARS/.test(gridSrc) && /style=\{GEOMETRY_VARS\}/.test(gridSrc),
  "the geometry constants are published to CSS as custom properties on .cb-calin");
for (const v of ["--cb-row-h", "--cb-bar-top", "--cb-bar-h", "--cb-day-h", "--cb-month-h"]) {
  assert.ok(gridSrc.includes(v), `GEOMETRY_VARS publishes ${v}`);
  assert.ok(css.includes(`var(${v})`), `calendar.css consumes ${v} instead of a hardcoded pixel value`);
}
// The row/pill pixels must exist in exactly ONE place — the TS constants. Every
// rule that spans a row or floats a bar inside one has to read the vars, or the
// grid and its drop target silently drift apart again. (Checked per-rule, not
// file-wide: 38px is also the tooltip avatar, which is unrelated.)
const rule = (sel) => {
  const i = css.indexOf(`\n${sel} {`);
  assert.ok(i >= 0, `calendar.css is missing ${sel}`);
  return css.slice(i, css.indexOf("}", i));
};
for (const sel of [".cb-rlabel", ".cb-rstrip"]) {
  assert.ok(/height: var\(--cb-row-h\)/.test(rule(sel)),
    `${sel} must take its height from --cb-row-h, not a hardcoded pixel value`);
}
for (const sel of [".cb-resbar", ".cb-blockbar", ".cb-holdbar"]) {
  const r = rule(sel);
  assert.ok(/top: var\(--cb-bar-top\)/.test(r) && /height: var\(--cb-bar-h\)/.test(r),
    `${sel} must float on --cb-bar-top/--cb-bar-h — a bar that drifts from the row is a wrong drop target`);
}
assert.ok(/height: var\(--cb-bar-h\)/.test(rule(".cb-ghost")),
  ".cb-ghost (the drag preview) must be the same height as the pill it previews");
for (const [sel, v] of [[".cb-dcell", "--cb-day-h"], [".cb-mseg", "--cb-month-h"]]) {
  assert.ok(new RegExp(`height: var\\(${v}\\)`).test(rule(sel)), `${sel} must read ${v}`);
}

// §13 — the calendar renders in Assistant. This only holds because --font-sans
// is declared on :root: Tailwind v4 tree-shakes @theme variables that no
// utility class references, and nothing here uses a `font-sans` utility, so
// while it lived in @theme it was never emitted and the WHOLE app silently fell
// back to ui-sans-serif. Moving it back into @theme would break the font again,
// invisibly, everywhere — so pin it.
const base = src("src/app/styles/base.css");
const themeBlock = base.slice(base.indexOf("@theme"), base.indexOf(":root"));
assert.ok(!/--font-sans:/.test(themeBlock),
  "--font-sans must NOT live in @theme — Tailwind tree-shakes it and the app loses Assistant");
assert.ok(/:root\s*\{[^}]*--font-sans:\s*var\(--font-assistant\)/s.test(base),
  "--font-sans is declared on :root so it is always emitted (Assistant, D2)");
assert.ok(/\.cb-screen\s*\{[^}]*line-height:\s*normal/s.test(css),
  "the calendar matches the reference's `line-height: normal`, not Tailwind's 1.5");

// ============================================================
// D88 — the invitation card (ref/screens/InvitationCard.png) and the ONE month
// separator. Both were regressions of the same kind: a second implementation of
// something that already existed (a light-header card taken from another bundle;
// a month boundary drawn three times from three differently-sized boxes).
// ============================================================
const popRule = rule(".cb-pop");
// GUIDELINES §8 fixes every popover at 316px and cites the calendar's as the
// example — it supersedes the 366px once measured off InvitationCard.png. The
// width may live on .cb-pop itself or come composed from the canonical .popover.
assert.ok(/const POP_W = 316/.test(tooltip) || /width: 316px/.test(popRule),
  "the invitation card is the §8 canonical 316px popover");
// GUIDELINES §1 supersedes the raw 18px measured off the PNG: the card wears the
// nearest approved radius token (16px = --r-lg).
assert.ok(/border-radius: var\(--r-lg\)/.test(popRule) || /className="popover cb-pop"/.test(tooltip),
  "the card wears the approved --r-lg radius (own rule or composed from .popover)");
assert.ok(/background: var\(--brand\)/.test(rule(".cb-pop-h")),
  "the card header is the brand-blue band of InvitationCard.png — NOT a white header");
assert.ok(/color: #fff/.test(rule(".cb-pop-nm")), "the guest name is white on the blue header");
// GUIDELINES §3 supersedes the pill shape measured off the PNG: the payment tag
// is the ONE canonical chip (28px / r-sm / 13.5px/700), status class from §3.1.
assert.ok(/className=\{`chip \$\{badge\.chip\}`\}/.test(tooltip),
  "the payment tag is the canonical .chip wearing a §3.1 status class — no local badge");
assert.ok(/color: var\(--brand\)/.test(rule(".cb-pop-hint")), "the footer stays the blue action line");
// The approved card shows EXACTLY four body rows and NOTHING else. The earlier
// pass kept a fifth row (reservation number + a second order-status chip) because
// an intermediate spec said "do not remove currently available information" — the
// reference never had that row, and the reference wins. This locks the structure
// so the row cannot come back.
const body = tooltip.slice(tooltip.indexOf('<div className="cb-pop-b">'), tooltip.indexOf('cb-pop-hint'));
const rows = body.match(/<p className="cb-pl">/g) ?? [];
assert.equal(rows.length, 4, "the card body has EXACTLY four rows (dates, nights+room, channel, money)");
// The channel row CONSOLIDATED the old free-text "מקור" row (it sits between
// nights and money, per the channel-badge spec) — the normalized channel name +
// the SAME <ChannelBadge> the pill wears, so the card can never show a second,
// diverging source. The forbidden-row assertions below are unchanged.
const rowOrder = [
  ["stay dates", /name="calendar"[\s\S]*?hebDayMonth\(stay\.check_in\)/],
  ["nights + room + status", /name="moon"[\s\S]*?<b>\{nights\}<\/b> לילות · חדר/],
  ["channel", /name="hub"[\s\S]*?CHANNEL_CONFIG\[channel\]\.name[\s\S]*?<ChannelBadge channel=\{channel\} size="md" \/>/],
  ["total + balance", /name="finance"[\s\S]*?total_price\.toLocaleString\(\)/],
];
assert.ok(!/source_label|מקור:/.test(tooltip), "the old free-text source row is consolidated, not duplicated");
let cursor = 0;
for (const [what, re] of rowOrder) {
  const m = body.slice(cursor).match(re);
  assert.ok(m, `body row missing: ${what}`);
  cursor += m.index + 1;
}
assert.ok(/<div className="cb-pop-b">\s*<p className="cb-pl">\s*<Icon name="calendar"/.test(
  body.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")),
  "the FIRST body row is the stay-date row — no reservation-number row above it");
// the forbidden row, in every shape it could come back as
assert.ok(!/הזמנה <b>#/.test(tooltip) && !/#\{stay\.reservation_number\}/.test(tooltip),
  "the reservation-number row is GONE (and was not smuggled into another row)");
assert.ok(!/WorkflowChip|workflow_label|workflow_color/.test(tooltip),
  "there is NO second order-status chip anywhere on the card");
assert.ok(!/room_count/.test(tooltip), "no extra multi-room row — the reference has four rows");
assert.ok(/<bdi/.test(tooltip), "a Latin guest name / OTA source keeps its own direction inside the RTL card");

// ---- the speech-bubble pointer ----
// It is a pseudo-element welded to the card edge — not a glyph, not an SVG, not a
// separate node — and the card may NOT clip it (overflow:hidden did exactly that,
// which is why production shipped without a pointer).
assert.ok(/\.cb-pop::after\s*\{[^}]*rotate\(45deg\)/s.test(css), "the pointer is a rotated pseudo-element");
assert.ok(!/overflow:\s*hidden/.test(popRule), "the card must NOT clip its own pointer");
assert.ok(/border-radius: 16px 16px 0 0/.test(rule(".cb-pop-h")),
  "with no overflow clip, the blue header rounds its own top corners (no seam, no stray radius)");
assert.ok(/--cb-caret/.test(css) && /--cb-caret/.test(tooltip),
  "the pointer is positioned under the pill it belongs to, surviving viewport clamping");
assert.ok(/bottom: -8px/.test(css) && /top: -8px/.test(css),
  "the pointer hangs OUTSIDE the card box (adds nothing to its height), above and below");

// ---- one separator, one implementation ----
// The three old borders sized their own boxes differently (percent month band vs
// `flex: 1 1 0` cells whose border sits OUTSIDE the zero basis), so the header
// line landed ~3px off the body line AND the month-start column came out 3px
// wider than every other column. Nothing may draw a month boundary as a border
// again.
assert.ok(!/border-inline-start: 3px solid #b9c2d8/.test(css),
  "no cell/segment draws the month boundary as its own border — that is what broke the line");
const sepRule = rule(".cb-msep");
assert.ok(/position: absolute/.test(sepRule) && /width: 3px/.test(sepRule),
  ".cb-msep is ONE positioned line, not a border");
assert.ok(/var\(--cb-room-col\)/.test(sepRule) && /var\(--cb-sep\)/.test(sepRule),
  ".cb-msep hangs off the canonical column boundary (room column + fraction of the strip)");
assert.ok(/\.cb-chead \.cb-msep/.test(css) && /\.cb-cbody \.cb-msep/.test(css),
  "the same separator class serves the header and the body — no parallel implementation");
assert.ok(/{monthSeparators}/.test(gridSrc) && (gridSrc.match(/\{monthSeparators\}/g) ?? []).length === 2,
  "the header block and the body block render the SAME separator nodes");
assert.ok(/"--cb-sep": day \/ data\.days/.test(gridSrc),
  "the separator fraction is the same number the day cells divide by");
assert.ok(!/\$\{monthStart \? "ms" : ""\}/.test(gridSrc), "the obsolete month-start cell class is gone");

console.log("check-calendar-ui: all interaction/geometry rules hold ✔");
