#!/usr/bin/env node
// ============================================================
// check:ttlock-secrets — the TTLock layer's invariants: five for the connection
// (D122), three more for the lock list and its room mapping (D123).
//
// THE STANDARD THIS GUARD IS HELD TO. It must fail when the SEMANTIC CORE is
// neutralised while the STRUCTURE stays intact. Deleting a file is not the
// interesting case — anything catches that. The interesting cases are: a
// masked getter quietly starting to return the plaintext bag; a worker-graph
// module growing a `next/headers` import; a query losing its tenant filter; an
// audit payload gaining a `password` key; a client component pulling this whole
// graph into the browser bundle; a sync deciding it may overwrite the
// operator's room mapping or delete a lock it did not see. Each of the eight
// rules below was verified by BREAKING it and confirming this script goes red
// (B2) — rules 1-5 re-verified for D123, because extractSqlTemplates (shared
// parsing) changed and a fix to shared code invalidates the earlier proof.
//
// Rule 5 carries extra weight. tsconfig.worker.json's include list is exactly
// ["src/lib/channel/worker.ts"], so tsc cannot see src/lib/ttlock/ at all until
// a worker file imports it — which is the NEXT task. Until then this script is
// the only enforcement that exists, and rule 5 covers more than `server-only`
// ever did: it follows the import graph transitively rather than trusting a
// directive that resolves to an empty module outside React's react-server
// condition.
//
// Static only: no DB, no network, no build. Usage: node scripts/check-ttlock-secrets.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from THIS FILE's location, never an absolute checkout path — a guard
// must test the tree it lives in (check:guard-roots, D100).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

const read = (p) => readFileSync(join(ROOT, p), "utf8");
// Blank out comments while preserving line structure, so an assertion reasons
// about CODE and a reported line number stays real.
//
// LINE COMMENTS GO FIRST, and that order is load-bearing. Block-stripping first
// lets prose inside a `//` line open a block comment: the token "next/" followed
// by a star, written in a header explaining what must not be imported, swallowed
// everything up to the next JSDoc close — including the region constants this
// script asserts on. It cost a false failure to find; it could just as easily
// have hidden a real one by blanking the code under test.
const stripComments = (s) =>
  s
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const code = (p) => stripComments(read(p));

const TTLOCK_DIR = "src/lib/ttlock";
const ttlockFiles = readdirSync(join(ROOT, TTLOCK_DIR)).filter((f) => f.endsWith(".ts"));
assert.ok(ttlockFiles.length >= 4, "src/lib/ttlock/ carries the connection layer");

// ============================================================
// RULE 1 — no function reachable from a "use server" module returns a
// decrypted secret, token or password field.
//
// The masked view getter is the surface an action may hand to a client. If it
// ever grows a clientSecret/password/token field, every screen that renders it
// leaks a credential. getResolvedConnection is the ONE sanctioned plaintext
// path and is allowed to carry them — but it must never be what an action
// returns to the browser.
// ============================================================
const store = code(`${TTLOCK_DIR}/store.ts`);

// The masked view TYPE must not declare a plaintext field.
const viewType = store.match(/export type TTLockConnectionView = \{[\s\S]*?\n\};/);
assert.ok(viewType, "TTLockConnectionView is declared in store.ts");
for (const bad of ["clientSecret", "password", "accessToken", "secret_ciphertext", "refreshToken"]) {
  assert.ok(
    !new RegExp(`\\b${bad}\\b`).test(viewType[0]),
    `RULE 1: TTLockConnectionView must not expose ${bad}`,
  );
}

// getConnection's body must not touch a ciphertext column or a decrypt call.
const getConnBody = store.match(/export async function getConnection\([\s\S]*?\n\}/);
assert.ok(getConnBody, "getConnection is declared in store.ts");
assert.ok(
  !/decryptSecret|decryptSecretBag/.test(getConnBody[0]),
  "RULE 1: getConnection must never decrypt — it returns the masked view",
);
assert.ok(
  !/\baccess_token_ciphertext\b|\brefresh_token_ciphertext\b/.test(getConnBody[0]),
  "RULE 1: getConnection must not even SELECT a token column",
);
assert.ok(
  /secret_hint/.test(getConnBody[0]) && /IS NOT NULL\) AS has_secret/.test(getConnBody[0]),
  "RULE 1: getConnection reports a masked hint + a boolean, not a value",
);

