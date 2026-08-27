#!/usr/bin/env node
// check:no-secrets (Stage 6, V2 §19) — no credential is committed to the tree or
// the git history. Scans tracked files for secret material + verifies no .env*
// (bar examples) is or ever was committed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
let fail = 0;
const flag = (m) => { fail++; console.log(`✗ ${m}`); };
const pass = (m) => console.log(`✓ ${m}`);

const tracked = git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);

// 1) no committed env file (only *.example / *.sample are allowed)
const envFiles = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.(example|sample|template)$/.test(f));
if (envFiles.length) flag(`tracked env file(s): ${envFiles.join(", ")}`);
else pass("no .env* file is tracked (only examples permitted)");

// 2) no .env* was EVER committed in history
const everEnv = git(["log", "--all", "--diff-filter=A", "--name-only", "--pretty=format:"])
  .split("\n").map((s) => s.trim())
  .filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.(example|sample|template)$/.test(f));
if (everEnv.length) flag(`.env file(s) appear in history: ${[...new Set(everEnv)].join(", ")}`);
else pass("no .env* file was ever committed (history clean)");

// 3) secret material in tracked text files
// Files that legitimately contain secret-shaped PATTERNS (scanners, docs, seeds).
const ALLOW = new Set([
  "scripts/check-no-secrets.mjs",
  "scripts/seed.mjs",                       // seeds throwaway local dev passwords
]);
const ALLOW_PREFIX = ["docs/", "db/roles/"]; // docs describe patterns; roles.sql uses :'vars'

