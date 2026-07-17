// Runnable checks for the reservation-channel badge (same pattern as
// check-calendar.mjs): compiles the pure token module, asserts the exact
// channel mapping + normalization, then asserts the three surfaces are wired
// to the ONE component/config. Usage: node scripts/check-channels-badge.mjs
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
const { CHANNEL_CONFIG, CHANNEL_ORDER, normalizeChannel } = require(join(out, "colors.js"));

// ---- the exact supplied mapping — letters, brand colors, display names ----
assert.deepEqual(CHANNEL_CONFIG.booking, { glyph: "B", bg: "#003580", tx: "#FFFFFF", name: "Booking.com" });
assert.deepEqual(CHANNEL_CONFIG.airbnb, { glyph: "A", bg: "#FF5A5F", tx: "#FFFFFF", name: "Airbnb" });
assert.deepEqual(CHANNEL_CONFIG.expedia, { glyph: "E", bg: "#FFC400", tx: "#1B2233", name: "Expedia" });
assert.deepEqual(CHANNEL_CONFIG.site, { glyph: "S", bg: "#2540C8", tx: "#FFFFFF", name: "אתר המלון" });
assert.deepEqual(CHANNEL_CONFIG.manual, { glyph: null, bg: "#E6E9F0", tx: "#5B6478", name: "הזמנה ידנית" });
assert.deepEqual([...CHANNEL_ORDER], ["booking", "airbnb", "expedia", "site", "manual"], "legend order");

// ---- normalization: lookup_items(booking_sources).key → channel ----
assert.equal(normalizeChannel("booking_com"), "booking", "imported BDC key");
assert.equal(normalizeChannel("booking"), "booking");
assert.equal(normalizeChannel("airbnb"), "airbnb");
assert.equal(normalizeChannel("expedia"), "expedia");
assert.equal(normalizeChannel("direct"), "site", "direct = the hotel's own site");
assert.equal(normalizeChannel("website"), "site");
// unknown / operator-entered / missing sources fail SAFELY to manual
assert.equal(normalizeChannel("phone"), "manual");
assert.equal(normalizeChannel("walk_in"), "manual");
assert.equal(normalizeChannel("hostelworld"), "manual", "unmapped OTA never guesses a brand");
assert.equal(normalizeChannel(""), "manual");
assert.equal(normalizeChannel(null), "manual");
assert.equal(normalizeChannel(undefined), "manual");

// ---- the badge component: manual icon, accessibility, no shrink ----
const badge = readFileSync("src/components/shared/ChannelBadge.tsx", "utf8");
assert.match(badge, /c\.glyph \?\? <Icon name="edit"/, "manual channel renders the Material `edit` icon");
assert.match(badge, /aria-label=\{label\}/, "badge carries aria-label");
assert.match(badge, /title=\{label\}/, "badge carries native title");
assert.match(badge, /ערוץ: \$\{c\.name\}/, "accessible name is ערוץ: {full name}");
const ds = readFileSync("src/app/styles/design-system.css", "utf8");
assert.match(ds, /\.ch-badge \{[^}]*flex: none;/s, ".ch-badge never shrinks (flex: none)");
assert.match(ds, /\.ch-badge \{[^}]*border-radius: 50%;/s, ".ch-badge stays circular");
assert.match(ds, /\.ch-badge\.ring \{\s*box-shadow: 0 0 0 1\.5px rgba\(255, 255, 255, 0\.65\);/, "white separation ring");

// ---- the three surfaces consume the ONE component + config ----
const grid = readFileSync("src/app/(dashboard)/calendar/CalendarGrid.tsx", "utf8");
assert.match(
  grid,
  /<ChannelBadge channel=\{normalizeChannel\(stay\.source_key\)\} size="lg" ring \/>\s*\{stay\.is_vip/,
  "pill: badge leads, VIP star follows",
);
assert.match(grid, /normalizeChannel\(dragStay\.source_key\)/, "drag ghost wears the same badge");
const tip = readFileSync("src/app/(dashboard)/calendar/ReservationTooltip.tsx", "utf8");
assert.match(tip, /ערוץ: <b>\{CHANNEL_CONFIG\[channel\]\.name\}<\/b>/, "popover channel row text");
assert.match(tip, /<ChannelBadge channel=\{channel\} size="md" \/>/, "popover badge: md, no ring");
assert.doesNotMatch(tip, /מקור:/, "old free-text source row consolidated — channel shown once");
const screen = readFileSync("src/app/(dashboard)/calendar/CalendarScreen.tsx", "utf8");
assert.match(screen, /ערוצים/, "legend heading");
assert.match(screen, /CHANNEL_ORDER\.map/, "legend renders all five channels from the one order");
assert.match(screen, /<ChannelBadge channel=\{ch\} size="sm" \/>/, "legend badge: sm");
// nobody re-types a channel hex outside the token files
for (const f of [
  "src/components/shared/ChannelBadge.tsx",
  "src/app/(dashboard)/calendar/CalendarGrid.tsx",
  "src/app/(dashboard)/calendar/ReservationTooltip.tsx",
  "src/app/(dashboard)/calendar/CalendarScreen.tsx",
]) {
  assert.doesNotMatch(readFileSync(f, "utf8"), /#003580|#FF5A5F|#FFC400|#E6E9F0/i, `${f} duplicates a channel color`);
}

console.log("check-channels-badge: channel mapping, fallback and all three surfaces verified ✔");
