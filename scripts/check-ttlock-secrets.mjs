#!/usr/bin/env node
// ============================================================
// check:ttlock-secrets — the TTLock layer's invariants: five for the connection
// (D122), three for the lock list and its room mapping (D123), four for the
// passcodes and the worker tick (D124).
//
// THE STANDARD THIS GUARD IS HELD TO. It must fail when the SEMANTIC CORE is
// neutralised while the STRUCTURE stays intact. Deleting a file is not the
// interesting case — anything catches that. The interesting cases are: a
// masked getter quietly starting to return the plaintext bag; a worker-graph
// module growing a `next/headers` import; a query losing its tenant filter; an
// audit payload gaining a `password` key; a client component pulling this whole
// graph into the browser bundle; a sync deciding it may overwrite the
// operator's room mapping or delete a lock it did not see; a background tick
// quietly gaining the power to change what a physical door accepts. Each of the
// twelve rules below was verified by BREAKING it and confirming this script goes
// red (B2) — rules 1-8 re-verified for D124, because the shared scanner grew
// functionBodies/reachableFrom and a change to shared parsing invalidates every
// earlier proof.
//
// Rule 5 carried extra weight through D123: tsconfig.worker.json's include list
// is exactly ["src/lib/channel/worker.ts"], so tsc could not see src/lib/ttlock/
// at all until a worker file imported it, and this script was the ONLY
// enforcement that existed. As of D124 worker.ts imports tick.ts, so tsc now
// compiles the graph too — but rule 5 still covers what tsc cannot: it follows
// imports transitively rather than trusting a `server-only` directive that
// resolves to an empty module outside React's react-server condition.
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

    // d) EXACTLY ONE deliberate cross-tenant read exists (D124): the worker tick
    //    has to discover which tenants have a TTLock credential before it can
    //    scope anything to one. It is exempt only if it SAYS SO and selects
    //    nothing but tenant_id — a fan-out that grew a ciphertext column would
    //    be a completely different query wearing the same marker, and this stays
    //    red for it.
    const sqlOnly = q.replace(/--[^\n]*/g, "").trim();
    const isTenantEnumeration =
      /--\s*CROSS-TENANT/.test(q) && /^SELECT\s+tenant_id\s+FROM\b/i.test(sqlOnly);

    const scoped = isTenantEnumeration || (isInsert
      ? Boolean(insertCols ? /\btenant_id\b/.test(insertCols[1]) : /\btenant_id\b/.test(insertHead))
      : /tenant_id\s*=\s*\$\{/.test(q) || /\bWHERE\s+id\s*=\s*\$\{/i.test(q));

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

// Extract each call's ARGUMENT TEXT by matching parentheses, not by regex.
//
// A non-greedy `[\s\S]*?\n\s*\)\s*;` looks equivalent and is not: it terminates
// on the first line that happens to end in `);`, so a call written on ONE line
// runs on and swallows whatever follows until some later statement closes that
// way. It cost a false failure here — a `sql<{ code: string }[]>` annotation
// two statements below an audit call was read as an audit key — and the same
// slip in the other direction would let a real payload key escape the scan by
// sitting after a one-line call.
const extractCalls = (src, name) => {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  while (re.exec(src) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return out;
};

const auditCalls = [
  ...extractCalls(actions, "audit"),
  ...extractCalls(actions, "writeAudit"),
].map((args) => [args]);
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

// ============================================================
// RULE 9 — the passcode SYNC never calls a TTLock WRITE endpoint (D124).
//
// These are live codes on live doors. A read that quietly gained the ability to
// add or delete one would mean a background worker changing what a physical
// door accepts, on a five-minute timer, with nobody having pressed anything.
// The ONLY sanctioned writer is rotateApartmentCode, invoked by a person.
//
// Checked across the CALL GRAPH, not one function body: syncPasscodes itself
// contains no endpoint string — it calls fetchPasscodes, which does. A rule that
// only read the top-level body would pass while a helper it calls did the
// forbidden thing.
// ============================================================
const passcodes = code(`${TTLOCK_DIR}/passcodes.ts`);

// name → body, for every function declared in the file.
//
// THE PARAMETER LIST MUST BE SKIPPED BY PAREN MATCHING FIRST. Taking the first
// `{` after the function name finds the brace of an INLINE OBJECT TYPE when one
// appears in the signature — `(items: { lockId: string }[])` — and the body
// then "ends" a few characters later. That is not a cosmetic slip: a rule
// asking "does this function's body do X" would be reading a type annotation
// and quietly answering no. Found by rule 16 failing on a correct
// implementation; every rule built on this helper depended on it.
const functionBodies = (src) => {
  const map = new Map();
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 1. walk the parameter list to its closing paren
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    // 2. the body opens at the first `{` after it (skipping a return type)
    const open = src.indexOf("{", i);
    if (open === -1) continue;
    // 3. brace-match the body
    depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    map.set(m[1], src.slice(open, j));
  }
  return map;
};

const reachableFrom = (bodies, entry) => {
  const seen = new Set();
  const stack = [entry];
  const out = [];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur) || !bodies.has(cur)) continue;
    seen.add(cur);
    const body = bodies.get(cur);
    out.push([cur, body]);
    for (const name of bodies.keys()) {
      if (name !== cur && new RegExp(`\\b${name}\\s*\\(`).test(body)) stack.push(name);
    }
  }
  return out;
};

