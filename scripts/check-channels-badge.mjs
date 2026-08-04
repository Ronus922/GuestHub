// Runnable checks for the reservation-channel badge (same pattern as
// check-calendar.mjs): compiles the pure token module, asserts the exact
// badge-channel mapping — the four externals PLUS the manual pencil (D107/D135:
// EVERY reservation wears a badge; the legend shows only the externals) — then
// asserts the three surfaces are wired to the ONE component/config.
// Usage: node scripts/check-channels-badge.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

const out = mkdtempSync(join(tmpdir(), "channels-"));
execSync(
  `pnpm exec tsc src/lib/colors.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { CHANNEL_CONFIG, CHANNEL_ORDER, normalizeVisibleChannel, resolveChannelBadge } = require(join(out, "colors.js"));

// ---- the FIVE badge channels — four externals + manual pencil (D107/D135) ----
assert.deepEqual(
  Object.keys(CHANNEL_CONFIG).sort(),
  ["airbnb", "booking", "expedia", "manual", "site"],
  "five badge channel definitions — the four externals PLUS manual (every reservation gets a badge)",
);
assert.deepEqual(CHANNEL_CONFIG.booking, { glyph: "B", bg: "#003580", tx: "#FFFFFF", name: "Booking.com" });
assert.deepEqual(CHANNEL_CONFIG.airbnb, { glyph: "A", bg: "#FF5A5F", tx: "#FFFFFF", name: "Airbnb" });
assert.deepEqual(CHANNEL_CONFIG.expedia, { glyph: "E", bg: "#FFC400", tx: "#1B2233", name: "Expedia" });
assert.deepEqual(CHANNEL_CONFIG.site, { icon: "globe", bg: "#2540C8", tx: "#FFFFFF", name: "אתר המלון" });
assert.deepEqual(
  CHANNEL_CONFIG.manual,
  { icon: "edit", bg: "#E6E9F0", tx: "#5B6478", name: "הזמנה ידנית" },
  "manual = the pencil badge (D107/D135)",
);
// the LEGEND is exactly the four externals — manual is never a legend channel
assert.deepEqual([...CHANNEL_ORDER], ["booking", "airbnb", "expedia", "site"], "legend order — exactly the four externals");
assert.ok(!CHANNEL_ORDER.includes("manual"), "manual never appears in the legend");

// ---- normalization: lookup_items(booking_sources).key → visible channel | null ----
assert.equal(normalizeVisibleChannel("booking_com"), "booking", "imported BDC key");
assert.equal(normalizeVisibleChannel("booking"), "booking");
assert.equal(normalizeVisibleChannel("airbnb"), "airbnb");
assert.equal(normalizeVisibleChannel("expedia"), "expedia");
assert.equal(normalizeVisibleChannel("direct"), "site", "direct = the hotel's own site");
assert.equal(normalizeVisibleChannel("website"), "site");
// internal / unknown / missing sources are not VISIBLE channels (they badge as manual)
assert.equal(normalizeVisibleChannel("phone"), null, "phone is internal — not a visible channel");
assert.equal(normalizeVisibleChannel("walk_in"), null, "walk-in is internal — not a visible channel");
assert.equal(normalizeVisibleChannel("manual"), null, "manual is internal — not a visible channel");
assert.equal(normalizeVisibleChannel("hostelworld"), null, "unmapped OTA never guesses a brand");
assert.equal(normalizeVisibleChannel(""), null, "empty source — not a visible channel");
assert.equal(normalizeVisibleChannel(null), null, "null source — not a visible channel");
assert.equal(normalizeVisibleChannel(undefined), null, "undefined source — not a visible channel");

// ---- EVERY reservation resolves to a badge: its channel, or the manual pencil ----
assert.equal(resolveChannelBadge("booking_com"), "booking", "imported BDC key → its brand badge");
assert.equal(resolveChannelBadge("direct"), "site", "direct = the hotel's own site");
assert.equal(resolveChannelBadge("phone"), "manual", "internal source → the pencil badge");
assert.equal(resolveChannelBadge("walk_in"), "manual");
assert.equal(resolveChannelBadge("hostelworld"), "manual", "unmapped OTA never guesses a brand — pencil");
assert.equal(resolveChannelBadge(null), "manual", "missing source → the pencil badge (never nothing)");
assert.equal(resolveChannelBadge(undefined), "manual", "undefined source → the pencil badge");

// ---- the badge component: any badge channel, accessibility, no shrink ----
const badge = readFileSync("src/components/shared/ChannelBadge.tsx", "utf8");
assert.match(badge, /channel: BadgeChannel;/, "badge accepts any badge channel — external or manual");
assert.match(
  badge,
  /c\.icon \? <Icon name=\{c\.icon\}/,
  "site/manual wear a Material Symbol (globe/pencil); letter channels keep their glyph",
);
assert.match(badge, /aria-label=\{label\}/, "badge carries aria-label");
assert.match(badge, /title=\{label\}/, "badge carries native title");
assert.match(badge, /ערוץ: \$\{c\.name\}/, "accessible name is ערוץ: {full name}");
const ds = readFileSync("src/app/styles/design-system.css", "utf8");
assert.match(ds, /\.ch-badge \{[^}]*flex: none;/s, ".ch-badge never shrinks (flex: none)");
assert.match(ds, /\.ch-badge \{[^}]*border-radius: 50%;/s, ".ch-badge stays circular");
assert.match(ds, /\.ch-badge\.ring \{\s*box-shadow: 0 0 0 1\.5px rgba\(255, 255, 255, 0\.65\);/, "white separation ring");

// ---- the three surfaces consume the ONE component + config, conditionally ----
const grid = readFileSync("src/app/(dashboard)/calendar/CalendarGrid.tsx", "utf8");
assert.match(
  grid,
  /resolveChannelBadge\(stay\.source_key\)/,
  "pill channel resolves via resolveChannelBadge — internal sources get the pencil",
);
assert.match(
  grid,
  /<ChannelBadge channel=\{channel\} size="lg" ring \/>\s*\{stay\.is_vip/,
  "pill: EVERY reservation wears a badge (D107/D135 — no conditional wrapper), VIP star follows",
);
assert.match(
  grid,
  /\{dragChannel && <ChannelBadge channel=\{dragChannel\} size="lg" ring \/>\}/,
  "drag ghost wears the same badge (absent only while no drag is in progress)",
);
const tip = readFileSync("src/app/(dashboard)/calendar/ReservationTooltip.tsx", "utf8");
assert.match(
  tip,
  /resolveChannelBadge\(stay\.source_key\)/,
  "popover resolves the SAME badge the pill wears",
);
assert.doesNotMatch(
  tip,
  /\{channel && \(/,
  "the channel row is UNCONDITIONAL — every reservation has one (D135)",
);
assert.match(tip, /ערוץ: <b>\{CHANNEL_CONFIG\[channel\]\.name\}<\/b>/, "popover channel row text");
assert.match(tip, /<ChannelBadge channel=\{channel\} size="md" \/>/, "popover badge: md, no ring");
assert.doesNotMatch(tip, /מקור:/, "old free-text source row stays consolidated — never restored");
const screen = readFileSync("src/app/(dashboard)/calendar/CalendarScreen.tsx", "utf8");
assert.match(screen, /ערוצים/, "legend heading");
assert.match(screen, /CHANNEL_ORDER\.map/, "legend renders the four channels from the one order");
assert.match(screen, /<ChannelBadge channel=\{ch\} size="sm" \/>/, "legend badge: sm");
// the manual presentation lives in the ONE token file; nobody re-types it
const colors = readFileSync("src/lib/colors.ts", "utf8");
assert.match(colors, /הזמנה ידנית/, "colors.ts (the token file) defines the manual badge display name");
assert.match(colors, /#E6E9F0/i, "colors.ts holds the manual badge background token");
for (const [f, src] of [
  ["ChannelBadge.tsx", badge],
  ["CalendarGrid.tsx", grid],
  ["ReservationTooltip.tsx", tip],
  ["CalendarScreen.tsx", screen],
]) {
  assert.doesNotMatch(src, /הזמנה ידנית|#E6E9F0/i, `${f} re-types the manual badge presentation (colors.ts owns it)`);
}
// nobody re-types a channel hex outside the token files
for (const [f, src] of [
  ["ChannelBadge.tsx", badge],
  ["CalendarGrid.tsx", grid],
  ["ReservationTooltip.tsx", tip],
  ["CalendarScreen.tsx", screen],
]) {
  assert.doesNotMatch(src, /#003580|#FF5A5F|#FFC400/i, `${f} duplicates a channel color`);
}

console.log("check-channels-badge: badge-channel mapping (externals + manual pencil), externals-only legend and all three surfaces verified ✔");
