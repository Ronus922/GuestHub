// Runnable checks for the reservation-channel badge (same pattern as
// check-calendar.mjs): compiles the pure token module, asserts the exact
// visible-channel mapping + the no-badge rule for internal reservations, then
// asserts the three surfaces are wired to the ONE component/config.
// Usage: node scripts/check-channels-badge.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "channels-"));
execSync(
  `pnpm exec tsc src/lib/colors.ts --outDir ${out} --module commonjs --target es2022 --moduleResolution node10 --skipLibCheck`,
  { stdio: "inherit" },
);
const require = createRequire(import.meta.url);
const { CHANNEL_CONFIG, CHANNEL_ORDER, normalizeVisibleChannel } = require(join(out, "colors.js"));

// ---- EXACTLY four visible channels — letters, brand colors, display names ----
assert.deepEqual(
  Object.keys(CHANNEL_CONFIG).sort(),
  ["airbnb", "booking", "expedia", "site"],
  "exactly four visible channel definitions — no manual entry",
);
assert.deepEqual(CHANNEL_CONFIG.booking, { glyph: "B", bg: "#003580", tx: "#FFFFFF", name: "Booking.com" });
assert.deepEqual(CHANNEL_CONFIG.airbnb, { glyph: "A", bg: "#FF5A5F", tx: "#FFFFFF", name: "Airbnb" });
assert.deepEqual(CHANNEL_CONFIG.expedia, { glyph: "E", bg: "#FFC400", tx: "#1B2233", name: "Expedia" });
assert.deepEqual(CHANNEL_CONFIG.site, { glyph: "S", bg: "#2540C8", tx: "#FFFFFF", name: "אתר המלון" });
assert.deepEqual([...CHANNEL_ORDER], ["booking", "airbnb", "expedia", "site"], "legend order — four entries");

// ---- normalization: lookup_items(booking_sources).key → visible channel | null ----
assert.equal(normalizeVisibleChannel("booking_com"), "booking", "imported BDC key");
assert.equal(normalizeVisibleChannel("booking"), "booking");
assert.equal(normalizeVisibleChannel("airbnb"), "airbnb");
assert.equal(normalizeVisibleChannel("expedia"), "expedia");
assert.equal(normalizeVisibleChannel("direct"), "site", "direct = the hotel's own site");
assert.equal(normalizeVisibleChannel("website"), "site");
// internal / unknown / missing sources get NO visible channel — never a badge
assert.equal(normalizeVisibleChannel("phone"), null, "phone is internal — no badge");
assert.equal(normalizeVisibleChannel("walk_in"), null, "walk-in is internal — no badge");
assert.equal(normalizeVisibleChannel("manual"), null, "manual is internal — no badge");
assert.equal(normalizeVisibleChannel("hostelworld"), null, "unmapped OTA never guesses a brand");
assert.equal(normalizeVisibleChannel(""), null, "empty source — no badge");
assert.equal(normalizeVisibleChannel(null), null, "null source — no badge");
assert.equal(normalizeVisibleChannel(undefined), null, "undefined source — no badge");

// ---- the badge component: strict visible-only, accessibility, no shrink ----
const badge = readFileSync("src/components/shared/ChannelBadge.tsx", "utf8");
assert.match(badge, /channel: VisibleChannel;/, "badge accepts ONLY a visible channel");
assert.doesNotMatch(badge, /name="edit"|Icon/, "no edit icon / no icon fallback — glyph letters only");
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
  /\{channel && <ChannelBadge channel=\{channel\} size="lg" ring \/>\}\s*\{stay\.is_vip/,
  "pill: badge renders ONLY for a visible channel (no wrapper otherwise), VIP star follows",
);
assert.match(
  grid,
  /\{dragChannel && <ChannelBadge channel=\{dragChannel\} size="lg" ring \/>\}/,
  "drag ghost follows the same visible/no-badge rule",
);
const tip = readFileSync("src/app/(dashboard)/calendar/ReservationTooltip.tsx", "utf8");
assert.match(
  tip,
  /\{channel && \(\s*<p className="cb-pl">/,
  "popover channel row renders ONLY for a visible channel — no empty row",
);
assert.match(tip, /ערוץ: <b>\{CHANNEL_CONFIG\[channel\]\.name\}<\/b>/, "popover channel row text");
assert.match(tip, /<ChannelBadge channel=\{channel\} size="md" \/>/, "popover badge: md, no ring");
assert.doesNotMatch(tip, /מקור:/, "old free-text source row stays consolidated — never restored");
const screen = readFileSync("src/app/(dashboard)/calendar/CalendarScreen.tsx", "utf8");
assert.match(screen, /ערוצים/, "legend heading");
assert.match(screen, /CHANNEL_ORDER\.map/, "legend renders the four channels from the one order");
assert.match(screen, /<ChannelBadge channel=\{ch\} size="sm" \/>/, "legend badge: sm");
// no manual channel presentation anywhere in the feature
for (const [f, src] of [
  ["src/lib/colors.ts", readFileSync("src/lib/colors.ts", "utf8")],
  ["ChannelBadge.tsx", badge],
  ["CalendarGrid.tsx", grid],
  ["ReservationTooltip.tsx", tip],
  ["CalendarScreen.tsx", screen],
]) {
  assert.doesNotMatch(src, /הזמנה ידנית|#E6E9F0/i, `${f} still carries the manual badge presentation`);
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

console.log("check-channels-badge: visible-channel mapping, internal no-badge rule and all three surfaces verified ✔");
