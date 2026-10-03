// Shared harness for guards that must RUN real Server Actions against a
// database (D202: check:manual-send-version, check:template-restore).
//
// It compiles the real TypeScript entries with tsc into node_modules/.cache,
// and registers an ESM loader that resolves the "@/…" alias inside the
// compiled tree. Only the edges are stubbed — the database handle (pointed at a
// transaction that is always rolled back), the actor, the audit writer, Next's
// cache, the messaging providers (a fake that records what would go on the
// wire) and the canonical reservation load. Everything between them is the
// real code.
//
// Mutants: variant(out, mutations) copies the compiled tree and applies text
// replacements to the COMPILED JavaScript; a replacement whose `from` is absent
// throws, so a refutation can never silently test nothing.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const ROOT = process.cwd();
console.log(`# tree under test: ${ROOT}`);

export function connect() {
  const url = process.env.TEST_DATABASE_URL
    || "postgres://supabase_admin:guesthub_test_local@localhost:5433/postgres";
  for (const marker of ["bios-vps", ":5432/", "guesthub.bios.co.il", "db.bios.co.il"]) {
    if (url.includes(marker)) throw new Error(`refusing production-like database marker: ${marker}`);
  }
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

// Compiled files replaced by the stub module, by their path inside dist/.
const STUB_FILES = [
  "lib/messaging/providers.js",
  "lib/messaging/channel-failure-alert.js",
  "app/(dashboard)/reservations/actions.js",
];
const STUB_SPECIFIERS = ["@/lib/db", "@/lib/auth/actor", "@/lib/audit", "next/cache", "server-only"];

const STUBS = `
let current = null;
export const setSql = (handle) => { current = handle; };
const proxy = (...args) => current(...args);
proxy.json = (value) => current.json(value);
proxy.begin = (...args) => args[args.length - 1](current);
export const sql = proxy;
// the real withReadOnlyScope opens its OWN connection, which cannot see a rolled-back
// seed — guards run the scope's body on the seed transaction and prove the real
// read-only scope separately against lib/db itself (check:automation-preview)
export const withReadOnlyScope = (fn) => fn();

let actor = null;
export const setActor = (value) => { actor = value; };
export class AuthorizationError extends Error {}
export const getActor = async () => actor;
export const requirePermission = () => {};
export const hasPermission = () => true;
export const writeAudit = async () => {};
export const revalidatePath = () => {};
export const revalidateTag = () => {};
export const unstable_cache = (fn) => fn;

// what reached the (fake) providers, in order
export const wire = [];
export const resolveEmailProvider = async () => ({
  id: "gmail",
  sendEmail: async (msg) => { wire.push({ channel: "email", ...msg }); return { status: "sent", providerMessageId: "fake" }; },
});
export const resolveWhatsAppProvider = async () => ({
  id: "green_api",
  provider: { sendMessage: async (msg) => { wire.push({ channel: "whatsapp", ...msg }); return { status: "sent", providerMessageId: "fake" }; } },
});
export const notifyChannelFailureStreak = async () => "below_threshold";

// the canonical booking load (reservations/actions.ts) — a fixture the guard sets
let reservation = null;
export const setReservation = (value) => { reservation = value; };
export const getReservationAction = async () => (reservation ? { success: true, data: reservation } : { success: false, error: "not found" });
export default {};
`;

const LOADER = `
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
let OUT, STUB, STUB_FILES, STUB_SPECIFIERS;
export async function initialize(data) {
  OUT = data.out; STUB = pathToFileURL(data.out + "/stubs.mjs").href;
  STUB_FILES = data.stubFiles; STUB_SPECIFIERS = data.stubSpecifiers;
}
const distRoot = (url) => {
  if (!url || !url.startsWith("file:")) return null;
  const path = fileURLToPath(url);
  if (!path.startsWith(OUT + "/")) return null;
  const i = path.indexOf("/dist/");
  return i < 0 ? null : path.slice(0, i + 6);
};
function asFile(base, root) {
  for (const candidate of [base + ".js", base + "/index.js", base]) {
    if (candidate.endsWith(".js") && existsSync(candidate)) {
      return STUB_FILES.includes(candidate.slice(root.length)) ? STUB : pathToFileURL(candidate).href;
    }
  }
  return null;
}
export async function resolve(specifier, context, next) {
  const root = distRoot(context.parentURL);
  if (root && STUB_SPECIFIERS.includes(specifier)) return { url: STUB, shortCircuit: true };
  if (root && specifier.startsWith("@/")) {
    const url = asFile(root + specifier.slice(2), root);
    if (url) return { url, shortCircuit: true };
  }
  if (root && specifier.startsWith(".")) {
    const url = asFile(fileURLToPath(new URL(specifier, context.parentURL)), root);
    if (url) return { url, shortCircuit: true };
  }
  // bare packages resolve from the repo, not from the cache directory
  return next(specifier, root ? { ...context, parentURL: pathToFileURL(process.cwd() + "/package.json").href } : context);
}
`;

let registered = false;

/** Compile the real entries once; returns the cache directory holding dist/. */
export function compile(name, entries) {
  const out = mkdtempSync(join(ROOT, `node_modules/.cache/${name}-`));
  const tsconfig = join(out, "tsconfig.json");
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      module: "esnext", target: "es2022", moduleResolution: "bundler", skipLibCheck: true,
      jsx: "react-jsx", baseUrl: ROOT, paths: { "@/*": ["src/*"] },
      rootDir: join(ROOT, "src"), outDir: join(out, "dist"), noEmitOnError: false,
    },
    files: entries.map((entry) => join(ROOT, entry)),
  }));
  // type errors are typecheck's job; tsc still emits, and a missing file fails below
  try { execSync(`pnpm exec tsc --project ${tsconfig}`, { stdio: "pipe" }); } catch { /* emitted anyway */ }
  for (const entry of entries) {
    const js = join(out, "dist", entry.replace(/^src\//, "").replace(/\.tsx?$/, ".js"));
    if (!existsSync(js)) throw new Error(`harness: ${entry} did not compile`);
  }
  writeFileSync(join(out, "dist", "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(out, "stubs.mjs"), STUBS);
  writeFileSync(join(out, "loader.mjs"), LOADER);
  if (!registered) {
    register(pathToFileURL(join(out, "loader.mjs")).href, {
      data: { out, stubFiles: STUB_FILES, stubSpecifiers: STUB_SPECIFIERS },
    });
    registered = true;
  }
  return out;
}

let variantCount = 0;
/**
 * A loadable copy of the compiled tree. `mutations` = [[distPath, from, to], …]
 * (every occurrence is replaced). Returns `load(relPath)` → the module.
 */
export async function variant(out, mutations = []) {
  let dist = join(out, "dist");
  if (mutations.length) {
    const copy = join(out, `v${++variantCount}`, "dist");
    cpSync(dist, copy, { recursive: true });
    for (const [file, from, to] of mutations) {
      const path = join(copy, file);
      const text = readFileSync(path, "utf8");
      if (!text.includes(from)) throw new Error(`harness: mutation text not found in ${file}: ${from.slice(0, 80)}`);
      writeFileSync(path, text.split(from).join(to));
    }
    dist = copy;
  }
  return (rel) => import(pathToFileURL(join(dist, rel)).href);
}

export const stubs = (out) => import(pathToFileURL(join(out, "stubs.mjs")).href);

const ROLLBACK = new Error("harness: rollback");
/** Run `fn(tx)` in a transaction that is always rolled back; returns fn's value. */
export async function inRollback(sql, stub, fn) {
  let result;
  try {
    await sql.begin(async (tx) => {
      stub.setSql(tx);
      result = await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  return result;
}

/** A tenant with one operator; the actor is set to that operator. */
export async function seedTenant(tx, stub, label) {
  const [tenant] = await tx`
    INSERT INTO guesthub.tenants (name, slug) VALUES (${label}, ${`${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`})
    RETURNING id`;
  const [user] = await tx`
    INSERT INTO guesthub.users (tenant_id, username) VALUES (${tenant.id}, ${`op-${tenant.id.slice(0, 8)}`}) RETURNING id`;
  stub.setActor({ tenantId: tenant.id, userId: user.id, tenantName: label });
  return { tenantId: tenant.id, userId: user.id };
}

/**
 * Run `scenario(load, stub)` on the real code (must return []), then on every
 * mutant (each must return ≥1 failure). Returns the exit code.
 */
export async function proveWithRefutation(out, scenario, mutants) {
  const stub = await stubs(out);
  const real = await scenario(await variant(out), stub);
  let failed = false;
  if (real.length) {
    failed = true;
    console.log(`✗ the real code fails ${real.length} assertion(s):`);
    for (const message of real) console.log(`  ✗ ${message}`);
  } else {
    console.log("✓ the real code passes every assertion");
  }
  for (const mutant of mutants) {
    const caught = await scenario(await variant(out, mutant.mutations), stub);
    if (caught.length) {
      console.log(`✓ mutant "${mutant.name}" is caught (${caught.length} failing assertion(s), e.g. ${caught[0].split("\n")[0]})`);
    } else {
      failed = true;
      console.log(`✗ mutant "${mutant.name}" SURVIVES — the assertions do not detect it`);
    }
  }
  return failed ? 1 : 0;
}
