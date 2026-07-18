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
  "scripts/check-channel-worker.mjs",      // uses an explicit fake local key
  "scripts/check-channex-credential.mjs",
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
let scanned = 0;
for (const f of tracked) {
  if (!isText(f)) continue;
  if (ALLOW.has(f) || ALLOW_PREFIX.some((p) => f.startsWith(p))) continue;
  let content = "";
  try { content = readFileSync(join(root, f), "utf8"); } catch { continue; }
  scanned++;
  for (const [re, label] of RULES) {
    const m = content.match(re);
    if (m) flag(`${f}: possible ${label} — "${m[0].slice(0, 24)}…"`);
  }
}
if (!fail) pass(`no secret material in ${scanned} tracked text files`);

// 4) the encryption-key env vars are only ever READ from process.env, never
//    assigned a literal in source (defense against a hardcoded fallback key).
for (const key of ["CHANNEL_SECRETS_KEY", "CARD_VAULT_KEY", "CHANNEX_PRODUCTION_ACTIVATION"]) {
  const hits = tracked.filter((f) => f.startsWith("src/") && f.endsWith(".ts"))
    .filter((f) => new RegExp(`${key}\\s*=\\s*["']`).test(readFileSyncSafe(join(root, f))));
  if (hits.length) flag(`${key} assigned a literal in: ${hits.join(", ")}`);
}
if (!fail) pass("encryption/activation env vars are read from process.env, never hardcoded");

function readFileSyncSafe(p) { try { return readFileSync(p, "utf8"); } catch { return ""; } }

if (fail) { console.log(`\ncheck:no-secrets — FAIL (${fail})`); process.exit(1); }
console.log("check:no-secrets — PASS");
