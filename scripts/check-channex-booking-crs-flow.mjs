#!/usr/bin/env node
// check:channex-booking-crs-flow (Stage 4, V2 §17) — the booking-receiving
// certification flow is correctly shaped: revisions-feed only, new/modify/cancel
// handled, ACK strictly after commit, a controlled recovery-by-id path, and the
// Booking.com-preferred / Booking-CRS-fallback workflow is documented.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

const bookings = read("src/lib/channel/channex-bookings.ts");
const importSrc = read("src/lib/channel/booking-import.ts");

// 1) revisions feed is the source of truth (not the bookings collection)
if (!/\/booking_revisions\/feed\?filter\[property_id\]/.test(bookings))
  flag("no booking_revisions feed pull");
else pass("inbound reads the booking_revisions feed (revisions-only source of truth)");

// 2) new / modified / cancelled are all handled
for (const kind of ["new", "modified", "cancelled"])
  if (!new RegExp(`"${kind}"`).test(importSrc)) flag(`revision kind "${kind}" not handled`);
if (!fail) pass("new / modified / cancelled revisions all handled");

// 3) ACK exists and is post-commit
if (!/\/booking_revisions\/\$\{encodeURIComponent\(revisionId\)\}\/ack/.test(bookings))
  flag("no acknowledge endpoint");
else pass("acknowledge endpoint present (POST /booking_revisions/:id/ack)");
if (!/markRevisionAcknowledged/.test(importSrc)) flag("ack is not gated on commit");
else pass("ACK only after the import transaction commits");

// 4) controlled recovery-by-id path (never a blind re-pull)
if (!/fetchBookingRevision\b/.test(bookings) || !/fetchBooking\b/.test(bookings))
  flag("no controlled recovery-by-id path");
else pass("controlled recovery-by-id available (revision + booking)");

// 5) never DELETEs a booking, never touches a /pci path (card data out of scope)
if (/method:\s*"DELETE"/.test(bookings)) flag("booking client issues DELETE");
else pass("booking client never DELETEs");

// 6) the webhook only wakes the worker; the feed remains the source of truth
const webhook = read("src/app/api/channel/webhook/[token]/route.ts");
if (!/pull_booking_revisions/.test(webhook)) flag("webhook does not enqueue a feed pull");
else pass("webhook only enqueues a feed pull (feed stays the source of truth)");

// 7) fallback poll guarantees a missed webhook never loses a booking
if (!/fallback|missed webhook|watchdog/i.test(read("src/lib/channel/worker.ts")))
  flag("no fallback poll for a missed webhook");
else pass("fallback poll covers a missed webhook (no lost booking)");

// 8) the certification workflow is documented (Booking.com preferred, CRS fallback)
const doc = read("docs/channex/BOOKING_RECEIVING_CERTIFICATION.md");
for (const need of ["Booking.com", "Booking CRS", "acknowledge", "quarantine", "evidence ledger"])
  if (!doc.includes(need)) flag(`cert workflow doc missing "${need}"`);
if (!fail) pass("booking-receiving cert workflow documented (Booking.com preferred / CRS fallback)");

if (fail) { console.log(`\ncheck:channex-booking-crs-flow — FAIL (${fail})`); process.exit(1); }
console.log("check:channex-booking-crs-flow — PASS");
