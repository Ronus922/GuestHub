// ============================================================
// check:bios-bot-auth — Phase 5 service credential (src/lib/bios-bot/config.ts,
// src/lib/bios-bot/guard.ts). Pure logic, no DB: compiles and calls the real
// requireBiosBotSecret / resolveBiosBotTenantId / authenticateBiosBotRequest.
//
// Asserts: no secret configured → refused; wrong secret → refused; correct
// secret → accepted; fail-closed when either side of the comparison is
// missing; tenant resolution never trusts anything from the request; the
// middleware bypass list contains exactly the new namespace, nothing wider.
//
// Usage: node scripts/check-bios-bot-auth.mjs
// ============================================================
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

// ---- compile the real modules ----
const tmp = mkdtempSync(join(tmpdir(), "gh-biosbot-auth-"));
const out = join(tmp, "out");
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    module: "commonjs", moduleResolution: "node10", target: "es2022",
    esModuleInterop: true, skipLibCheck: true, strict: true,
    baseUrl: join(ROOT, "src"), paths: { "@/*": ["*"] },
    rootDir: join(ROOT, "src"), outDir: out,
    typeRoots: [join(ROOT, "node_modules/@types")], types: ["node"],
  },
  include: [
    join(ROOT, "src/lib/bios-bot/config.ts"),
    join(ROOT, "src/lib/bios-bot/guard.ts"),
    join(ROOT, "src/lib/bios-bot/errors.ts"),
  ],
}));
execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });

const stub = join(tmp, "server-only-stub.js");
writeFileSync(stub, "module.exports = {};\n");
const nextServerStub = join(tmp, "next-server-stub.js");
// minimal NextResponse.json stand-in — enough for authenticateBiosBotRequest's
// return shape, without pulling in the real Next.js server runtime
writeFileSync(nextServerStub, `
  class FakeResponse {
    constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; }
  }
  module.exports = { NextResponse: { json: (body, init) => new FakeResponse(body, init) } };
`);
const req = createRequire(join(ROOT, "package.json"));
const Module = req("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return stub;
  if (request === "next/server") return nextServerStub;
  if (request.startsWith("@/")) return origResolve.call(this, join(out, request.slice(2)), ...rest);
  return origResolve.call(this, request, ...rest);
};

const config = req(join(out, "lib/bios-bot/config.js"));
const guard = req(join(out, "lib/bios-bot/guard.js"));