const RULES = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "private key block"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bghp_[A-Za-z0-9]{36}\b/, "GitHub personal access token"],
  [/\bsk-[A-Za-z0-9]{20,}\b/, "OpenAI-style secret key"],
  // a Supabase service_role / signed JWT literal (three base64url segments)
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT/service_role token"],
  // a postgres URL carrying an inline password for a NON-LOCAL host (a leaked
  // production DSN). localhost/127.0.0.1 DSNs are disposable local test fixtures,
  // not secrets, so they are intentionally not flagged.
  [/postgres(?:ql)?:\/\/[^:\/\s]+:(?!\$\{)(?!<)[^@\/\s]{6,}@(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/i, "postgres URL with inline password (non-local host)"],
];

const isText = (f) => /\.(ts|tsx|js|mjs|cjs|json|sql|md|sh|yml|yaml|env|txt|toml)$/.test(f);

// A guard that tests redaction must WRITE a leaked-looking DSN to have something
// to redact (scripts/check-seed-safety.mjs does exactly that). Exempting the whole
// file would retire it from this scan forever, so the exemption is per LINE and
// carries its reason — the same idiom as `ds-allow:` in check:design:
//
//     const leaky = pgError("28P01", "… postgresql://u:pw@db:5432/x"); // no-secrets-allow: synthetic fixture
//
// The marker is a ratchet, not a mute button: a marked line that matches no rule
// is reported as stale and must be deleted, so a marker can never sit in the tree
// pre-authorising a future leak on that line.
const MARKER = /no-secrets-allow:[ \t]*(.*)$/;

// The marker is a CODE mechanism. In Markdown the same token is prose — D160
// names it, and a doc that explains the guard must be able to spell it. So in
// .md the marker has no power at all: it neither exempts a line nor counts as
// stale, and every line is scanned normally.
const markersActive = (f) => !f.endsWith(".md");

// scanText — the one scanner, used for the tree AND for the B2 mutants below.
function scanText(text, active = true) {
  const hits = [];   // { line, label, sample }
  const stale = [];  // { line, reason } — marked, but nothing to allow
  const unreasoned = []; // { line } — marked without a reason
  text.split("\n").forEach((raw, i) => {
    const lineNo = i + 1;
    const mark = active ? raw.match(MARKER) : null;
    const matched = RULES.filter(([re]) => re.test(raw));
    if (mark) {
      if (!mark[1].trim() || mark[1].trim() === "//") unreasoned.push({ line: lineNo });
      if (!matched.length) stale.push({ line: lineNo, reason: mark[1].trim() });
      return; // the line is exempt — that is what the marker buys
    }
    for (const [re, label] of matched) hits.push({ line: lineNo, label, sample: raw.match(re)[0].slice(0, 24) });
  });
  return { hits, stale, unreasoned };
}

let scanned = 0;
let markers = 0;
for (const f of tracked) {
  if (!isText(f)) continue;
  if (ALLOW.has(f) || ALLOW_PREFIX.some((p) => f.startsWith(p))) continue;
  let content = "";
  try { content = readFileSync(join(root, f), "utf8"); } catch { continue; }
  scanned++;
  const active = markersActive(f);
  const { hits, stale, unreasoned } = scanText(content, active);
  if (active) markers += (content.match(/no-secrets-allow:/g) || []).length;
  for (const h of hits) flag(`${f}:${h.line}: possible ${h.label} — "${h.sample}…"`);
  for (const s of stale) flag(`${f}:${s.line}: stale no-secrets-allow ("${s.reason}") — the line carries no secret material; delete the marker`);
  for (const u of unreasoned) flag(`${f}:${u.line}: no-secrets-allow without a reason — write why the line is a fixture`);
}
if (!fail) pass(`no secret material in ${scanned} tracked text files (${markers} line-level fixture marker(s), each still matched)`);

// 3b) B2 — the scanner is re-proven on synthetic mutants every run, so the marker
//     cannot rot into a blanket mute while the real scan still looks alive.
{
  const DSN = 'auth failed for postgresql://postgres.bios-vps:SUPERSECRET@db:5432/postgres';
  const mutants = [
    ["a leaked DSN on a bare line is caught", `const x = "${DSN}";`, (r) => r.hits.length === 1 && !r.stale.length],
    ["the same line, marked, is exempt", `const x = "${DSN}"; // no-secrets-allow: synthetic fixture`, (r) => !r.hits.length && !r.stale.length && !r.unreasoned.length],
    ["a marker on a clean line is stale", `const x = 1; // no-secrets-allow: nothing here`, (r) => r.stale.length === 1 && !r.hits.length],
    ["a marker without a reason is rejected", `const x = "${DSN}"; // no-secrets-allow:`, (r) => r.unreasoned.length === 1],
    ["a marker exempts ONLY its own line", `const a = "${DSN}"; // no-secrets-allow: fixture\nconst b = "${DSN}";`, (r) => r.hits.length === 1 && r.hits[0].line === 2],
    ["a private key on an unmarked line is still caught", "-----BEGIN PRIVATE KEY-----", (r) => r.hits.length === 1],
    ["in Markdown the marker is inert — the token is prose, the line still scans", `the guard reads a no-secrets-allow: marker; here is a DSN "${DSN}"`, (r) => r.hits.length === 1 && !r.stale.length, false],
    ["in Markdown a lone mention of the marker is not stale", "the marker is spelled no-secrets-allow: reason", (r) => !r.stale.length && !r.hits.length, false],
  ];
  let bad = 0;
  for (const [name, text, expect, active = true] of mutants) {
    if (!expect(scanText(text, active))) { bad++; flag(`B2 mutant failed: ${name}`); }
  }
  if (!bad) pass(`B2: all ${mutants.length} scanner mutants behaved (marker is per-line, reasoned, and ratcheted)`);
}

// 4) the encryption-key env vars are only ever READ from process.env, never
//    assigned a literal in source (defense against a hardcoded fallback key).
for (const key of ["CHANNEL_SECRETS_KEY", "CARD_VAULT_KEY"]) {
  const hits = tracked.filter((f) => f.startsWith("src/") && f.endsWith(".ts"))
    .filter((f) => new RegExp(`${key}\\s*=\\s*["']`).test(readFileSyncSafe(join(root, f))));
  if (hits.length) flag(`${key} assigned a literal in: ${hits.join(", ")}`);
}
if (!fail) pass("encryption env vars are read from process.env, never hardcoded");

function readFileSyncSafe(p) { try { return readFileSync(p, "utf8"); } catch { return ""; } }

if (fail) { console.log(`\ncheck:no-secrets — FAIL (${fail})`); process.exit(1); }
console.log("check:no-secrets — PASS");