// The "use server" actions module must not return a plaintext field to a client.
const actions = code("src/app/(dashboard)/settings/ttlock-actions.ts");
assert.ok(/^"use server";/m.test(actions), "ttlock-actions.ts is a \"use server\" module");
for (const m of actions.matchAll(/return \{\s*success: true[\s\S]{0,400?}?\};/g)) {
  for (const bad of ["clientSecret", "password", "accessToken", "refreshToken", "ciphertext"]) {
    assert.ok(
      !new RegExp(`\\b${bad}\\b`).test(m[0]),
      `RULE 1: a success return in ttlock-actions.ts must not carry ${bad}`,
    );
  }
}
// The resolved (plaintext) connection must never be spread into a return value.
assert.ok(
  !/return \{[^}]*\.\.\.resolved/.test(actions),
  "RULE 1: the resolved connection is never spread into an action's return value",
);
ok("RULE 1 — no decrypted secret/token/password escapes through a \"use server\" surface");

// ============================================================
// RULE 2 — http.ts and token.ts stay worker-graph-safe.
//
// The PM2 worker compiles to plain CommonJS through tsconfig.worker.json. A
// single next/* or react import here is a compile failure in the LATER task,
// discovered at the worst possible moment. Caught now instead.
// ============================================================
const WORKER_SAFE = ["http.ts", "token.ts", "crypto.ts"];
const FORBIDDEN_IMPORT = /\b(?:import|require)\s*(?:[^;]*?from\s*)?["']([^"']+)["']/g;

for (const f of WORKER_SAFE) {
  const src = code(`${TTLOCK_DIR}/${f}`);
  assert.ok(
    !/^\s*import\s+["']server-only["']/m.test(src),
    `RULE 2: ${f} must not import "server-only" (D122 — it is not the enforcement here)`,
  );
  for (const m of src.matchAll(FORBIDDEN_IMPORT)) {
    const spec = m[1];
    assert.ok(!spec.startsWith("next/") && spec !== "next", `RULE 2: ${f} must not import ${spec}`);
    assert.ok(spec !== "react" && !spec.startsWith("react/"), `RULE 2: ${f} must not import ${spec}`);
    assert.ok(spec !== "server-only", `RULE 2: ${f} must not import server-only`);
  }
}

// ...and must not reach a "use server" module, directly or transitively.
const resolveLocal = (fromFile, spec) => {
  let base;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, fromFile)), spec);
  else return null; // bare package — not ours to follow
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return relative(ROOT, cand);
  }
  return null;
};

const isUseServer = (relPath) => /^\s*["']use server["']\s*;/m.test(read(relPath));

const walkGraph = (entry) => {
  const seen = new Set();
  const stack = [entry];
  const out = [];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const m of code(cur).matchAll(FORBIDDEN_IMPORT)) {
      const next = resolveLocal(cur, m[1]);
      if (next) stack.push(next);
    }
  }
  return out;
};

for (const f of WORKER_SAFE) {
  for (const dep of walkGraph(`${TTLOCK_DIR}/${f}`)) {
    assert.ok(
      !isUseServer(dep),
      `RULE 2: ${f} reaches the "use server" module ${dep} — the worker graph cannot compile it`,
    );
  }
}
ok("RULE 2 — http.ts/token.ts/crypto.ts import no server-only, next/*, react, or \"use server\" module");

