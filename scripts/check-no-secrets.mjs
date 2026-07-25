#!/usr/bin/env node
// check:no-secrets (Stage 6, V2 §19) — REBUILT (phase 2, target 2.2).
//
// WHY IT WAS REBUILT
// ------------------
// The previous version scanned `git ls-files` and nothing else. `.gitignore`
// line 37 is `.env*`, so every real credential file in the deploy tree was
// untracked and therefore INVISIBLE to it, and the four hand-made rollback
// tarballs in /home/ubuntu — each carrying all four of those dotenv files —
// were outside its world entirely. It reported PASS over a live exposure.
//
// It now scans the FILESYSTEM of the deploy tree and the member LISTS of the
// backup tarballs, and it classifies a file by its CONTENT SHAPE rather than
// by its name, so renaming `.env.local` to `application-config.txt` does not
// hide it.
//
// ── HARD INVARIANTS (Stage 6 / iron rule 13) ─────────────────────────────────
//   * NAMES ONLY, ZERO VALUES. No secret value is ever printed, logged,
//     returned, stored in an outer scope, or embedded in a message. Values are
//     touched only inside `classifyDotenvShape`, only to compute a boolean, and
//     are never assigned outside that function's loop body. `say()` enforces
//     this at the output boundary and throws if a value-shaped token escapes.
//   * TARBALLS ARE NEVER EXTRACTED. The only tar invocation in this file is
//     `tar -tzf` (list). See TAR_LIST_ARGV — it is frozen and asserted.
//   * READ-ONLY. Nothing is created, moved, chmod-ed or deleted.
//
// ── ASSERTION RANKING (phase-2 house rule) ───────────────────────────────────
// This guard has no DB behaviour to assert, so the strongest class available
// to it is OBSERVED: state read back from the real filesystem, the real
// tarball indexes and the real git object store. Assertions that merely match
// a text pattern over source are labelled CONTRACT, and their failure message
// says so explicitly — a CONTRACT failure is a contract breach, not a
// behaviour breach.
//
//   [OBSERVED] A  deploy-tree credential-store inventory (content-shape classified)
//   [OBSERVED] B  stray / duplicate credential stores in the deploy tree
//   [OBSERVED] C  permissions of the credential stores in the deploy tree
//   [OBSERVED] D  credential members inside the backup tarballs (tar -tzf)
//   [OBSERVED] E  permissions of any backup tarball that carries credentials
//   [OBSERVED] F  no .env* / credential store is tracked by git
//   [OBSERVED] G  no .env* was ever committed
//   [CONTRACT] H  no secret material in tracked text files
//   [CONTRACT] I  encryption env vars are only ever read from process.env
//
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from "node:fs";
import { join, dirname, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// ── output boundary ─────────────────────────────────────────────────────────
// Last line of defence for the zero-values invariant: refuse to emit anything
// that looks like credential material, whoever writes the calling code later.
const VALUE_SHAPED = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,            // JWT
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{6,}@/i,                   // DSN with password
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Fa-f0-9]{48,}\b/,                                       // long hex key
  /\bsk-[A-Za-z0-9]{20,}\b/, /\bghp_[A-Za-z0-9]{36}\b/, /\bAKIA[0-9A-Z]{16}\b/,
];
function say(line) {
  const s = String(line);
  for (const re of VALUE_SHAPED) {
    if (re.test(s)) throw new Error("check:no-secrets refused to print a value-shaped token (zero-values invariant)");
  }
  console.log(s);
}

let fail = 0;
let blocked = 0;
const flag = (m) => { fail++; say(`✗ ${m}`); };
const contractFlag = (m) => { fail++; say(`✗ [CONTRACT BREACH — not a behaviour breach] ${m}`); };
const pass = (m) => say(`✓ ${m}`);
const note = (m) => say(`  · ${m}`);

// ── targets ─────────────────────────────────────────────────────────────────
const DEFAULT_TREE = "/var/www/guesthub";
const DEFAULT_BACKUP_DIR = "/home/ubuntu";
const DEFAULT_BACKUP_PREFIX = "guesthub-backup-";

