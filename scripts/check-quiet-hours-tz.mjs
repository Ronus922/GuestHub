// check:quiet-hours-tz — D201: applyQuietHours computes the window in
// Asia/Jerusalem whatever the process TZ. The server and the PM2 worker run
// Etc/UTC; the old process-local getHours() turned 22:00–07:00 into
// 01:00–10:00 Israel summer time.
//
// The REAL compiled triggers.ts runs in two child processes, TZ=UTC and
// TZ=Asia/Jerusalem, over a grid of instants (summer, winter, both DST
// switches). Results must be identical AND equal the expected Israel-time
// clamp. Then the same proof runs on a mutant that reverts to process-local
// hours, which must fail.
import { execFileSync, execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
console.log(`# tree under test: ${ROOT}`);
const out = mkdtempSync(join(ROOT, "node_modules/.cache/check-quiet-hours-tz-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
execSync(`pnpm exec tsc --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --outDir ${out} ${join(ROOT, "src/lib/communications/triggers.ts")}`, { stdio: "inherit" });

// A child that prints applyQuietHours over the grid as JSON.
const probe = `
const { applyQuietHours } = await import(process.argv[2]);
const windows = [
  { enabled: true, start: "22:00", end: "07:00" },
  { enabled: true, start: "13:00", end: "15:00" },
];
// Instants (UTC). Israel DST 2026: starts Fri 27/03 02:00, ends Sun 25/10 02:00.
const instants = [
  "2026-07-27T09:00:00Z", "2026-07-27T19:30:00Z", "2026-07-27T20:30:00Z", "2026-07-27T23:59:00Z",
  "2026-07-28T03:00:00Z", "2026-07-28T04:30:00Z", "2026-07-27T10:30:00Z",
  "2026-01-15T20:30:00Z", "2026-01-15T04:59:00Z", "2026-01-15T05:00:00Z",
  "2026-03-26T21:00:00Z", "2026-10-24T21:00:00Z",
];
const result = [];
for (const w of windows) for (const i of instants) result.push(applyQuietHours(new Date(i), w).toISOString());
process.stdout.write(JSON.stringify(result));
`;
writeFileSync(join(out, "probe.mjs"), probe);

const run = (dir, tz) => JSON.parse(execFileSync("node", [join(out, "probe.mjs"), join(dir, "triggers.js")],
  { env: { ...process.env, TZ: tz }, encoding: "utf8" }));

// Expected Israel-time clamps, written out by hand (IDT +3, IST +2).
const expected = [
  // 22:00–07:00
  "2026-07-27T09:00:00.000Z",  // 12:00 IDT — open
  "2026-07-28T04:00:00.000Z",  // 22:30 IDT — clamps to 07:00 tomorrow
  "2026-07-28T04:00:00.000Z",  // 23:30 IDT — tomorrow 07:00
  "2026-07-28T04:00:00.000Z",  // 02:59 IDT 28/07 — same morning 07:00
  "2026-07-28T04:00:00.000Z",  // 06:00 IDT — 07:00 same day
  "2026-07-28T04:30:00.000Z",  // 07:30 IDT — open
  "2026-07-27T10:30:00.000Z",  // 13:30 IDT — open
  "2026-01-16T05:00:00.000Z",  // 22:30 IST — 07:00 IST tomorrow
  "2026-01-15T05:00:00.000Z",  // 06:59 IST — 07:00 IST
  "2026-01-15T05:00:00.000Z",  // 07:00 IST — open
  "2026-03-27T04:00:00.000Z",  // 23:00 IST 26/03 → 07:00 IDT 27/03 (DST starts in between)
  "2026-10-25T05:00:00.000Z",  // 00:00 IDT 25/10 → 07:00 IST 25/10 (DST ends in between)
  // 13:00–15:00
  "2026-07-27T09:00:00.000Z", "2026-07-27T19:30:00.000Z", "2026-07-27T20:30:00.000Z", "2026-07-27T23:59:00.000Z",
  "2026-07-28T03:00:00.000Z", "2026-07-28T04:30:00.000Z",
  "2026-07-27T12:00:00.000Z",  // 13:30 IDT — clamps to 15:00 IDT
  "2026-01-15T20:30:00.000Z", "2026-01-15T04:59:00.000Z", "2026-01-15T05:00:00.000Z",
  "2026-03-26T21:00:00.000Z", "2026-10-24T21:00:00.000Z",
];

function prove(dir) {
  const failures = [];
  const utc = run(dir, "UTC");
  const il = run(dir, "Asia/Jerusalem");
  if (JSON.stringify(utc) !== JSON.stringify(il)) failures.push("TZ=UTC and TZ=Asia/Jerusalem disagree");
  utc.forEach((v, i) => { if (v !== expected[i]) failures.push(`case ${i}: TZ=UTC got ${v}, expected ${expected[i]}`); });
  il.forEach((v, i) => { if (v !== expected[i]) failures.push(`case ${i}: TZ=Asia/Jerusalem got ${v}, expected ${expected[i]}`); });
  return failures;
}

let exit = 0;
const real = prove(out);
if (real.length) { exit = 1; console.log("✗ the real code fails:"); for (const f of real) console.log(`    ${f}`); }
else console.log(`✓ real code: ${expected.length} instants identical under TZ=UTC and TZ=Asia/Jerusalem, all equal the Israel-time clamp`);

// Mutant: the pre-D201 process-local clock.
const mutant = `${out}-mutant`;
cpSync(out, mutant, { recursive: true });
const path = join(mutant, "triggers.js");
const text = readFileSync(path, "utf8");
const anchor = "const minutes = local.h * 60 + local.mi;";
if (!text.includes(anchor)) throw new Error("mutation anchor not found — the compiled shape changed");
writeFileSync(path, text.replace(anchor, "const minutes = date.getHours() * 60 + date.getMinutes();"));
const caught = prove(mutant);
if (caught.length) console.log(`✓ mutant "process-local hours" is caught (${caught.length} failing assertion(s), first: ${caught[0]})`);
else { exit = 1; console.log('✗ mutant "process-local hours" SURVIVED'); }
process.exitCode = exit;
