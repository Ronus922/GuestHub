// ============================================================
// Channex credential-UI safety checks (D70) — the "Java2026" defect.
//
// ROOT CAUSE (proven, see the PR body): the card kept ONE `type="password"` input
// permanently mounted on /channels with `autocomplete="off"`. Chrome and Firefox
// deliberately ignore autocomplete="off" on password fields, so the browser's
// password manager filled its saved credential for this origin into it. The value
// never originated in GuestHub — but one click would have overwritten the real
// Channex api-key with it.
//
// These checks lock the fix in place. All static — no network, no DB, no browser.
// Usage: node scripts/check-channex-credential.mjs
// ============================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/var/www/guesthub";
const read = (f) => readFileSync(join(ROOT, f), "utf8");
// bans target CODE, not prose: a comment explaining the defect is not the defect
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

let n = 0;
const ok = (m) => { n++; console.log(`✓ ${n}. ${m}`); };

const CARD = "src/app/(dashboard)/channels/ChannexStagingSection.tsx";
const FORM = "src/app/(dashboard)/channels/ChannexKeyReplacementForm.tsx";
const ADMIN = "src/lib/channel/admin.ts";
const TEST = "src/lib/channel/connection-test.ts";

// ---- 1. "Java2026" exists nowhere in the application ----
{
  const skip = new Set(["node_modules", ".git", ".next", "dist", "out", "build"]);
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?|mjs|cjs|json|sql|css|md|sh)$/.test(e.name)) {
        // this file names the string to forbid it; skip itself
        if (p.endsWith("check-channex-credential.mjs")) continue;
        if (/java2026/i.test(readFileSync(join(ROOT, p), "utf8"))) hits.push(p);
      }
    }
  };
  for (const top of ["src", "scripts", "db", "public"]) if (existsSync(join(ROOT, top))) walk(top);
  assert.deepEqual(hits, [], `"Java2026" must not exist in application code (found in ${hits.join(", ")})`);
  ok('"Java2026" appears nowhere in application code, data, seeds or migrations');
}

