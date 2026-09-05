#!/usr/bin/env node
// ============================================================
// check:channel-health — the outbound-channel health rule (D173): the
// dashboard's "ערוצי שליחה" card and the once-per-streak owner email both read
// outbound_messages through ONE pure verdict, never the connection-test row.
//
// WHY THIS GUARD EXISTS. messaging_provider_connections.status said "connected"
// (tested 2026-07-30) while every WhatsApp send from 2026-09-02 failed
// green_400 ("Instance account is expired") — nine rows in three days, an
// automation stream and the owner's own manual send — and no surface went red.
// The defect was found by hand, three days late. This is the guard for the
// surface that would have caught it.
//
// THE STANDARD (B2). The scenario suite runs TWICE: against the real compiled
// module, which must pass, and against a MUTANT compiled from the same source
// with the classifier neutralised (every row counts as a success) while every
// export, type and constant stays intact. The mutant run MUST throw.
//
// No database, no network: the rule is a pure module so its verdict can be
// asserted directly (§B). The query and the two write-path hooks are covered
// by static assertions on the sources that hold them (§A/§C).
//
// Usage: node scripts/check-channel-health.mjs
// ============================================================
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from THIS FILE's location — a guard tests the tree it lives in (D100).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

// ============================================================
// A. the rule is pure, and the query feeds it what it needs
// ============================================================
{
  const rule = codeOf(src("src/lib/messaging/channel-health.ts"));
  assert.doesNotMatch(rule, /^\s*import\b/m, "channel-health.ts imports nothing — it must stay compilable and assertable without a DB");
  assert.doesNotMatch(rule, /Date\.now\(\)|new Date\(/, "the rule takes nowMs from its caller — no clock of its own");
  assert.match(rule, /export const IDLE_DAYS = 7;/, "grey after 7 days without a counted send (owner's spec)");
  assert.match(rule, /export const ALERT_THRESHOLD = 3;/, "the owner is mailed at 3 consecutive provider failures (owner's spec)");
  ok("the rule is pure: no imports, no clock; IDLE_DAYS=7, ALERT_THRESHOLD=3");

  const db = codeOf(src("src/lib/messaging/channel-health-db.ts"));
  assert.match(db, /COALESCE\(submitted_at, updated_at\)\) \* 1000\)::float8 AS at_ms/, "the send moment is COALESCE(submitted_at, updated_at) — a worker row is created when queued and may fail an hour later");
  assert.match(db, /ORDER BY COALESCE\(submitted_at, updated_at\) DESC/, "newest send first");
  assert.match(db, /extract\(epoch FROM now\(\)\) \* 1000\)::float8 AS now_ms/, "now comes from the DATABASE clock, the one that wrote the stamps");
  assert.match(db, /status IN \('submitted', 'sent', 'delivered', 'read', 'failed'\)/, "only rows that reached the provider are loaded");
  assert.doesNotMatch(db, /messaging_provider_connections|last_tested_at/, "the health query never reads the connection-test row — that row is the bug this replaces");
  ok("the one query: send-moment ordering, DB clock, provider-reaching statuses only, no test row");
}

// ============================================================
// B. the verdict — compile the real module and exercise it
// ============================================================
function compile(tsSource, label) {
  const tmp = mkdtempSync(join(tmpdir(), `channel-health-${label}-`));
  const entry = join(tmp, "channel-health.ts");
  writeFileSync(entry, tsSource);
  writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "commonjs", moduleResolution: "node10", target: "es2022", lib: ["es2023"],
      types: [], esModuleInterop: true, skipLibCheck: true, strict: true, noEmitOnError: true,
      rootDir: tmp, outDir: join(tmp, "out"),
    },
    include: [entry],
  }));
  execSync(`npx tsc --project ${join(tmp, "tsconfig.json")}`, { cwd: ROOT, stdio: "inherit" });
  return createRequire(join(ROOT, "package.json"))(join(tmp, "out", "channel-health.js"));
}