// ============================================================
// RULE 3 — every guesthub. table reference in src/lib/ttlock/ is tenant-scoped.
//
// The exception is deliberate and narrow: token.ts's UPDATE targets a
// connection row by its PRIMARY KEY (id), which the caller already resolved
// under a tenant filter. A row id is strictly narrower than a tenant filter, so
// it satisfies scoping — but nothing else may claim that exemption.
// ============================================================
// Extract each tagged SQL template WHOLE.
//
// A regex cannot do this. A COALESCE keep-existing fragment (sql`guesthub.t.col`)
// is a nested template inside a ${...} of a real query, and a non-greedy match
// terminates on its backtick — silently truncating the outer UPDATE before its
// WHERE, which is exactly how an unscoped query would slip past this rule. So:
// scan, tracking ${} depth, and skip nested templates wholesale.
//
// BOTH TAG NAMES, and that is not cosmetic. locks.ts takes its connection as a
// parameter named `db` (it is worker-graph code and cannot import the
// server-only `sql` singleton), so a scanner that only knew `sql` would have
// stopped covering an entire new file in the very directory this rule guards —
// silently, with rule 3 still printing a tick. Adding `db` here re-covers it.
function extractSqlTemplates(src) {
  const out = [];
  const re = /\b(?:sql|db)(?:<[^>]*>)?`/g;
  while (re.exec(src) !== null) {
    let i = re.lastIndex;
    let depth = 0;
    let buf = "";
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { buf += src.slice(i, i + 2); i += 2; continue; }
      if (c === "$" && src[i + 1] === "{") { depth++; buf += "${"; i += 2; continue; }
      if (c === "}" && depth > 0) { depth--; buf += "}"; i++; continue; }
      if (c === "`") {
        if (depth === 0) { i++; break; } // closes THIS template
        // nested template inside an interpolation — consume and drop it
        let j = i + 1;
        let nest = 0;
        while (j < src.length) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "$" && src[j + 1] === "{") { nest++; j += 2; continue; }
          if (src[j] === "}" && nest > 0) { nest--; j++; continue; }
          if (src[j] === "`" && nest === 0) { j++; break; }
          j++;
        }
        i = j;
        continue;
      }
      buf += c;
      i++;
    }
    out.push(buf);
    re.lastIndex = i;
  }
  return out;
}

for (const f of ttlockFiles) {
  for (const q of extractSqlTemplates(code(`${TTLOCK_DIR}/${f}`))) {
    if (!/guesthub\./.test(q)) continue;

    // Three shapes count as scoped, and nothing else does:
    //  a) a WHERE filter binding tenant_id — SELECT / UPDATE / DELETE;
    //  b) an INSERT whose COLUMN LIST carries tenant_id (a row cannot be
    //     written into another tenant if the column is supplied every time);
    //  c) a WHERE on the primary key, used only by token.ts's token write —
    //     the caller already resolved that id under a tenant filter, and a row
    //     id is strictly narrower than a tenant filter.
    const isInsert = /^\s*INSERT\s+INTO/i.test(q.trim());
    const insertCols = isInsert ? q.match(/INSERT\s+INTO\s+[\w.]+\s*\(([^)]*)\)/i) : null;
    // A batch upsert written with porsager's helper — INSERT INTO t ${db(rows,
    // "tenant_id", …)} — carries its column list INSIDE the interpolation, so
    // there is no parenthesised list to read. Fall back to scanning the
    // statement HEAD, cut at ON CONFLICT so a DO UPDATE SET can never satisfy
    // the rule on the insert's behalf.
    const insertHead = isInsert ? q.split(/\bON\s+CONFLICT\b/i)[0] : "";
    const scoped = isInsert
      ? Boolean(insertCols ? /\btenant_id\b/.test(insertCols[1]) : /\btenant_id\b/.test(insertHead))
      : /tenant_id\s*=\s*\$\{/.test(q) || /\bWHERE\s+id\s*=\s*\$\{/i.test(q);

    assert.ok(
      scoped,
      `RULE 3: ${f} queries a guesthub. table without tenant scoping:\n${q.trim().slice(0, 200)}`,
    );
  }
}
ok("RULE 3 — every guesthub. query in src/lib/ttlock/ is tenant-scoped (or keyed by row id)");

// ============================================================
// RULE 4 — no ttlock audit call passes a secret-shaped field.
//
// An audit row is durable, exportable and read by humans. A credential that
// lands in one is a credential in a backup forever.
// ============================================================
const BANNED_AUDIT_KEYS = ["password", "secret", "token", "clientSecret"];
const auditCalls = [
  ...actions.matchAll(/\baudit\s*\(\s*actor\s*,\s*[\s\S]*?\n\s*\}\s*\)\s*;/g),
  ...actions.matchAll(/\bwriteAudit\s*\([\s\S]*?\n\s*\}\s*\)\s*;/g),
];
assert.ok(auditCalls.length > 0, "RULE 4: ttlock-actions.ts records audit entries");
for (const call of auditCalls) {
  // Object KEYS only — "clientSecretProvided: Boolean(...)" is a boolean about
  // whether a value arrived, not the value, and is explicitly fine.
  for (const key of call[0].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    const name = key[1];
    assert.ok(
      !BANNED_AUDIT_KEYS.includes(name),
      `RULE 4: an audit payload in ttlock-actions.ts passes a field named "${name}"`,
    );
  }
}
// And the upstream body is never audited wholesale.
assert.ok(
  !/audit\([^)]*\bbody\b/.test(actions),
  "RULE 4: the upstream TTLock body never enters an audit payload",
);
ok("RULE 4 — no ttlock audit payload carries a password/secret/token/clientSecret field");