const sandbox = process.env.NO_SECRETS_SANDBOX === "1";
const treeOverride = process.env.NO_SECRETS_TREE;
const backupOverride = process.env.NO_SECRETS_BACKUP_GLOB;
if ((treeOverride || backupOverride) && !sandbox) {
  say("✗ NO_SECRETS_TREE / NO_SECRETS_BACKUP_GLOB may only be used with NO_SECRETS_SANDBOX=1.");
  say("  Retargeting this guard silently is how a real exposure gets a green tick.");
  process.exit(2);
}
const TREE = treeOverride || DEFAULT_TREE;

function resolveBackups() {
  if (backupOverride) {
    // Only a "<dir>/<prefix>*<suffix>" shape is supported; no shell, no glob lib.
    const dir = dirname(backupOverride);
    const [pre, suf] = basename(backupOverride).split("*");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith(pre ?? "") && f.endsWith(suf ?? ""))
      .map((f) => join(dir, f)).sort();
  }
  if (!existsSync(DEFAULT_BACKUP_DIR)) return [];
  return readdirSync(DEFAULT_BACKUP_DIR)
    .filter((f) => f.startsWith(DEFAULT_BACKUP_PREFIX) && (f.endsWith(".tgz") || f.endsWith(".tar.gz")))
    .map((f) => join(DEFAULT_BACKUP_DIR, f)).sort();
}

say("check:no-secrets — credential exposure guard");
say(`  deploy tree : ${TREE}`);
say(`  backups     : ${backupOverride || `${DEFAULT_BACKUP_DIR}/${DEFAULT_BACKUP_PREFIX}*.tgz`}`);
if (sandbox) {
  say("  *** SANDBOX MODE — retargeted via NO_SECRETS_SANDBOX=1. This run asserts");
  say("      nothing about the real deploy tree or the real backups. ***");
}
say("");

// ─────────────────────────────────────────────────────────────────────────────
// THE CENTRAL PREDICATE: is this file a credential store?
//
// Deliberately CONTENT-shaped, not name-shaped. A dotenv file is a file that is
// overwhelmingly `KEY=VALUE` lines, where at least one KEY NAME reads as a
// credential and carries a value that is not an obvious placeholder. Renaming
// it, or moving it, changes nothing.
// ─────────────────────────────────────────────────────────────────────────────
const SECRET_KEY_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_?KEY|_KEY$|^KEY$|CREDENTIAL|SERVICE_ROLE|VAULT|DSN|DATABASE_URL|CONNECTION_STRING|ACCESS_KEY|AUTH)/i;
const PLACEHOLDER = /^(?:|<.*>|\$\{.*\}|changeme|change_me|x{3,}|todo|your[-_ ].*|replace[-_ ]?me|example|placeholder|dummy|null|none|\*+)$/i;
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function classifyDotenvShape(absPath) {
  let st;
  try { st = lstatSync(absPath); } catch { return null; }
  if (!st.isFile() || st.size === 0 || st.size > 512 * 1024) return null;

  let text;
  try { text = readFileSync(absPath, "utf8"); } catch { return null; }
  if (text.includes("\u0000")) return null; // binary

  let assignments = 0, meaningful = 0;
  const secretKeyNames = [];   // NAMES ONLY — never a value
  const allKeyNames = [];      // NAMES ONLY — never a value
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith(";")) continue;
    meaningful++;
    const m = t.match(ASSIGN);
    if (!m) continue;
    assignments++;
    const keyName = m[1];
    allKeyNames.push(keyName);
    // The value is inspected here and ONLY here, and is reduced to a boolean
    // before this block ends. It is never assigned to an outer-scope binding.
    if (SECRET_KEY_NAME.test(keyName)) {
      const looksReal = (() => {
        const v = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
        return v.length >= 8 && !PLACEHOLDER.test(v);
      })();
      if (looksReal) secretKeyNames.push(keyName);
    }
  }
  if (meaningful === 0) return null;
  const density = assignments / meaningful;
  const isCredentialStore = assignments >= 3 && density >= 0.6 && secretKeyNames.length > 0;
  return {
    isCredentialStore,
    assignments,
    density,
    keyCount: allKeyNames.length,
    secretKeyNames: [...new Set(secretKeyNames)].sort(),
  };
}