const fakeReq = (headers) => ({ headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

// ============================================================
// requireBiosBotSecret
// ============================================================
{
  delete process.env.BIOS_BOT_API_SECRET;
  assert.equal(config.requireBiosBotSecret(fakeReq({ "x-bios-bot-secret": "anything" })), false,
    "no server secret configured → always refused, even if a header is sent");
  ok("requireBiosBotSecret: fail-closed when BIOS_BOT_API_SECRET is unset");
}
{
  process.env.BIOS_BOT_API_SECRET = "correct-horse-battery-staple";
  assert.equal(config.requireBiosBotSecret(fakeReq({})), false, "server secret set, no header sent → refused");
  ok("requireBiosBotSecret: fail-closed when the caller sends no header");
}
{
  process.env.BIOS_BOT_API_SECRET = "correct-horse-battery-staple";
  assert.equal(config.requireBiosBotSecret(fakeReq({ "x-bios-bot-secret": "wrong-value" })), false,
    "wrong secret → refused");
  ok("requireBiosBotSecret: refuses a wrong secret");
}
{
  process.env.BIOS_BOT_API_SECRET = "correct-horse-battery-staple";
  assert.equal(config.requireBiosBotSecret(fakeReq({ "x-bios-bot-secret": "correct-horse-battery-staple" })), true,
    "exact match → accepted");
  ok("requireBiosBotSecret: accepts the exact configured secret");
}
{
  // a prefix of the real secret must not pass a naive substring/prefix check
  process.env.BIOS_BOT_API_SECRET = "correct-horse-battery-staple";
  assert.equal(config.requireBiosBotSecret(fakeReq({ "x-bios-bot-secret": "correct-horse" })), false,
    "a shorter prefix of the real secret is refused (length-checked before timingSafeEqual)");
  ok("requireBiosBotSecret: refuses a prefix of the real secret");
}

// ============================================================
// resolveBiosBotTenantId — never guesses, never falls back to another
// integration's tenant
// ============================================================
{
  delete process.env.BIOS_BOT_TENANT_ID;
  assert.equal(config.resolveBiosBotTenantId(), null, "unset → null, never a hardcoded/guessed tenant");
  ok("resolveBiosBotTenantId: null when unconfigured (no silent default)");
}
{
  process.env.BIOS_BOT_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  assert.equal(config.resolveBiosBotTenantId(), "11111111-1111-1111-1111-111111111111");
  ok("resolveBiosBotTenantId: returns the configured tenant id verbatim");
}

// ============================================================
// authenticateBiosBotRequest — the one gate every route calls first
// ============================================================
{
  process.env.BIOS_BOT_API_SECRET = "s3cr3t";
  process.env.BIOS_BOT_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  const r = guard.authenticateBiosBotRequest(fakeReq({ "x-bios-bot-secret": "s3cr3t" }));
  assert.equal(r.ok, true);
  assert.equal(r.ctx.tenantId, "11111111-1111-1111-1111-111111111111");
  ok("authenticateBiosBotRequest: correct secret + configured tenant → ok with the trusted tenant");
}
{
  process.env.BIOS_BOT_API_SECRET = "s3cr3t";
  process.env.BIOS_BOT_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  const r = guard.authenticateBiosBotRequest(fakeReq({ "x-bios-bot-secret": "nope" }));
  assert.equal(r.ok, false);
  assert.equal(r.response.status, 401);
  assert.equal(r.response.body.error.code, "AUTHENTICATION_ERROR");
  ok("authenticateBiosBotRequest: wrong secret → 401 AUTHENTICATION_ERROR, no tenant resolved");
}
{
  process.env.BIOS_BOT_API_SECRET = "s3cr3t";
  delete process.env.BIOS_BOT_TENANT_ID;
  const r = guard.authenticateBiosBotRequest(fakeReq({ "x-bios-bot-secret": "s3cr3t" }));
  assert.equal(r.ok, false);
  assert.equal(r.response.status, 503);
  assert.equal(r.response.body.error.code, "CONNECTOR_UNAVAILABLE");
  ok("authenticateBiosBotRequest: secret ok but no configured tenant → 503 CONNECTOR_UNAVAILABLE (not a silent default)");
}
{
  // the caller cannot escalate scope by sending its own tenantId/actor/role —
  // the fake request never carries one anywhere the function reads from, and
  // the resolved context comes ONLY from server env, never the request object
  const withSpoofedTenant = fakeReq({ "x-bios-bot-secret": "s3cr3t", "x-tenant-id": "attacker-supplied" });
  process.env.BIOS_BOT_API_SECRET = "s3cr3t";
  process.env.BIOS_BOT_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  const r = guard.authenticateBiosBotRequest(withSpoofedTenant);
  assert.equal(r.ok, true);
  assert.equal(r.ctx.tenantId, "11111111-1111-1111-1111-111111111111",
    "a caller-supplied x-tenant-id header is never read — the trusted server tenant wins unconditionally");
  ok("authenticateBiosBotRequest: a spoofed tenant header cannot change the resolved tenant");
}

// ============================================================
// middleware: the bypass is exact-namespace, not a wider match
// ============================================================
{
  const src = readFileSync(join(ROOT, "src/middleware.ts"), "utf8");
  assert.ok(/isBiosBotApi\s*=\s*path\.startsWith\("\/api\/bios-bot\/"\)/.test(src),
    "middleware defines isBiosBotApi scoped to exactly /api/bios-bot/");
  assert.ok(/!isBiosBotApi/.test(src), "the login-redirect condition actually excludes isBiosBotApi");
  ok("middleware: the BIOS Bot bypass is scoped to /api/bios-bot/ only, and is wired into the redirect gate");
}

delete process.env.BIOS_BOT_API_SECRET;
delete process.env.BIOS_BOT_TENANT_ID;
console.log(`\nALL ${n} BIOS-BOT-AUTH CHECKS PASSED`);