const passcodeBodies = functionBodies(passcodes);
assert.ok(passcodeBodies.has("syncPasscodes"), "RULE 9: syncPasscodes is declared in passcodes.ts");

const WRITE_ENDPOINTS = /\/v3\/keyboardPwd\/(add|change|delete|get)/;
const syncReach = reachableFrom(passcodeBodies, "syncPasscodes");
assert.ok(syncReach.length >= 2, "RULE 9: syncPasscodes reaches its fetch helper");
for (const [name, body] of syncReach) {
  for (const lit of body.matchAll(/["'](\/v3\/[^"']+)["']/g)) {
    assert.ok(
      !WRITE_ENDPOINTS.test(lit[1]),
      `RULE 9: the passcode sync reaches a WRITE endpoint (${lit[1]}) via ${name}() — sync is read-only upstream`,
    );
  }
}
ok(`RULE 9 — the passcode sync calls no TTLock write endpoint (${syncReach.length} functions in its call graph)`);

// ============================================================
// RULE 10 — no sync path UPDATEs `role` on an existing passcode row (D124).
//
// role is decided from the code's NAME the first time we see it, and names are
// operator-editable upstream. If classification re-ran on every sync, renaming
// "דירה 4" to "דירה 4 (ישן)" would turn the guest's code into 'other' — and the
// rotate button would then mint a SECOND apartment code beside a live one
// instead of replacing it. A rename containing "מנהל" is worse: it would make
// the guest's code look like the manager's, the one code this feature may never
// rotate.
//
// Assigning role in an INSERT is correct and stays legal. What is forbidden is
// re-assigning it: the ON CONFLICT DO UPDATE SET, or an UPDATE's SET clause.
// ============================================================
const syncWriteQueries = [];
for (const [, body] of syncReach) {
  for (const q of extractSqlTemplates(body)) {
    if (/^\s*(INSERT\s+INTO|UPDATE)\b/i.test(q.trim())) syncWriteQueries.push(q);
  }
}
assert.ok(syncWriteQueries.length >= 2, "RULE 10: the sync performs its upsert and its missing-stamp writes");

for (const q of syncWriteQueries) {
  const isInsert = /^\s*INSERT\s+INTO/i.test(q.trim());
  // insert → ONLY the conflict-update half (the column list may assign role).
  // update → the SET clause, cut at WHERE so filtering on role stays legal.
  const conflict = isInsert ? q.split(/\bDO\s+UPDATE\s+SET\b/i)[1] : null;
  const reassigns = isInsert
    ? (conflict ?? "").split(/\bRETURNING\b/i)[0]
    : q.split(/\bWHERE\b/i)[0];
  assert.ok(
    !/\brole\s*=/.test(reassigns),
    `RULE 10: a sync path re-assigns role on an existing passcode row — classification is an INSERT-time decision:\n${reassigns.trim().slice(0, 200)}`,
  );
}
ok("RULE 10 — the sync assigns role only on insert; an upstream rename cannot reclassify a live code");