// ── tree walk ───────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".pnpm-store", "dist", "build",
  "coverage", ".turbo", ".cache", ".venv", "__pycache__",
]);
function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1); continue; }
    if (e.isFile()) out.push(p);
  }
  return out;
}

// Names a managed runtime env file is allowed to have. Anything else that
// classifies as a credential store is a STRAY: an unmanaged duplicate.
const MANAGED_ENV_NAME = /^\.env(\.(local|staging|production|development|test))?$/;
const EXAMPLE_NAME = /\.(example|sample|template|dist)$/;

// ─────────────────────────────────────────────────────────────────────────────
// A/B/C — deploy tree
// ─────────────────────────────────────────────────────────────────────────────
if (!existsSync(TREE)) {
  blocked++;
  say(`⚠ [OBSERVED — BLOCKED] deploy tree ${TREE} does not exist; the filesystem`);
  say("  assertions could not run. This guard fails closed: it will not report PASS");
  say("  for assertions it never executed.");
} else {
  const files = walk(TREE);
  const stores = [];
  for (const f of files) {
    const c = classifyDotenvShape(f);
    if (c && c.isCredentialStore) stores.push({ path: f, rel: relative(TREE, f), ...c });
  }

  // A — inventory (OBSERVED). File names + KEY NAMES only.
  say(`[OBSERVED] A. credential-store inventory of ${TREE} (${files.length} files walked)`);
  if (stores.length === 0) {
    pass("no credential store found in the deploy tree");
  } else {
    for (const s of stores) {
      const mode = (statSync(s.path).mode & 0o777).toString(8).padStart(4, "0");
      note(`${s.rel}  —  mode ${mode}, ${s.keyCount} assignments, ${(s.density * 100).toFixed(0)}% assignment density`);
      note(`     credential-bearing KEY NAMES: ${s.secretKeyNames.join(", ")}`);
    }
  }

  // B — strays (OBSERVED)
  const strays = stores.filter((s) => {
    if (s.rel.includes(sep)) return true;          // credential store below the tree root
    return !MANAGED_ENV_NAME.test(basename(s.rel)); // .bak / .old / ~ / renamed copies
  });
  if (strays.length === 0) {
    pass("[OBSERVED] B. every credential store in the tree is a managed runtime env file");
  } else {
    flag(`[OBSERVED] B. ${strays.length} STRAY credential store(s) in ${TREE} — unmanaged duplicates of live secrets:`);
    for (const s of strays) note(`   ${s.rel}   (keys: ${s.secretKeyNames.join(", ")})`);
    note("   A copy of a secret is a secret. Remove them, or move them out of the deploy tree.");
  }
  // A file named as an example that carries real values is its own failure.
  for (const s of stores) {
    if (EXAMPLE_NAME.test(basename(s.rel))) {
      flag(`[OBSERVED] B. ${s.rel} is named as an example but carries real values (keys: ${s.secretKeyNames.join(", ")})`);
    }
  }

  // C — permissions (OBSERVED)
  const worldReadable = stores
    .map((s) => ({ rel: s.rel, mode: statSync(s.path).mode & 0o777 }))
    .filter((s) => s.mode & 0o004);
  if (worldReadable.length === 0) {
    pass("[OBSERVED] C. no credential store in the deploy tree is world-readable");
  } else {
    flag(`[OBSERVED] C. ${worldReadable.length} credential store(s) are WORLD-READABLE:`);
    for (const w of worldReadable) note(`   ${w.rel} mode ${w.mode.toString(8).padStart(4, "0")}`);
  }
}
say("");

// ─────────────────────────────────────────────────────────────────────────────
// D/E — backup tarballs. LIST ONLY. Never extracted.
// ─────────────────────────────────────────────────────────────────────────────
// Frozen argv. `-t` is list. There is no code path in this file that can pass
// `-x` to tar; the assertion below makes that structural, not aspirational.
const TAR_LIST_ARGV = Object.freeze(["-tzf"]);
if (TAR_LIST_ARGV.join("").includes("x")) throw new Error("tar argv must be list-only");