// ============================================================
// RULE 5 — no "use client" file reaches src/lib/ttlock/, directly or
// transitively.
//
// This is the risk `server-only` was standing in for, checked properly: a
// client component that imports this graph pulls node:crypto and the whole
// TTLock HTTP layer toward the browser bundle. The settings SECTION is a
// client component and must reach the server only through the "use server"
// actions module — which is a boundary, not an import.
// ============================================================
const collectSourceFiles = (dir) => {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectSourceFiles(rel));
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
};

const allSources = collectSourceFiles("src");
const clientFiles = allSources.filter((f) => /^\s*["']use client["']\s*;/m.test(read(f)));
assert.ok(clientFiles.length > 0, "RULE 5: the tree has client components to check");

const TTLOCK_PREFIX = TTLOCK_DIR.replace(/\\/g, "/");
for (const cf of clientFiles) {
  // A "use server" module is a NETWORK BOUNDARY, not an import: the client gets
  // a stub, the body stays on the server. Following through one would report
  // every settings screen as a violation and make this rule useless.
  const seen = new Set();
  const stack = [cf];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cur !== cf && isUseServer(cur)) continue;
    for (const m of code(cur).matchAll(FORBIDDEN_IMPORT)) {
      const spec = m[1];
      const hitsTTLock =
        spec.startsWith("@/lib/ttlock") ||
        (spec.startsWith(".") &&
          (resolveLocal(cur, spec) ?? "").replace(/\\/g, "/").startsWith(TTLOCK_PREFIX));
      assert.ok(
        !hitsTTLock,
        `RULE 5: client component ${cf} reaches ${TTLOCK_PREFIX} via ${cur} → ${spec}`,
      );
      const next = resolveLocal(cur, spec);
      if (next) stack.push(next);
    }
  }
}
ok(`RULE 5 — no "use client" file reaches ${TTLOCK_PREFIX} (${clientFiles.length} client components walked)`);

// ============================================================
// RULE 6 — syncLocks never WRITES room_id (D123).
//
// The lock→room binding is operator knowledge that exists nowhere upstream:
// TTLock knows a door as "דירה 4 כניסה" and has never heard of room 402. An
// upstream row can therefore never have an opinion about it. The enforcement in
// the code is an OMISSION — room_id is simply absent from the insert's column
// list and from the DO UPDATE SET — and an omission is exactly the kind of
// protection a later edit restores by accident. Hence a rule.
//
// Reads are fine. This checks what a statement can ASSIGN: an insert's column
// list plus its conflict update, and an update's SET clause (cut at WHERE, so
// filtering on room_id stays legal).
// ============================================================
const locks = code(`${TTLOCK_DIR}/locks.ts`);
const syncBody = locks.match(/export async function syncLocks\([\s\S]*?\n\}/);
assert.ok(syncBody, "RULE 6: syncLocks is declared in locks.ts");

const syncWrites = extractSqlTemplates(syncBody[0]).filter((q) =>
  /^\s*(INSERT\s+INTO|UPDATE)\b/i.test(q.trim()),
);
assert.ok(syncWrites.length >= 2, "RULE 6: syncLocks performs the upsert and the missing-stamp writes");