// ---- 2. the replacement input is NOT mounted by default ----
{
  const card = code(CARD);
  assert.ok(!/<input/.test(card), "the connection card renders NO input at all");
  assert.ok(!card.includes("channex-key"), "the old permanently-mounted id is gone");
  // the field lives in a component the card mounts conditionally
  assert.ok(/\{!replacing \?/.test(card), "the replacement form is behind a conditional mount");
  assert.ok(/<ChannexKeyReplacementForm/.test(card), "and it is a separate component (unmount destroys its state)");
  assert.ok(/key=\{mountId\}/.test(card), "each open remounts a FRESH instance — no value can survive a reopen");
  ok("the replacement input does not exist in the DOM until an explicit click");
}

// ---- 3. the stored key is read-only TEXT, never an input value ----
{
  const card = code(CARD);
  assert.ok(card.includes("מפתח API מוגדר"), "the masked hint is rendered as text");
  assert.ok(!/value=\{.*apiKeyHint/.test(card), "the hint is never an input value");
  assert.ok(!/value="\*+"/.test(card) && !/defaultValue="\*+"/.test(card), 'no value="********" placeholder input');
  assert.ok(!/defaultValue/.test(card) && !/defaultValue/.test(code(FORM)), "no defaultValue anywhere");
  ok("the saved key is shown only as a read-only masked hint, never inside an editable input");
}

// ---- 4. the replacement field starts empty and is autofill-resistant ----
{
  const form = code(FORM);
  assert.ok(/useState\(""\)/.test(form), "the field's state initialises to an empty string");
  assert.ok(!/useEffect/.test(form), "no effect populates the field");
  assert.ok(!/props?\.(value|apiKey)/.test(form), "no prop seeds the field");

  const attrs = {
    'type="password"': /type="password"/,
    'autoComplete="new-password"': /autoComplete="new-password"/,
    "spellCheck={false}": /spellCheck=\{false\}/,
    'autoCapitalize="none"': /autoCapitalize="none"/,
    'autoCorrect="off"': /autoCorrect="off"/,
    "unique id": /id=\{FIELD_NAME\}/,
    "unique name": /name=\{FIELD_NAME\}/,
  };
  for (const [label, re] of Object.entries(attrs)) assert.ok(re.test(form), `replacement input has ${label}`);
  assert.ok(/FIELD_NAME = "channex-api-key-replacement-value"/.test(form), "the field name is unique and non-generic");

  for (const generic of ['name="password"', 'name="apiKey"', 'name="key"', 'name="secret"', 'name="credential"']) {
    assert.ok(!form.includes(generic), `the field is not named ${generic} (password-manager fill heuristic)`);
  }
  // the INPUT must not use autocomplete="off" — browsers ignore it on password
  // fields. (The <form> may carry it as a harmless extra signal.)
  const inputTag = form.slice(form.indexOf("<input"), form.indexOf("/>", form.indexOf("<input")));
  assert.ok(!/autoComplete="off"/.test(inputTag), 'the input does not rely on autocomplete="off"');
  assert.ok(/autoComplete="new-password"/.test(inputTag), "the input declares new-password");
  // vendor opt-outs cost nothing and stop 1Password/LastPass/Dashlane
  for (const optOut of ["data-1p-ignore", "data-lpignore", 'data-form-type="other"']) {
    assert.ok(inputTag.includes(optOut), `the input carries ${optOut}`);
  }
  ok("the replacement input starts empty, uses new-password + a unique non-generic name, and never relies on autocomplete=off");
}

// ---- 5. cancel / success clear the value and unmount ----
{
  const form = code(FORM);
  assert.ok(/function cancel\(\)[\s\S]{0,120}setValue\(""\)[\s\S]{0,120}onCancel\(\)/.test(form),
    "cancel clears the value and asks the parent to unmount");
  assert.ok(/setValue\(""\);\s*onSaved\(hint\)/.test(form),
    "a successful save clears the value before the parent unmounts the form");
  const card = code(CARD);
  assert.ok(/function closeReplace\(\)[\s\S]{0,80}setReplacing\(false\)/.test(card), "cancel unmounts");
  assert.ok(/function onSaved\([\s\S]{0,80}setReplacing\(false\)/.test(card), "success unmounts");
  assert.ok(!/apiKeyHint:\s*apiKey/.test(card), "the new secret is never re-rendered");
  ok("cancelling and saving both clear the state and unmount the input; the new secret is never rendered again");
}

// ---- 6. a browser-filled value can never be auto-submitted ----
{
  const form = code(FORM);
  assert.ok(/onSubmit=\{submit\}/.test(form), "saving happens only through an explicit submit handler");
  assert.ok(/e\.preventDefault\(\)/.test(form), "the submit never navigates");
  assert.ok(/disabled=\{disabled \|\| pending \|\| trimmed === ""\}/.test(form),
    "the save button is disabled while the field is empty");
  assert.ok(/if \(!trimmed \|\| pending\) return;/.test(form), "an empty/in-flight submit is refused server-side of the click too");
  // nothing auto-invokes the save
  assert.ok(!/useEffect[\s\S]{0,200}saveChannexApiKeyAction/.test(form), "no effect ever calls the save action");
  ok("an autofilled value is never submitted automatically — save requires an explicit click/submit");
}

// ---- 7. Test connection can ONLY use the stored key ----
{
  const admin = code(ADMIN);
  assert.ok(/export async function testChannexConnectionAction\(\):/.test(admin),
    "testChannexConnectionAction takes ZERO parameters — no form value can reach it");
  assert.ok(/async function probeStoredChannexKey\(tenantId: string\)/.test(admin),
    "the probe takes only a tenant id");
  assert.ok(/loadChannexRow\(tenantId\)[\s\S]{0,400}decryptSecret\(row\.api_key_ciphertext\)/.test(admin),
    "the probe decrypts the STORED ciphertext");
  // the client calls it with no arguments
  const card = code(CARD);
  assert.ok(/testChannexConnectionAction\(\)/.test(card), "the UI calls it with no arguments");
  assert.ok(!/testChannexConnectionAction\([^)]/.test(card), "the UI never passes anything to it");
  // the card cannot even see the replacement value: it lives in the child component
  assert.ok(!/saveChannexApiKeyAction/.test(card), "the card cannot submit a credential at all");
  ok("Test connection reads only the stored encrypted key; unsaved input has no path into it");
}

// ---- 8. verify-before-persist: a working key can never be clobbered ----
{
  const admin = code(ADMIN);
  const save = admin.slice(admin.indexOf("export async function saveChannexApiKeyAction"));
  const probeAt = save.indexOf("runChannexConnectionTest(");
  const writeAt = save.indexOf("INSERT INTO guesthub.channel_connections");
  assert.ok(probeAt > -1 && writeAt > -1 && probeAt < writeAt,
    "the candidate key is authenticated BEFORE any database write");
  assert.ok(/if \(!probe\.ok\)[\s\S]{0,400}return \{ success: false/.test(save),
    "a rejected/unverifiable candidate is never persisted");
  assert.ok(/המפתח הקיים נשמר ללא שינוי/.test(save), "and the operator is told the existing key was preserved");
  ok("a candidate key is verified against Channex before it is stored — a working key cannot be overwritten");
}

// ---- 9. Full Sync refuses to start on a credential that cannot authenticate ----
{
  const admin = code(ADMIN);
  const req = admin.slice(admin.indexOf("export async function requestFullSyncAction"));
  const probeAt = req.indexOf("probeStoredChannexKey");
  const enqueueAt = req.indexOf("enqueueChannelJob");
  assert.ok(probeAt > -1 && enqueueAt > -1 && probeAt < enqueueAt,
    "the stored key is probed BEFORE the job row is created — a failed auth creates no run");

  // scope to runInitialFullSync's body — helper DEFINITIONS appear earlier in the file
  const syncSrc = code("src/lib/channel/ari-sync.ts");
  const body = syncSrc.slice(syncSrc.indexOf("export async function runInitialFullSync"));
  const authAt = body.indexOf("runChannexConnectionTest(");
  const projectAt = body.indexOf("await projectAri(");
  const pushAt = body.indexOf("await sendBatches(");
  assert.ok(authAt > -1, "runInitialFullSync authenticates the stored key");
  assert.ok(authAt < projectAt, "…before it projects anything");
  assert.ok(authAt < pushAt, "…and before it sends any ARI request");
  ok("Full Sync fails fast on bad credentials: no run, no projection, no ARI request");
}

// ---- 10. no secret ever reaches a DTO, a message, an audit or a log ----
{
  const admin = read(ADMIN);
  const view = admin.slice(admin.indexOf("export type ChannexConnectionView"), admin.indexOf("};", admin.indexOf("export type ChannexConnectionView")));
  for (const banned of ["apiKey:", "api_key_ciphertext", "ciphertext", "plaintext"]) {
    assert.ok(!view.includes(banned), `ChannexConnectionView exposes no ${banned}`);
  }
  assert.ok(view.includes("apiKeyHint"), "only the masked hint is exposed");

  // every failure message is a FIXED string keyed by category — never upstream text
  const test = read(TEST);
  assert.ok(/const CATEGORY_MESSAGE: Record<ChannexErrorCategory, string>/.test(test),
    "connection-test messages are fixed strings keyed by category");
  for (const cat of ["unauthorized", "forbidden", "not_found", "rate_limited", "server_error", "timeout", "network_error", "bad_response"]) {
    assert.ok(new RegExp(`${cat}:`).test(test), `category ${cat} has a visible, safe message`);
  }
  assert.ok(!/`\$\{.*apiKey/.test(test) && !/apiKey.*message/.test(test), "the api-key never enters a message");

  // audits carry categories/booleans only
  assert.ok(/action: "channex_credential_rejected"[\s\S]{0,240}category: probe\.category/.test(code(ADMIN)),
    "a rejected credential audits the CATEGORY, never the value");
  assert.ok(!/after: \{[^}]*apiKey/.test(code(ADMIN)), "no audit payload contains the key");
  ok("no key, ciphertext or upstream body appears in any DTO, message, audit or error");
}

// ---- 11. every error category is surfaced to the operator ----
{
  const card = code(CARD);
  assert.ok(/res\.data!\.message/.test(card) || /res\.data\?\.message/.test(card), "the test result message is displayed");
  assert.ok(/setMsg\(\{ tone: "err"/.test(card), "failures render in an error tone");
  assert.ok(/role="alert"/.test(card), "the persistent failure message is announced to assistive tech");
  assert.ok(/role="alert"/.test(code(FORM)), "the replacement form's error is announced too");
  ok("401 / 403 / timeout / network / malformed / missing-key all surface visibly — no swallowed errors");
}

console.log(`\ncheck-channex-credential: all ${n} assertions passed`);