// Inside a tarball only member NAMES are available — extraction is forbidden,
// so content-shape classification is impossible here and the pattern set below
// is name-shaped by necessity. Calibrated against the four real tarballs
// (1778 and 7111 members listed): 4 hits each, zero false positives.
const SECRET_MEMBER = [
  /(^|\/)\.env($|\.)/,                       // .env, .env.local, .env.local.bak-*
  /(^|\/)[^/]+\.env$/,                       // foo.env
  /(^|\/)env\.(local|prod|production|staging|secret)$/,
  /\.(pem|p12|pfx|jks|keystore|asc|ppk)$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.(pgpass|netrc|npmrc|htpasswd)$/,
  /(^|\/)credentials(\.(json|ya?ml|ini))?$/,
  /(^|\/)service-account[^/]*\.json$/,
  /\.key$/,
];
const isSecretMember = (m) => SECRET_MEMBER.some((re) => re.test(m)) && !EXAMPLE_NAME.test(m);

const backups = resolveBackups();
say("[OBSERVED] D. backup tarballs carrying credentials (tar -tzf, LIST ONLY — never extracted)");
say("     LIMITATION: extraction is forbidden, so members are matched by NAME, not by");
say("     content shape. A credential file renamed before it was tarred would evade D.");
say("     The deploy-tree assertions above do not share this weakness.");
if (backups.length === 0) {
  note("no backup tarball found at the configured location");
  pass("[OBSERVED] D. no backup tarball carries credential files");
  pass("[OBSERVED] E. no backup tarball permission to assert");
} else {
  let dirty = 0;
  const dirtyOpen = [];
  for (const tb of backups) {
    let members = [];
    try {
      members = execFileSync("tar", [...TAR_LIST_ARGV, tb], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
        .split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      blocked++;
      say(`⚠ [OBSERVED — BLOCKED] could not list ${basename(tb)}; not asserting on it`);
      continue;
    }
    const hits = members.filter(isSecretMember);
    const mode = statSync(tb).mode & 0o777;
    if (hits.length) {
      dirty++;
      flag(`[OBSERVED] D. ${basename(tb)} — ${hits.length} credential member(s) of ${members.length}, mode ${mode.toString(8).padStart(4, "0")}`);
      for (const h of hits) note(`   ${h}`);
      if (mode & 0o004) dirtyOpen.push({ name: basename(tb), mode });
    } else {
      note(`${basename(tb)} — clean (${members.length} members, mode ${mode.toString(8).padStart(4, "0")})`);
    }
  }
  if (dirty === 0) pass(`[OBSERVED] D. none of the ${backups.length} backup tarball(s) carries a credential file`);
  else note("   Treat every value in those members as exposed at rest. See docs/BACKUP_HYGIENE.md.");

  if (dirtyOpen.length === 0) {
    pass("[OBSERVED] E. no credential-carrying backup tarball is world-readable");
  } else {
    flag(`[OBSERVED] E. ${dirtyOpen.length} credential-carrying tarball(s) are WORLD-READABLE:`);
    for (const d of dirtyOpen) note(`   ${d.name} mode ${d.mode.toString(8).padStart(4, "0")}`);
  }
}
say("");

// ─────────────────────────────────────────────────────────────────────────────
// F/G — git state (behaviour of the original guard, kept working)
// ─────────────────────────────────────────────────────────────────────────────
const tracked = git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);

const envFiles = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !EXAMPLE_NAME.test(f));
if (envFiles.length) flag(`[OBSERVED] F. tracked env file(s): ${envFiles.join(", ")}`);
else pass("[OBSERVED] F. no .env* file is tracked (only examples permitted)");

const everEnv = git(["log", "--all", "--diff-filter=A", "--name-only", "--pretty=format:"])
  .split("\n").map((s) => s.trim())
  .filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !EXAMPLE_NAME.test(f));
if (everEnv.length) flag(`[OBSERVED] G. .env file(s) appear in history: ${[...new Set(everEnv)].join(", ")}`);
else pass("[OBSERVED] G. no .env* file was ever committed (history clean)");

// Any tracked file that classifies as a credential store, whatever it is named.
const trackedStores = [];
for (const f of tracked) {
  const c = classifyDotenvShape(join(root, f));
  if (c && c.isCredentialStore) trackedStores.push({ f, keys: c.secretKeyNames });
}
if (trackedStores.length) {
  for (const t of trackedStores) flag(`[OBSERVED] F. tracked file ${t.f} is a credential store (keys: ${t.keys.join(", ")})`);
} else {
  pass("[OBSERVED] F. no tracked file has the shape of a credential store");
}