for (const q of syncWrites) {
  const isInsert = /^\s*INSERT\s+INTO/i.test(q.trim());
  // insert → everything it assigns, i.e. up to RETURNING (column list + the
  // ON CONFLICT DO UPDATE SET). update → up to WHERE, i.e. the SET clause.
  const writeSpec = isInsert ? q.split(/\bRETURNING\b/i)[0] : q.split(/\bWHERE\b/i)[0];
  assert.ok(
    !/\broom_id\b/.test(writeSpec),
    `RULE 6: syncLocks assigns room_id — the operator's mapping is not the sync's to write:\n${writeSpec.trim().slice(0, 200)}`,
  );
}
ok("RULE 6 — syncLocks never writes room_id (the operator's mapping survives every sync)");

// ============================================================
// RULE 7 — no sync path DELETEs from guesthub.ttlock_locks (D123).
//
// The obvious "sync" is fetch, upsert, delete-the-rest. That implementation
// destroys operator work: a gateway that is offline, a paging edge, a rate
// limit or a lock temporarily unshared all return a SHORTER list, and each
// would silently drop a hand-built mapping. A lock the response did not carry
// is STAMPED (missing_since) and kept.
//
// Scoped to src/lib/ttlock/ on purpose. Deletion is not forbidden forever — it
// is forbidden HERE. An operator-initiated delete would live in the actions
// module, behind a permission and a confirmation, where a human decided it.
// ============================================================
for (const f of ttlockFiles) {
  const src = code(`${TTLOCK_DIR}/${f}`);
  for (const q of extractSqlTemplates(src)) {
    if (!/\bttlock_locks\b/.test(q)) continue;
    assert.ok(
      !/\bDELETE\s+FROM\b/i.test(q) && !/\bTRUNCATE\b/i.test(q),
      `RULE 7: ${f} deletes from ttlock_locks — a short upstream list is a fault, not an instruction to forget a mapping:\n${q.trim().slice(0, 200)}`,
    );
  }
}
// …and not through a raw call that skips the tagged-template scanner either.
assert.ok(
  !/DELETE\s+FROM\s+guesthub\.ttlock_locks/i.test(locks),
  "RULE 7: locks.ts contains no DELETE against ttlock_locks in any form",
);
ok("RULE 7 — no sync path deletes a lock row; an absent lock is stamped, not forgotten");

