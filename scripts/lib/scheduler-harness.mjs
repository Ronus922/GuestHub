// Shared harness for the D201 scheduling guards (check:relative-schedule,
// check:catch-up-window). It compiles the REAL triggers.ts / scheduler.ts /
// delivery.ts with tsc, points their `sql` at a transaction on a scratch
// database, and can produce MUTANT copies of the compiled code — each guard
// proves its assertions fail on every mutant (B2 refutation) and pass on the
// real code, on every run.
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function patch(path, pairs) {
  let text = readFileSync(path, "utf8");
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`harness: import "${from}" not found in ${path} — the compiled shape changed`);
    text = text.split(from).join(to);
  }
  writeFileSync(path, text);
}

/** Compile once; returns the output directory holding communications/*.js. */
export function compile(name) {
  const out = mkdtempSync(join(ROOT, `node_modules/.cache/${name}-`));
  writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
  const tsconfig = join(out, "tsconfig.json");
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      module: "esnext", target: "es2022", moduleResolution: "bundler", skipLibCheck: true,
      baseUrl: ROOT, paths: { "@/*": ["src/*"] }, rootDir: join(ROOT, "src/lib"), outDir: out,
    },
    files: [
      join(ROOT, "src/lib/communications/triggers.ts"),
      join(ROOT, "src/lib/communications/scheduler.ts"),
      join(ROOT, "src/lib/communications/delivery.ts"),
    ],
  }));
  execSync(`pnpm exec tsc --project ${tsconfig}`, { stdio: "inherit" });
  const c = (f) => join(out, "communications", f);
  patch(c("scheduler.js"), [['import "server-only";\n', ""], ['"@/lib/db"', '"./test-db.js"'], ['"./triggers"', '"./triggers.js"']]);
  patch(c("delivery.js"), [
    ['import "server-only";\n', ""], ['"@/lib/db"', '"./test-db.js"'],
    ['"@/lib/messaging/providers"', '"./test-stub.js"'], ['"@/lib/phone"', '"./test-stub.js"'],
    ['"@/lib/messaging/channel-failure-alert"', '"./test-stub.js"'],
  ]);
  // The compiled modules' `sql` delegates to whatever transaction the guard
  // installed — every scenario runs inside a transaction that is rolled back.
  writeFileSync(c("test-db.js"), `
let current = null;
export const setSql = (handle) => { current = handle; };
const proxy = (...args) => current(...args);
proxy.json = (value) => current.json(value);
proxy.begin = (callback) => callback(current);
export const sql = proxy;
`);
  writeFileSync(c("test-stub.js"), `
export const resolveEmailProvider = () => { throw new Error("not in this harness"); };
export const resolveWhatsAppProvider = () => { throw new Error("not in this harness"); };
export const normalizePhone = () => ({ valid: false, e164: "", digits: "" });
export const notifyChannelFailureStreak = async () => "below_threshold";
`);
  return out;
}

let variant = 0;
/**
 * A loadable copy of the compiled tree. `mutations` = [[file, from, to], …];
 * a mutation whose `from` is absent throws — a refutation that silently
 * applies nothing would "pass" by testing the real code.
 */
export async function load(out, mutations = []) {
  const dir = mutations.length ? `${out}-m${(variant += 1)}` : out;
  if (mutations.length) cpSync(out, dir, { recursive: true });
  for (const [file, from, to] of mutations) {
    const path = join(dir, "communications", file);
    const text = readFileSync(path, "utf8");
    if (!text.includes(from)) throw new Error(`mutation anchor not found in ${file}: ${from}`);
    writeFileSync(path, text.replace(from, to));
  }
  const mod = (f) => import(pathToFileURL(join(dir, "communications", f)).href);
  const [db, scheduler, triggers, delivery] = await Promise.all(
    ["test-db.js", "scheduler.js", "triggers.js", "delivery.js"].map(mod));
  return { db, scheduler, triggers, delivery };
}

class Rollback extends Error {}
/** Run `fn(tx)` inside a transaction that is always rolled back. */
export async function inRollback(sql, mods, fn) {
  let result;
  try {
    await sql.begin(async (tx) => {
      mods.db.setSql(tx);
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result;
}

/** Israel wall time → instant (fixtures are in July: IDT, UTC+3). */
export const israel = (ymd, hm) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - 3, mi));
};

export const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Tenant + one published-less WhatsApp template the automations can point at. */
export async function seedTenant(tx, slug) {
  const [tenant] = await tx`INSERT INTO guesthub.tenants (name, slug) VALUES (${slug}, ${slug}) RETURNING id`;
  const [template] = await tx`
    INSERT INTO guesthub.message_templates (tenant_id, channel, slug, name, body)
    VALUES (${tenant.id}, 'whatsapp', ${`${slug}-wa`}, 'guard', 'guard') RETURNING id`;
  return { tenantId: tenant.id, templateId: template.id };
}

export async function seedAutomation(tx, t, name, triggerType, timing) {
  const [row] = await tx`
    INSERT INTO guesthub.communication_automations
      (tenant_id, name, status, trigger_type, channel, template_id, timing_config)
    VALUES (${t.tenantId}, ${name}, 'active', ${triggerType}, 'whatsapp', ${t.templateId},
            ${tx.json({ mode: "scheduled", quietHours: "bypass", ...timing })})
    RETURNING id`;
  return row.id;
}

export async function seedReservation(tx, t, number, checkIn, checkOut, status) {
  const [row] = await tx`
    INSERT INTO guesthub.reservations (tenant_id, reservation_number, check_in, check_out, status)
    VALUES (${t.tenantId}, ${number}, ${checkIn}, ${checkOut}, ${status}) RETURNING id`;
  return row.id;
}

/** "automation-name/reservation-number → skipReason|send" for the tenant, sorted. */
export async function emitted(tx, t) {
  const rows = await tx`
    SELECT a.name, r.reservation_number, e.payload, e.occurrence_key
    FROM guesthub.communication_events e
    JOIN guesthub.communication_automations a ON a.id = (e.payload->>'automationId')::uuid
    JOIN guesthub.reservations r ON r.id = e.reservation_id
    WHERE e.tenant_id = ${t.tenantId}
    ORDER BY a.name, r.reservation_number, e.payload->>'anchorDate'`;
  // sorted in JS: database collation orders "A4-" / "A4b" differently per locale
  return rows.map((r) => ({
    line: `${r.name}/${r.reservation_number} → ${r.payload.skipReason ?? "send"} @${r.payload.anchorDate}`,
    payload: r.payload, key: r.occurrence_key,
  })).sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
}

/**
 * Run `scenario` against the real code (must yield no failures) and against
 * every mutant (each must yield at least one). Returns a process exit code.
 */
export async function proveWithRefutation(sql, out, scenario, mutants) {
  let exit = 0;
  const real = await scenario(await load(out));
  if (real.length) {
    exit = 1;
    console.log("✗ the real code fails:");
    for (const f of real) console.log(`    ${f}`);
  } else {
    console.log("✓ real code: every assertion holds");
  }
  for (const m of mutants) {
    const failures = await scenario(await load(out, m.mutations));
    if (failures.length) {
      console.log(`✓ mutant "${m.name}" is caught (${failures.length} failing assertion(s), first: ${failures[0].split("\n")[0]})`);
    } else {
      exit = 1;
      console.log(`✗ mutant "${m.name}" SURVIVED — the guard cannot see this defect`);
    }
  }
  await sql.end();
  return exit;
}
