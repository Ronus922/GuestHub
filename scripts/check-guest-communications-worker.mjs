import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = mkdtempSync(join(process.cwd(), "node_modules/.cache/check-guest-communications-worker-"));
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
const tsconfig = join(out, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    module: "esnext",
    target: "es2022",
    moduleResolution: "bundler",
    skipLibCheck: true,
    baseUrl: process.cwd(),
    paths: { "@/*": ["src/*"] },
    rootDir: join(process.cwd(), "src/lib"),
    outDir: out,
  },
  files: [
    join(process.cwd(), "src/lib/communications/delivery.ts"),
    join(process.cwd(), "src/lib/messaging/types.ts"),
  ],
}));
execSync(
  `pnpm exec tsc --project ${tsconfig}`,
  { stdio: "inherit" },
);

const deliveryPath = join(out, "communications/delivery.js");
let deliverySource = readFileSync(deliveryPath, "utf8")
  .replace('import "server-only";\n', "")
  .replace('"@/lib/db"', '"./test-db.js"')
  .replace('"@/lib/messaging/providers"', '"./test-provider.js"')
  .replace('"@/lib/messaging/types"', '"../messaging/types.js"');
writeFileSync(deliveryPath, deliverySource);
writeFileSync(join(out, "communications/test-db.js"), `
export const calls = [];
const tag = async (strings, ...values) => {
  const text = strings.reduce((all, part, index) => all + part + (index < values.length ? "$" + (index + 1) : ""), "");
  calls.push({ text, values });
  if (text.includes("SELECT COALESCE((retry_policy")) return [{ base: 30, cap: 120 }];
  return [];
};
tag.json = (value) => value;
tag.begin = async (callback) => callback(tag);
export const sql = tag;
export const clearCalls = () => { calls.length = 0; };
`);
writeFileSync(join(out, "communications/test-provider.js"), `
let current = null;
export const setProvider = (value) => { current = value; };
export const resolveEmailProvider = async () => current;
`);

const delivery = await import(deliveryPath);
const db = await import(join(out, "communications/test-db.js"));
const providers = await import(join(out, "communications/test-provider.js"));

let checks = 0;
const ok = (name) => { process.stdout.write(`  ✓ ${name}\n`); checks += 1; };
const base = {
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  to_address: "guest@example.test",
  subject: "אישור",
  rendered_html: "<p>אישור</p>",
  rendered_plain_text: "אישור",
  rendered_sender_name: "GuestHub",
  rendered_reply_to: "reply@example.test",
  attempt_count: 1,
  max_attempts: 3,
};

assert.deepEqual(delivery.classifyEmailFailure({ status: "failed", providerMessageId: null, errorCode: "gmail_429" }), { category: "provider_rate_limit", permanent: false });
assert.deepEqual(delivery.classifyEmailFailure({ status: "failed", providerMessageId: null, errorCode: "gmail_401" }), { category: "provider_authentication", permanent: true });
assert.deepEqual(delivery.classifyEmailFailure({ status: "failed", providerMessageId: null, errorCode: "network_timeout" }), { category: "provider_transient", permanent: false });
ok("provider failures classify into transient, rate-limit, and permanent categories");

providers.setProvider({ id: "gmail", sendEmail: async () => { throw new Error("provider must not be reached"); } });
db.clearCalls();
assert.equal(await delivery.deliverClaimedEmail({ ...base, to_address: "missing-at-sign" }, "worker-a"), "failed");
assert.equal(db.calls.some((call) => call.values.includes("invalid_recipient")), true);
ok("invalid recipients fail permanently without invoking a provider");

db.clearCalls();
assert.equal(await delivery.deliverClaimedEmail({ ...base, rendered_html: null }, "worker-a"), "failed");
assert.equal(db.calls.some((call) => call.values.includes("invalid_render_snapshot")), true);
ok("incomplete render snapshots fail permanently before provider submission");

let sentPayload;
providers.setProvider({
  id: "gmail",
  sendEmail: async (message) => {
    sentPayload = message;
    return { status: "sent", providerMessageId: "provider-1", providerThreadId: "thread-1" };
  },
});
db.clearCalls();
assert.equal(await delivery.deliverClaimedEmail(base, "worker-a"), "sent");
assert.deepEqual(sentPayload, {
  to: "guest@example.test",
  subject: "אישור",
  fromName: "GuestHub",
  body: "אישור",
  html: "<p>אישור</p>",
  replyTo: "reply@example.test",
});
assert.equal(db.calls.some((call) => call.values.includes("provider-1")), true);
ok("mocked provider receives the immutable multipart snapshot and marks the same delivery sent");

providers.setProvider({ id: "gmail", sendEmail: async () => ({ status: "failed", providerMessageId: null, errorCode: "gmail_503", errorDetail: "temporary" }) });
db.clearCalls();
assert.equal(await delivery.deliverClaimedEmail(base, "worker-a"), "retried");
assert.equal(db.calls.some((call) => call.values.includes(base.id)), true);
assert.equal(db.calls.some((call) => call.values.includes("provider_transient")), true);
assert.equal(db.calls.some((call) => call.values.includes("queued")), true);
ok("transient failure schedules a retry on the same delivery row");

providers.setProvider({ id: "gmail", sendEmail: async () => ({ status: "failed", providerMessageId: null, errorCode: "gmail_403", errorDetail: "denied" }) });
db.clearCalls();
assert.equal(await delivery.deliverClaimedEmail(base, "worker-a"), "failed");
assert.equal(db.calls.some((call) => call.values.includes("provider_authentication")), true);
assert.equal(db.calls.some((call) => call.values.includes("failed")), true);
ok("permanent provider failure reaches a final state without a retry");

providers.setProvider(null);
db.clearCalls();
assert.equal(await delivery.deliverClaimedEmail(base, "worker-a"), "failed");
assert.equal(db.calls.some((call) => call.values.includes("provider_not_configured")), true);
ok("missing provider configuration fails explicitly and permanently");

process.stdout.write(`\n✓ Guest Communications mocked-worker checks passed (${checks} groups)\n`);