// ============================================================
// RULE 11 — a full passcode never reaches an audit payload or a log line.
//
// The code itself is not encrypted and does not need to be: it is five digits
// the operator reads off the screen and says out loud. What must not happen is
// that it becomes DURABLE somewhere nobody is looking — an audit row lives in
// every backup forever, and a pm2 log is world-readable on the box. maskCode()
// is the only form allowed in either.
//
// Returning the full code from the rotate ACTION is explicitly fine: it goes to
// the authorized operator who pressed the button, and nowhere else.
// ============================================================
const locksActions = code("src/app/(dashboard)/locks/actions.ts");
const CODE_KEYS = /^(code|newCode|oldCode|passcode|keyboardPwd)$/;

const locksAuditCalls = [
  ...extractCalls(locksActions, "audit"),
  ...extractCalls(locksActions, "writeAudit"),
].map((args) => [args]);
assert.ok(locksAuditCalls.length > 0, "RULE 11: the locks actions record audit entries");
for (const call of locksAuditCalls) {
  for (const kv of call[0].matchAll(/\b([A-Za-z_]\w*)\s*:\s*([^,\n}]+)/g)) {
    if (!CODE_KEYS.test(kv[1])) continue;
    assert.ok(
      /maskCode\s*\(|Masked\b|\bnull\b/.test(kv[2]),
      `RULE 11: an audit payload carries "${kv[1]}: ${kv[2].trim().slice(0, 60)}" — audit maskCode(...) instead of the digits`,
    );
  }
}

// …and no log/console sink in the ttlock graph interpolates a code value. The
// pattern is deliberately narrow: `${summary.passcodesAdded}` is a COUNT and
// must stay legal, while `${code}` and `${row.code}` must not.
const CODE_INTERPOLATION = /\$\{[^}]*(?:\bcode\b|\bnewCode\b|\boldCode\b|\.code\b)[^}]*\}/;
for (const f of [...ttlockFiles.map((x) => `${TTLOCK_DIR}/${x}`), "src/app/(dashboard)/locks/actions.ts"]) {
  const src = code(f);
  for (const call of src.matchAll(/\b(?:log|console\.(?:log|error|warn|info))\s*\(([\s\S]*?)\)\s*;/g)) {
    assert.ok(
      !CODE_INTERPOLATION.test(call[1]),
      `RULE 11: ${f} logs a passcode value:\n${call[1].trim().slice(0, 160)}`,
    );
  }
}
// …and the DISPLAY SUFFIX never becomes part of a code.
//
// The keypad wants the code terminated with #, so the /locks screen renders and
// copies `62245#`. That is presentation and must stay presentation: the stored
// code, the value sent to /v3/keyboardPwd/add, the audit mask and the duplicate
// check are digits. A "#" that reached the ADD payload would put a code on the
// door that nobody can log in as, and the local row would disagree with the
// hardware with no way to tell which is right.
//
// Two layers, because the suffix could arrive at either end:
//  a) the keyboardPwd VALUE handed to the http layer, and
//  b) any "#" at all in src/lib/ttlock/ — which catches the subtler version,
//     where the suffix is baked into the code before the call is even built.
for (const name of ["ttlockAuthedRequest", "ttlockRequest"]) {
  for (const args of extractCalls(passcodes, name)) {
    for (const kv of args.matchAll(/\bkeyboardPwd\s*:\s*([^,\n]+)/g)) {
      assert.ok(
        !kv[1].includes("#"),
        `RULE 11: a "#" reaches the TTLock payload as keyboardPwd: ${kv[1].trim().slice(0, 60)} — the suffix is presentation only`,
      );
    }
  }
}
for (const f of ttlockFiles) {
  const src = code(`${TTLOCK_DIR}/${f}`);
  assert.ok(
    !src.includes("#"),
    `RULE 11: ${f} contains a "#" — the keypad display suffix belongs to the screen, never to a stored or transmitted code`,
  );
}
ok("RULE 11 — no full passcode reaches an audit payload or a log line, and the display suffix never reaches a code");