// ============================================================
// RULE 8 — every guesthub. query in locks.ts is tenant-scoped, with no
// primary-key exemption.
//
// Rule 3 grants one narrow exemption: token.ts writes a connection row by its
// id, which the caller already resolved under a tenant filter. locks.ts gets no
// such exemption. It is the module a worker tick will call with a tenant id and
// nothing else, so every statement in it must carry that filter explicitly —
// there is no "the caller already checked" to lean on when the caller is a cron.
// ============================================================
// SELECTED BY TABLE REFERENCE, NOT BY THE STRING "guesthub." — and that
// distinction was found by breaking this rule. Filtering on /guesthub\./ meant
// UNQUALIFYING a table also removed the query from the rule's own scope: the
// guard stayed green on exactly the edit it exists to catch. A rule whose
// trigger is the thing it forbids is not a rule.
const tableRefsOf = (q) => {
  const leadingUpdate = q.trim().match(/^UPDATE\s+([A-Za-z_][\w.]*)(\s*\()?/i);
  return [
    ...q.matchAll(/\b(?:FROM|JOIN|INSERT\s+INTO)\s+([A-Za-z_][\w.]*)(\s*\()?/gi),
    ...(leadingUpdate ? [leadingUpdate] : []),
    // A name followed by "(" is a set-returning FUNCTION in the FROM clause
    // (jsonb_to_recordset, unnest), not a relation. It carries no tenant data
    // of its own, so a schema requirement on it would be nonsense.
  ].filter((m) => !m[2]);
};

const locksQueries = extractSqlTemplates(locks).filter((q) => tableRefsOf(q).length > 0);
assert.ok(locksQueries.length >= 3, "RULE 8: locks.ts queries the connection and the locks table");

for (const q of locksQueries) {
  // Every table reference is schema-qualified — an unqualified name resolves
  // through search_path, which is not a guarantee. Only a LEADING `UPDATE`
  // names a table: the `UPDATE` in `ON CONFLICT DO UPDATE SET` is a clause
  // keyword and its next token is SET, not a relation.
  for (const m of tableRefsOf(q)) {
    assert.ok(
      m[1].startsWith("guesthub."),
      `RULE 8: locks.ts references the unqualified table "${m[1]}" — qualify it guesthub.<table>`,
    );
  }

  const isInsert = /^\s*INSERT\s+INTO/i.test(q.trim());
  const head = isInsert ? q.split(/\bON\s+CONFLICT\b/i)[0] : q;
  const scoped = isInsert
    ? /\btenant_id\b/.test(head)
    : /tenant_id\s*=\s*\$\{/.test(q);
  assert.ok(
    scoped,
    `RULE 8: locks.ts queries a guesthub. table without a tenant filter (no row-id exemption here):\n${q.trim().slice(0, 200)}`,
  );
}
ok(`RULE 8 — all ${locksQueries.length} guesthub. queries in locks.ts are schema-qualified and tenant-scoped`);

// ============================================================
// Supporting invariants — the construction the eight rules assume.
// ============================================================
const crypto = code(`${TTLOCK_DIR}/crypto.ts`);
assert.ok(/aes-256-gcm/.test(crypto), "authenticated AES-256-GCM");
assert.ok(/TTLOCK_SECRETS_KEY/.test(crypto), "dedicated key = TTLOCK_SECRETS_KEY");
assert.ok(
  !/CHANNEL_SECRETS_KEY|MESSAGING_SECRETS_ENCRYPTION_KEY/.test(crypto),
  "no key reuse across integrations (separate blast radius)",
);
assert.ok(/is not configured/.test(crypto) && /throw/.test(crypto), "fail-closed on a missing key");
assert.ok(/randomBytes\(12\)/.test(crypto), "fresh random 96-bit IV per value");
ok("crypto.ts — AES-256-GCM, dedicated TTLOCK_SECRETS_KEY, fail-closed, fresh IV");

const http = code(`${TTLOCK_DIR}/http.ts`);
assert.ok(/application\/x-www-form-urlencoded/.test(http), "form-encoded POST (every endpoint, including reads)");
assert.ok(/errcode !== 0/.test(http), "a 200 OK with a non-zero errcode is a FAILURE and throws");
assert.ok(/AbortSignal\.timeout/.test(http), "every request is timeout-bounded");
assert.ok(/euapi\.ttlock\.com/.test(http) && /api\.ttlock\.com/.test(http), "both regions are reachable");
assert.ok(/isClientError/.test(http) && /10001/.test(http), "10001 is distinguished from a password problem");
assert.ok(
  /hebrewMessageFor/.test(http) && !/errmsg\}/.test(http.replace(/`[^`]*errcode[^`]*`/g, "")),
  "hebrewMessageFor maps by CODE — the Chinese errmsg is never echoed",
);
ok("http.ts — form POST, errcode-not-status, timeouts, both regions, Hebrew by code");

const token = code(`${TTLOCK_DIR}/token.ts`);
assert.ok(/md5Hex/.test(token), "the account password goes on the wire as lowercase hex MD5");
assert.ok(/grant_type: "refresh_token"/.test(token), "refresh grant is attempted first");
assert.ok(/grant_type: "password"/.test(token), "password grant is the fallback");
assert.ok(/await persist\(/.test(token), "the minted token is persisted BEFORE it is returned");
assert.ok(/EXPIRY_SAFETY_MS/.test(token), "the expiry is persisted early against clock skew");
assert.ok(/inFlight/.test(token), "module-level single-flight per connection id");
assert.ok(
  /second process|SECOND process/.test(read(`${TTLOCK_DIR}/token.ts`)),
  "the single-flight comment states honestly that it is per-process, not global",
);
for (const f of ttlockFiles) {
  assert.ok(!/console\.(log|error|warn)/.test(code(`${TTLOCK_DIR}/${f}`)), `${f}: no console output`);
}
ok("token.ts — MD5 wire format, refresh→password fallback, persist-before-return, honest single-flight");

console.log(`\ncheck-ttlock-secrets: all ${n} groups passed ✓`);
