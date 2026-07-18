#!/usr/bin/env node
// guesthub-purge — data-retention maintenance (Stage 6, H8/H11). Runs the two
// purge functions and prints how many rows each removed. Intended for a nightly
// systemd timer (documented in OBSERVABILITY.md / DB runbooks), but safe to run
// by hand. Target DSN comes ONLY from PURGE_DATABASE_URL — never a guess — and it
// refuses a host-local :5432 (the shared production pooler) unless --allow-5432,
// mirroring scripts/db/migrate.mjs.
import { execFileSync } from "node:child_process";

const url = process.env.PURGE_DATABASE_URL;
if (!url) { console.error("ABORT: PURGE_DATABASE_URL is required (refusing to guess a target)."); process.exit(2); }
let u;
try { u = new URL(url); } catch { console.error("ABORT: PURGE_DATABASE_URL is not a valid URL"); process.exit(2); }
const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
if (isLocal && (u.port || "5432") === "5432" && !process.argv.includes("--allow-5432")) {
  console.error("ABORT: refusing host-local :5432 (shared production pooler). Pass --allow-5432 for a verified non-prod cluster.");
  process.exit(2);
}

const cardDays = Number(process.env.PURGE_CARD_DAYS || 90);
const resolvedDays = Number(process.env.PURGE_ERROR_RESOLVED_DAYS || 30);
const unresolvedDays = Number(process.env.PURGE_ERROR_UNRESOLVED_DAYS || 180);

const q = (sql) => execFileSync("psql", [url, "-tAc", sql, "-X", "-v", "ON_ERROR_STOP=1"], { encoding: "utf8" }).trim();

const cards = q(`SELECT guesthub.purge_expired_cards(${cardDays})`);
const errors = q(`SELECT guesthub.purge_channel_sync_errors(${resolvedDays}, ${unresolvedDays})`);
console.log(`purge: ${cards} expired card(s) [>${cardDays}d post-stay], ${errors} old sync error(s)`);