const REAL_SRC = src("src/lib/messaging/channel-health.ts");
console.log("compiling channel-health.ts via tsc…");
const M = compile(REAL_SRC, "real");

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const row = (id, status, atMs, extra = {}) =>
  ({ id, status, errorCode: null, finalErrorCategory: null, provider: "green_api", atMs, ...extra });
const okRow = (id, atMs) => row(id, "submitted", atMs);
const green400 = (id, atMs, category = "provider_unknown") => row(id, "failed", atMs, { errorCode: "green_400", finalErrorCategory: category });

function suite(m) {
  // 1. nothing ever sent
  {
    const v = m.channelHealth("whatsapp", [], NOW);
    assert.equal(v.tone, "idle");
    assert.equal(v.lastAtMs, null);
    assert.equal(v.lastAgo, null);
    assert.equal(v.consecutiveFailures, 0);
    assert.equal(v.streakKey, "none");
    assert.equal(v.channel, "whatsapp");
  }
  // 2. the last send succeeded
  {
    const v = m.channelHealth("email", [okRow("s1", NOW - HOUR)], NOW);
    assert.equal(v.tone, "ok");
    assert.equal(v.lastAgo, "לפני שעה");
    assert.equal(v.consecutiveFailures, 0);
    assert.equal(v.errorCode, null);
    assert.equal(v.errorLabel, null);
    assert.equal(v.streakKey, "s1");
    assert.equal(v.provider, "green_api");
  }
  // 3. three provider failures after a success — red, 3, the code in Hebrew, keyed on the success
  {
    const v = m.channelHealth("whatsapp", [
      green400("f3", NOW - 1 * MIN), green400("f2", NOW - 2 * MIN), green400("f1", NOW - 3 * MIN), okRow("s1", NOW - 4 * MIN),
    ], NOW);
    assert.equal(v.tone, "failed");
    assert.equal(v.consecutiveFailures, 3);
    assert.equal(v.errorCode, "green_400");
    assert.match(v.errorLabel, /GREEN-API/);
    assert.match(v.errorLabel, /400/);
    assert.match(v.errorLabel, /מנוי/);
    assert.equal(v.streakKey, "s1");
    assert.equal(v.lastAtMs, NOW - 1 * MIN);
    assert.equal(v.lastAgo, "לפני דקה");
    assert.ok(v.consecutiveFailures >= m.ALERT_THRESHOLD, "this streak alerts");
  }
  // 4. two failures — red, but below the alert threshold
  {
    const v = m.channelHealth("whatsapp", [green400("f2", NOW - MIN), green400("f1", NOW - 2 * MIN), okRow("s1", NOW - 3 * MIN)], NOW);
    assert.equal(v.tone, "failed");
    assert.equal(v.consecutiveFailures, 2);
    assert.ok(v.consecutiveFailures < m.ALERT_THRESHOLD, "two do not alert");
  }
  // 5. recipient-side and in-flight rows are IGNORED: they neither break nor lengthen the streak
  {
    const v = m.channelHealth("whatsapp", [
      green400("f2", NOW - 1 * MIN),
      row("u1", "undelivered", NOW - 2 * MIN),                                                        // number has no WhatsApp
      row("r1", "failed", NOW - 3 * MIN, { errorCode: "invalid_recipient", finalErrorCategory: "invalid_recipient" }),
      row("v1", "validation_failed", NOW - 4 * MIN),
      row("k1", "skipped", NOW - 5 * MIN, { errorCode: "source_filtered", finalErrorCategory: "source_filtered" }),
      row("q1", "queued", NOW - 5.5 * MIN),
      row("a1", "failed", NOW - 6 * MIN, { errorCode: "ambiguous_provider_outcome", finalErrorCategory: "ambiguous_provider_outcome" }),
      green400("f1", NOW - 7 * MIN),
      okRow("s1", NOW - 8 * MIN),
    ], NOW);
    assert.equal(v.tone, "failed");
    assert.equal(v.consecutiveFailures, 2, "only the two provider failures count");
    assert.equal(v.streakKey, "s1");
    // and a recipient failure as the NEWEST row does not paint the channel red
    const v2 = m.channelHealth("whatsapp", [
      row("r2", "failed", NOW - MIN, { errorCode: "invalid_recipient", finalErrorCategory: "invalid_recipient" }),
      okRow("s2", NOW - 2 * MIN),
    ], NOW);
    assert.equal(v2.tone, "ok", "a bad guest phone is not a channel failure");
  }
  // 6. the 7-day idle boundary, from both sides, whatever the last row was
  {
    const at7 = NOW - 7 * DAY;
    assert.equal(m.channelHealth("email", [green400("f", at7)], NOW).tone, "failed", "exactly 7 days is still live");
    const idle = m.channelHealth("email", [green400("f", at7 - 1)], NOW);
    assert.equal(idle.tone, "idle", "7 days + 1 ms is idle");
    assert.equal(idle.consecutiveFailures, 0, "an idle channel carries no streak count");
    assert.equal(idle.errorLabel, null);
    assert.equal(idle.lastAgo, "לפני 7 ימים");
    assert.equal(m.channelHealth("email", [okRow("s", NOW - 8 * DAY)], NOW).tone, "idle", "an old success is idle too");
    assert.equal(m.channelHealth("email", [okRow("s", NOW - 6 * DAY)], NOW).tone, "ok");
  }
  // 7. order of input does not matter — the rule sorts by send moment
  {
    const rows = [okRow("s1", NOW - 4 * MIN), green400("f1", NOW - 3 * MIN), green400("f2", NOW - 2 * MIN), green400("f3", NOW - MIN)];
    const a = m.channelHealth("whatsapp", rows, NOW);
    const b = m.channelHealth("whatsapp", [...rows].reverse(), NOW);
    assert.deepEqual(a, b);
    assert.equal(a.consecutiveFailures, 3);
    // created_at order would have put a late-landing worker failure BEFORE a newer success; send moment does not
    const c = m.channelHealth("whatsapp", [okRow("s9", NOW - 30 * MIN), green400("f9", NOW - 10 * MIN)], NOW);
    assert.equal(c.tone, "failed");
  }
  // 8. no success in the window — the streak is keyed 'none'
  {
    const v = m.channelHealth("whatsapp", [green400("f4", NOW - MIN), green400("f3", NOW - 2 * MIN), green400("f2", NOW - 3 * MIN), green400("f1", NOW - 4 * MIN)], NOW);
    assert.equal(v.streakKey, "none");
    assert.equal(v.consecutiveFailures, 4);
  }
  // 9. classifyRow — the worker's categories and the adapters' codes
  {
    const c = (status, errorCode, finalErrorCategory) => m.classifyRow(row("x", status, NOW, { errorCode, finalErrorCategory }));
    assert.equal(c("submitted", null, null), "success");
    assert.equal(c("sent", null, null), "success");
    assert.equal(c("delivered", null, null), "success");
    assert.equal(c("read", null, null), "success");
    assert.equal(c("failed", "green_400", "provider_unknown"), "failure");
    assert.equal(c("failed", "green_400", null), "failure", "a manual row has no category — the code decides");
    assert.equal(c("failed", "gmail_401", null), "failure");
    assert.equal(c("failed", "gmail_token_invalid_grant", "provider_authentication"), "failure");
    assert.equal(c("failed", "twilio_20003", "provider_authentication"), "failure");
    assert.equal(c("failed", "green_network", "provider_transient"), "failure");
    assert.equal(c("failed", "provider_exception", "provider_transient"), "failure", "a thrown adapter is the channel's fault");
    assert.equal(c("failed", "provider_not_configured", "provider_not_configured"), "failure", "a disconnected channel with queued sends IS failing");
    assert.equal(c("failed", "provider_configuration_invalid", "provider_configuration_invalid"), "failure");
    assert.equal(c("failed", "some_new_code", "provider_rate_limit"), "failure", "the worker's provider_* category counts even for an unknown code");
    assert.equal(c("failed", "invalid_recipient", "invalid_recipient"), "ignore");
    assert.equal(c("failed", "invalid_render_snapshot", "invalid_render_snapshot"), "ignore");
    assert.equal(c("failed", "ambiguous_provider_outcome", "ambiguous_provider_outcome"), "ignore");
    assert.equal(c("failed", null, null), "ignore", "a failure with no cause is not attributed to the channel");
    assert.equal(c("undelivered", null, null), "ignore");
    assert.equal(c("validation_failed", null, null), "ignore");
    assert.equal(c("cancelled", "reservation_no_longer_eligible", "reservation_no_longer_eligible"), "ignore");
    assert.equal(c("skipped", "source_filtered", "source_filtered"), "ignore");
    assert.equal(c("queued", null, null), "ignore");
    assert.equal(c("submitting", null, null), "ignore");
  }
  // 10. the Hebrew labels — every code says its own thing, an unknown code is shown as itself
  {
    const L = m.errorCodeLabel;
    assert.match(L("green_400"), /400/);
    assert.match(L("green_401"), /אימות/);
    assert.match(L("green_403"), /אימות/);
    assert.match(L("green_429"), /קצב/);
    assert.match(L("green_466"), /מכסה|מכסת/);
    assert.match(L("green_503"), /שרתי GREEN-API/);
    assert.match(L("green_network"), /רשת/);
    assert.match(L("gmail_401"), /Gmail/);
    assert.match(L("gmail_429"), /Gmail/);
    assert.match(L("gmail_token_invalid_grant"), /מחדש/);
    assert.match(L("gmail_token_no_access"), /Gmail/);
    assert.match(L("twilio_20003"), /Twilio/);
    assert.match(L("twilio_network"), /Twilio/);
    assert.match(L("provider_exception"), /לא הגיב/);
    assert.match(L("provider_not_configured"), /מחובר/);
    assert.match(L("some_unknown_code"), /some_unknown_code/);
    assert.notEqual(L(null), "");
    assert.equal(new Set(["green_400", "green_401", "green_429", "green_503", "green_network", "gmail_401", "twilio_20003"].map(L)).size, 7, "distinct labels");
  }
  // 11. relative time, coarse and Hebrew
  {
    const R = m.relativeHebrew;
    assert.equal(R(0), "לפני רגע");
    assert.equal(R(5 * MIN), "לפני 5 דקות");
    assert.equal(R(HOUR), "לפני שעה");
    assert.equal(R(2 * HOUR), "לפני שעתיים");
    assert.equal(R(5 * HOUR), "לפני 5 שעות");
    assert.equal(R(26 * HOUR), "אתמול");
    assert.equal(R(3 * DAY), "לפני 3 ימים");
    assert.equal(R(-1000), "לפני רגע", "clock skew never yields a negative age");
  }
  // 12. constants and the deep link the red row opens
  {
    assert.equal(m.IDLE_DAYS, 7);
    assert.equal(m.ALERT_THRESHOLD, 3);
    assert.equal(m.settingsHref("email"), "/settings?section=messaging#gmail");
    assert.equal(m.settingsHref("whatsapp"), "/settings?section=messaging#whatsapp");
    assert.equal(m.CHANNEL_LABEL.email, "מייל");
    assert.equal(m.CHANNEL_LABEL.whatsapp, "WhatsApp");
    assert.equal(m.PROVIDER_LABEL.green_api, "GREEN-API");
  }
  // 13. the production sequence this rule was written for (2026-08-20 → 2026-09-05)
  {
    const T = (iso) => Date.parse(iso);
    const history = [
      okRow("aug20", T("2026-08-20T18:15:46Z")),
      green400("b750", T("2026-09-02T11:29:00Z")), green400("f7b4", T("2026-09-02T11:29:00Z")), green400("c2de", T("2026-09-02T11:29:00Z")),
      green400("a80d", T("2026-09-03T15:25:49Z")), green400("321d", T("2026-09-03T15:25:49Z")), green400("d7ab", T("2026-09-03T15:25:49Z")),
      green400("13aa", T("2026-09-04T21:02:30Z"), null),   // the owner's manual send — no category
      green400("f719", T("2026-09-05T09:35:48Z"), null),
    ];
    const before = m.channelHealth("whatsapp", history, T("2026-09-05T09:40:00Z"));
    assert.equal(before.tone, "failed", "2–5/09: the card would have been RED while the test row said connected");
    assert.equal(before.consecutiveFailures, 8);
    assert.equal(before.streakKey, "aug20");
    assert.match(before.errorLabel, /GREEN-API/);
    // 05/09 09:45:58Z — the first send after the subscription was renewed
    const after = m.channelHealth("whatsapp", [...history, okRow("16e1", T("2026-09-05T09:45:58Z"))], T("2026-09-05T10:00:00Z"));
    assert.equal(after.tone, "ok");
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.streakKey, "16e1", "a new success starts a new streak identity — the NEXT outage alerts again");
    assert.equal(after.lastAgo, "לפני 14 דקות");
  }
}