// ============================================================
// RULE 12 — passcodes.ts and tick.ts stay worker-graph-safe (D124).
//
// This is the task where tsconfig.worker.json ACTUALLY starts compiling
// src/lib/ttlock/: worker.ts imports tick.ts, so the whole graph below it —
// tick, passcodes, locks, token, http, crypto — is compiled to plain CommonJS
// for PM2. Rule 2 made this promise for the connection layer before anything
// tested it; rule 12 extends it to the three files that made it real, including
// locks.ts, which rule 2 never listed.
// ============================================================
const TICK_SAFE = ["passcodes.ts", "tick.ts", "locks.ts"];
for (const f of TICK_SAFE) {
  const src = code(`${TTLOCK_DIR}/${f}`);
  assert.ok(
    !/^\s*import\s+["']server-only["']/m.test(src),
    `RULE 12: ${f} must not import "server-only" — the PM2 worker compiles it`,
  );
  for (const m of src.matchAll(FORBIDDEN_IMPORT)) {
    const spec = m[1];
    assert.ok(!spec.startsWith("next/") && spec !== "next", `RULE 12: ${f} must not import ${spec}`);
    assert.ok(spec !== "react" && !spec.startsWith("react/"), `RULE 12: ${f} must not import ${spec}`);
    assert.ok(spec !== "server-only", `RULE 12: ${f} must not import server-only`);
  }
  for (const dep of walkGraph(`${TTLOCK_DIR}/${f}`)) {
    assert.ok(
      !isUseServer(dep),
      `RULE 12: ${f} reaches the "use server" module ${dep} — the worker graph cannot compile it`,
    );
  }
}
// The wiring itself: the worker must actually call the tick, or every promise
// above is about a file nothing runs.
const channelWorker = code("src/lib/channel/worker.ts");
assert.ok(
  /runTTLockTick\s*\(/.test(channelWorker),
  "RULE 12: src/lib/channel/worker.ts calls runTTLockTick — the tick is wired in, not orphaned",
);
ok(`RULE 12 — ${TICK_SAFE.join(", ")} are worker-graph-safe and the tick is wired into the channel worker`);

// ============================================================
// RULE 16 — the bulk rotate touches ONLY the locks it was handed (D125).
//
// One operator gesture now rotates ten doors. The failure mode that matters is
// not a bad code, it is a WIDER SET than the operator selected: a loop over
// "this tenant's locks" instead of over the validated input would rotate every
// door in the building from a three-row selection, and each rotation is a real
// code on a real door that the guest in front of it does not have.
//
// So: the action's rotation loop must iterate the PARSED INPUT. Reading the
// selected locks from the database to validate them is fine and necessary —
// what may not happen is a query that enumerates locks without being bounded by
// the submitted ids.
// ============================================================
const bulkBodies = functionBodies(locksActions);
assert.ok(
  bulkBodies.has("bulkRotateApartmentCodesAction"),
  "RULE 16: bulkRotateApartmentCodesAction is declared in the locks actions",
);
const bulkBody = bulkBodies.get("bulkRotateApartmentCodesAction");

// EVERY loop in this action iterates the validated array — not "at least one".
//
// Asserting that a parsed.data loop merely EXISTS is not the same claim, and
// the difference is not academic: this action also runs a duplicate-id check
// over parsed.data, so the weaker rule was satisfied by that loop while the
// rotation loop underneath it iterated a database query. The B2 break that
// swapped exactly that produced no failure. Found by running the pass.
// PAREN-MATCHED, not `[^)]+`. A character class that cannot cross a `)` simply
// FAILS TO MATCH a loop whose iterable contains a call — `lockRows.map(...)` —
// and a header the rule never sees is a header the rule never checks. The
// second B2 attempt walked straight through that hole too.
const forHeadersOf = (body) => {
  const out = [];
  const re = /\bfor\s*\(/g;
  while (re.exec(body) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
    }
    out.push(body.slice(re.lastIndex, i - 1).trim());
    re.lastIndex = i;
  }
  return out;
};

const forHeaders = forHeadersOf(bulkBody);
assert.ok(forHeaders.length > 0, "RULE 16: the bulk action iterates its input");
for (const header of forHeaders) {
  const m = header.match(/^(?:const|let)\s+\w+\s+of\s+(.+)$/s);
  assert.ok(
    m && m[1].trim() === "parsed.data",
    `RULE 16: a loop in the bulk rotate iterates "${(m ? m[1] : header).trim().slice(0, 60)}" instead of parsed.data — only the operator's validated selection may be rotated`,
  );
}
// Every lock query inside it is bounded by those ids.
for (const q of extractSqlTemplates(bulkBody)) {
  if (!/\bttlock_locks\b/.test(q)) continue;
  assert.ok(
    /\bid\s*=\s*ANY\s*\(\$\{/.test(q) || /\bid\s*=\s*\$\{/.test(q),
    `RULE 16: a bulk-rotate query reads ttlock_locks without bounding it to the submitted ids:\n${q.trim().slice(0, 200)}`,
  );
}
// And rotateApartmentCode is never called with a lock id that did not come from
// an item of that array.
for (const args of extractCalls(bulkBody, "rotateApartmentCode")) {
  assert.ok(
    /lockRowId:\s*item\.lockId/.test(args),
    `RULE 16: bulk rotate calls rotateApartmentCode with something other than item.lockId:\n${args.trim().slice(0, 160)}`,
  );
}
ok("RULE 16 — the bulk rotate applies only to the locks in its validated input");

// ============================================================
// RULE 17 — an operator-typed code clears the SAME bar as a random draw (D125).
//
// The draw has always been filtered: no leading zero, no 11111, no 12345, and
// nothing already live on that door. A hand-typed code that skipped those
// checks would let the weakest possible code onto a real apartment door — and
// the tempting shape of that bug is not malice, it is a Zod schema that
// validates `^\d{4,6}$` and a caller that trusts it.
//
// Both paths therefore go through codeRejection, in rotateApartmentCode, before
// anything is written or sent. This rule pins that: the function exists, the
// requested path calls it and throws on a reason, and the banned patterns are
// not re-implemented in the action layer where they could drift.
// ============================================================
const passcodeSrc = code(`${TTLOCK_DIR}/passcodes.ts`);
assert.ok(
  /export function codeRejection\s*\(/.test(passcodeSrc),
  "RULE 17: codeRejection is the shared judgement and is exported",
);

const rotateBody = functionBodies(passcodeSrc).get("rotateApartmentCode");
assert.ok(rotateBody, "RULE 17: rotateApartmentCode is declared in passcodes.ts");
assert.ok(
  /codeRejection\s*\(\s*requestedCode/.test(rotateBody),
  "RULE 17: requestedCode must be judged by codeRejection before it is used",
);
assert.ok(
  /if\s*\(\s*reason\s*\)\s*throw/.test(rotateBody),
  "RULE 17: a rejection reason must THROW — a logged-and-ignored rejection is not a check",
);
// The rejection must happen BEFORE the code reaches the upstream payload.
const rejectionAt = rotateBody.indexOf("codeRejection");
const payloadAt = rotateBody.indexOf("keyboardPwd:");
assert.ok(
  rejectionAt !== -1 && payloadAt !== -1 && rejectionAt < payloadAt,
  "RULE 17: codeRejection must run before the code is placed in the TTLock payload",
);
// The random draw goes through the same function — otherwise the two drift.
assert.ok(
  /codeRejection\s*\(\s*candidate/.test(functionBodies(passcodeSrc).get("generateCode") ?? ""),
  "RULE 17: generateCode must use the same codeRejection, so both paths share one bar",
);
ok("RULE 17 — operator-typed and randomly-drawn codes pass identical validation before reaching a door");

console.log(`\ncheck-ttlock-secrets: all ${n} groups passed ✓`);