// ─────────────────────────────────────────────────────────────────────────────
// H — secret material in tracked text files (CONTRACT: a text pattern scan)
// ─────────────────────────────────────────────────────────────────────────────
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
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT/service_role token"],
  // localhost/127.0.0.1 DSNs are disposable local test fixtures, not secrets.
  [/postgres(?:ql)?:\/\/[^:\/\s]+:(?!\$\{)(?!<)[^@\/\s]{6,}@(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/i, "postgres URL with inline password (non-local host)"],
];

const isText = (f) => /\.(ts|tsx|js|mjs|cjs|json|sql|md|sh|yml|yaml|env|txt|toml)$/.test(f);
let scanned = 0, hFail = 0;
for (const f of tracked) {
  if (!isText(f)) continue;
  if (ALLOW.has(f) || ALLOW_PREFIX.some((p) => f.startsWith(p))) continue;
  let content = "";
  try { content = readFileSync(join(root, f), "utf8"); } catch { continue; }
  scanned++;
  for (const [, label] of RULES.filter(([re]) => re.test(content))) {
    hFail++;
    // The matched text is deliberately NOT echoed — the file and the kind suffice.
    contractFlag(`H. ${f}: possible ${label}`);
  }
}
if (!hFail) pass(`[CONTRACT] H. no secret material in ${scanned} tracked text files`);

// ─────────────────────────────────────────────────────────────────────────────
// I — encryption env vars are never BOUND or ASSIGNED in source (CONTRACT)
//
// Strengthened relative to the original, which only looked for the literal
// `KEY = "…"` and so missed a computed hardcode. Strings and comments are
// stripped first, then the identifier is rejected if it is used as a binding,
// an assignment target, or an object-literal property with a literal value.
// `const CARD_VAULT_KEY = ["a","b"].join("")` is therefore caught.
//
// The identifier legitimately appears as JSX TEXT in the Hebrew UI ("… בשרת
// (CHANNEL_SECRETS_KEY) אינו מוגדר"), which is neither a JS string nor a
// comment. Matching on binding/assignment shape rather than on "must be a
// process.env read" is what keeps those from being false positives.
// ─────────────────────────────────────────────────────────────────────────────
const stripStringsAndComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  .replace(/`(?:\\.|[^`\\])*`/g, '""')
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, '""');

const ENC_KEYS = ["CHANNEL_SECRETS_KEY", "CARD_VAULT_KEY", "MESSAGING_SECRETS_ENCRYPTION_KEY"];
const srcFiles = tracked.filter((f) => f.startsWith("src/") && /\.tsx?$/.test(f));
let iFail = 0;
for (const key of ENC_KEYS) {
  const shapes = [
    [new RegExp(`\\b(?:const|let|var|function|class)\\s+${key}\\b`), "declared as a binding"],
    [new RegExp(`\\b${key}\\s*=(?![=>])`), "used as an assignment target"],
    [new RegExp(`\\b${key}\\s*:\\s*["'\`]`), "set as an object-literal property with a literal value"],
  ];
  for (const f of srcFiles) {
    let raw = "";
    try { raw = readFileSync(join(root, f), "utf8"); } catch { continue; }
    if (!raw.includes(key)) continue;
    const code = stripStringsAndComments(raw);
    for (const [re, how] of shapes) {
      if (re.test(code)) {
        iFail++;
        contractFlag(`I. ${f}: ${key} is ${how} — an encryption key must only ever be read from process.env`);
      }
    }
  }
}
if (!iFail) pass(`[CONTRACT] I. ${ENC_KEYS.length} encryption env vars are never bound or assigned in ${srcFiles.length} src files (process.env reads only)`);

// ─────────────────────────────────────────────────────────────────────────────
say("");
if (fail) {
  say(`check:no-secrets — FAIL (${fail}${blocked ? `, ${blocked} blocked` : ""})`);
  process.exit(1);
}
if (blocked) {
  say(`check:no-secrets — CANNOT ASSERT (${blocked} blocked). Failing closed rather than reporting PASS.`);
  process.exit(2);
}
say("check:no-secrets — PASS");