suite(M);
ok("nothing sent ⇒ grey; last send ok ⇒ green; last send failed ⇒ red with count + Hebrew code");
ok("recipient-side and in-flight rows are ignored — a bad guest phone never paints the channel red");
ok("the 7-day idle boundary holds from both sides; input order does not matter");
ok("the streak is keyed on the last success (or 'none'); a new success starts a new key");
ok("the 2026-09 production sequence: red at 8 while the test row said connected, green on the renewal send");

// ---- B2: the mutant must fail the same suite ----
{
  const mutantSrc = REAL_SRC.replace(
    'if (SUCCESS_STATUSES.includes(row.status)) return "success";',
    'return "success"; // MUTANT: every row is a success',
  );
  assert.notEqual(mutantSrc, REAL_SRC, "the mutation must have applied — the classifier's first line moved");
  console.log("compiling the MUTANT (every row counts as a success)…");
  const mutant = compile(mutantSrc, "mutant");
  assert.equal(mutant.ALERT_THRESHOLD, 3, "the mutant keeps every export — only the verdict is neutralised");
  assert.throws(() => suite(mutant), "B2: a module that never sees a failure must fail this suite");
  ok("B2: neutralising the classifier fails the suite — the assertions test the verdict, not the exports");
}

// ============================================================
// C. the wiring — the card, the two failure write-paths, the once-lock
// ============================================================
{
  const data = codeOf(src("src/app/(dashboard)/dashboard/data.ts"));
  assert.match(data, /loadChannelHealth\(tenantId, "email"\)/);
  assert.match(data, /loadChannelHealth\(tenantId, "whatsapp"\)/);
  assert.match(data, /channels: \[emailHealth, whatsappHealth\]/, "email first, WhatsApp second — the card's order");
  assert.match(data, /channels: ChannelHealthVerdict\[\];/, "DashboardData carries the verdicts");
  assert.doesNotMatch(data, /last_tested_at/, "the dashboard never reads the connection-test stamp");

  const screen = codeOf(src("src/app/(dashboard)/dashboard/DashboardScreen.tsx"));
  assert.match(screen, /<ChannelsKpi channels=\{data\.channels\} \/>/, "the card is rendered in the KPI row");
  assert.match(screen, /className="card kpi kpi-channels"/);
  assert.match(screen, /c\.tone === "failed" \? \(\s*<Link className="kpi-chan-row kpi-chan-link" href=\{settingsHref\(c\.channel\)\}/,
    "ONLY a red row is a link, and it opens the channel's settings card");
  assert.match(screen, /c\.consecutiveFailures\} ברציפות/, "the red row shows the streak");
  assert.match(screen, /c\.errorLabel/, "the red row shows the code in Hebrew");
  assert.match(screen, /אין שליחות \$\{IDLE_DAYS\} ימים/, "grey says how long");
  assert.doesNotMatch(screen, /Date\.now\(\)/, "no client-side clock — lastAgo is rendered on the server");

  const settings = src("src/app/(dashboard)/settings/MessagingSection.tsx");
  assert.match(settings, /<SettingsCard id="gmail"/, "the deep link's #gmail anchor exists");
  assert.match(settings, /<SettingsCard id="whatsapp"/, "the deep link's #whatsapp anchor exists");
  ok("the card: rendered, red-only link to the anchored settings card, streak + Hebrew code, server-side time");

  const alert = codeOf(src("src/lib/messaging/channel-failure-alert.ts"));
  assert.match(alert, /INSERT INTO guesthub\.messaging_channel_alerts/);
  assert.match(alert, /ON CONFLICT \(tenant_id, channel, streak_key\) DO NOTHING/, "the once-lock is the UNIQUE row, not process memory");
  assert.match(alert, /if \(inserted\.length === 0\) return "already_alerted";/, "a later failure in the same streak sends nothing");
  assert.match(alert, /consecutiveFailures < ALERT_THRESHOLD\) return "below_threshold"/);
  assert.match(alert, /loadChannelHealth\(tenantId, channel\)/, "the mail reads the SAME loader as the card");
  assert.doesNotMatch(alert, /INSERT INTO guesthub\.outbound_messages|createOutboundMessage/, "the alert mail is never an outbound_messages row");
  assert.match(alert, /owner_notification_emails/, "recipients: the owner's notification addresses…");
  assert.match(alert, /failure_notification->>'email'/, "…or the failure_notification override");
  assert.match(alert, /catch \(e\)/, "never throws into the send path");

  const service = codeOf(src("src/lib/messaging/service.ts"));
  assert.match(service, /if \(result\.status === "failed"\) await notifyChannelFailureStreak\(actor\.tenantId, "email"\);/);
  assert.match(service, /if \(result\.status === "failed"\) await notifyChannelFailureStreak\(actor\.tenantId, "whatsapp"\);/);
  const delivery = codeOf(src("src/lib/communications/delivery.ts"));
  assert.match(delivery, /if \(final\) await notifyChannelFailureStreak\(delivery\.tenant_id, delivery\.channel\);/, "the worker's FINAL failure hooks the alert");
  ok("the two failure write-paths (manual service, worker markFailed) both consult the once-lock");

  const migration = "db/migrations/087_messaging_channel_alerts.sql";
  assert.ok(existsSync(join(ROOT, migration)), "migration 087 exists");
  const mig = src(migration);
  assert.match(mig, /CREATE TABLE IF NOT EXISTS guesthub\.messaging_channel_alerts/);
  assert.match(mig, /UNIQUE \(tenant_id, channel, streak_key\)/, "the once-lock constraint");
  assert.match(mig, /outbound_messages_channel_health_idx/, "the health query's index");
  const manifest = src("db/migrations/manifest.txt").split("\n").map((l) => l.trim());
  assert.ok(manifest.includes("087_messaging_channel_alerts.sql"), "087 is listed in the manifest (D136)");
  const pkg = JSON.parse(src("package.json"));
  assert.equal(pkg.scripts["check:channel-health"], "node scripts/check-channel-health.mjs");
  ok("migration 087: table + once-lock + index, listed in the manifest; the guard is registered");
}

console.log(`\n✅ check:channel-health — ${n} groups passed`);
