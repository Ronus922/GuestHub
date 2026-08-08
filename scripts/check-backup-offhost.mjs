// check:backup-offhost — the off-host backup path is encrypted, verified and
// fail-loud, and the restore drill actually exercises it.
//
// THE RULE (H4 closure, 2026-08-08): a backup that only exists on the host it
// protects is not a backup, and an off-host copy that fails SILENTLY is worse
// than none — it manufactures false confidence. This guard freezes the three
// scripts that carry the promise:
//   · guesthub-backup.sh    — the $BACKUP_OFFHOST_CMD hook, under set -e, so
//                             a failed upload fails the nightly unit
//   · guesthub-offhost-b2.sh — age-encrypt BEFORE upload (never plaintext),
//                             native-b2 upload, then a size verification that
//                             exits non-zero on mismatch; the application key
//                             is DEMANDED from the environment
//   · guesthub-restore-drill.sh — pulls the newest object FROM B2 and
//                             age-decrypts it (a drill that restores only the
//                             local file never tests the remote copy), and
//                             says LOUDLY when the remote leg was skipped
//
// HOST WIRING (reported, never silently passed): BACKUP_OFFHOST_CMD lives in
// systemd (guesthub-backup.service drop-in), which exists only on the prod
// host. On other machines this section REPORTS that wiring is absent — a
// loud line, not a quiet green.
//
// B2 — THE GUARD PROVES ITSELF, EVERY RUN, on in-memory copies (the work
// tree is never touched): semantic neutralization of the size verification,
// failure downgraded to a warning, encryption removed (plaintext upload),
// a swallowed upload (|| true), the drill's remote pull removed, the backup
// hook removed, the key requirement dropped. Every rejection is printed.
// Usage: node scripts/check-backup-offhost.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "./lib/collect-assert.mjs"; // D127 collect-all: same node:assert/strict semantics, reports every failure

let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);

const BACKUP = join(ROOT, "scripts/ops/guesthub-backup.sh");
const OFFHOST = join(ROOT, "scripts/ops/guesthub-offhost-b2.sh");
const DRILL = join(ROOT, "scripts/ops/guesthub-restore-drill.sh");
const backupSrc = readFileSync(BACKUP, "utf8");
const offhostSrc = readFileSync(OFFHOST, "utf8");
const drillSrc = readFileSync(DRILL, "utf8");

const occurrences = (hay, needle) => hay.split(needle).length - 1;

// ---- the frozen shape ------------------------------------------------------
// Verbatim twins of the scripts. The duplication is the mechanism: none of
// the promise-carrying lines can drift without editing this file too.
const SET_E = "set -euo pipefail";
const KEY_REQUIRED = ': "${B2_APPLICATION_KEY:?';
const ENCRYPT_LINE = 'age -r "$AGE_RECIPIENT" -o "$AGE_OUT" "$SRC"';
const UPLOAD_LINE = 'rclone copyto "$AGE_OUT" ":b2:${B2_BUCKET}/${NAME}" --no-traverse -q';
const VERIFY_BLOCK = `if [ "\${REMOTE_BYTES:-none}" != "$LOCAL_BYTES" ]; then
  echo "OFFHOST FAIL: remote size \${REMOTE_BYTES:-none} != local \${LOCAL_BYTES} for \${NAME}" >&2
  exit 1
fi`;
const HOOK_LINE = '$BACKUP_OFFHOST_CMD "$ENC"';
const HOOK_WARNING = "WARNING: BACKUP_OFFHOST_CMD not set";
const DRILL_PULL = 'rclone copyto ":b2:${B2_BUCKET}/${REMOTE_NAME}"';
const DRILL_AGE_DECRYPT = 'age -d -i "$AGE_KEY_FILE"';
const DRILL_SKIP_WARN = "OFF-HOST LEG SKIPPED";

// ---- the validator ---------------------------------------------------------
// The three FILES → list of violations. Ran once on the real files, then once
// per mutant (where a clean result is itself the failure).
const validate = (offhost, backup, drill) => {
  const errs = [];

  // offhost: fail-loud shell, key demanded, encrypt → upload → verify, in order
  if (!offhost.includes(SET_E))
    errs.push("offhost script lost `set -euo pipefail` — a failing step no longer fails the run");
  if (!offhost.includes(KEY_REQUIRED))
    errs.push("offhost script no longer DEMANDS B2_APPLICATION_KEY from the environment — a keyless run must refuse, not improvise");
  if (occurrences(offhost, ENCRYPT_LINE) !== 1)
    errs.push("the age-encrypt line is missing or altered — nothing may be uploaded before it is encrypted for the off-host recipient");
  if (occurrences(offhost, UPLOAD_LINE) !== 1)
    errs.push("the upload line is missing or altered (frozen: it uploads \"$AGE_OUT\", the ENCRYPTED artifact — an upload of \"$SRC\" is a plaintext leak of the uploads tar)");
  if (occurrences(offhost, VERIFY_BLOCK) !== 1)
    errs.push("the size-verification block is missing or altered (frozen byte-for-byte: mismatch → exit 1) — an upload nobody verified is a hope, not a copy");
  const encAt = offhost.indexOf(ENCRYPT_LINE);
  const upAt = offhost.indexOf(UPLOAD_LINE);
  const verAt = offhost.indexOf(VERIFY_BLOCK);
  if (encAt >= 0 && upAt >= 0 && encAt > upAt)
    errs.push("the upload precedes the encryption — plaintext would leave the host");
  if (upAt >= 0 && verAt >= 0 && verAt < upAt)
    errs.push("the verification precedes the upload — it verifies nothing");
  if (/\|\|\s*true|;\s*true\s*$/m.test(offhost))
    errs.push("offhost script contains a swallowed failure (`|| true`) — every failure must fail the run");

  // backup: the hook exists, under set -e, and absence warns loudly
  if (!backup.includes(SET_E))
    errs.push("backup script lost `set -euo pipefail` — a failed off-host hook would no longer fail the nightly unit");
  if (occurrences(backup, HOOK_LINE) !== 1)
    errs.push("guesthub-backup.sh no longer calls $BACKUP_OFFHOST_CMD on the encrypted dump — the off-host copy is unwired");
  if (!backup.includes(HOOK_WARNING))
    errs.push("guesthub-backup.sh no longer warns when BACKUP_OFFHOST_CMD is unset — a host without off-host copies would be silent about it");

  // drill: the remote leg exists and its absence is loud
  if (occurrences(drill, DRILL_PULL) !== 1)
    errs.push("the restore drill no longer pulls from B2 — the remote copy is never tested and 'we have an off-host backup' is unproven");
  if (!drill.includes(DRILL_AGE_DECRYPT))
    errs.push("the restore drill no longer age-decrypts the remote object — the off-host restore path is not exercised end-to-end");
  if (!drill.includes(DRILL_SKIP_WARN))
    errs.push("the restore drill lost its LOUD skip warning — a local-only pass would read as a full pass");

  return errs;
};

// ---- 1. the real files pass ------------------------------------------------
const real = validate(offhostSrc, backupSrc, drillSrc);
assert.equal(real.length, 0, `the off-host backup path violates H4:\n  - ${real.join("\n  - ")}`);
ok("offhost: key demanded from env · encrypt → upload → size-verify, in order, fail-loud, no swallowed failures");
ok("backup hook wired under set -e; drill pulls from B2, age-decrypts, and is loud when the remote leg is skipped");

// ---- 2. host wiring — reported, never silently green -----------------------
const DROPIN = "/etc/systemd/system/guesthub-backup.service.d/offhost.conf";
const PENDING = DROPIN + ".pending-key";
if (existsSync(DROPIN)) {
  const dropin = readFileSync(DROPIN, "utf8");
  const m = dropin.match(/^Environment=BACKUP_OFFHOST_CMD=(.+)$/m);
  assert.ok(m && m[1].trim().length > 0,
    `${DROPIN} exists but BACKUP_OFFHOST_CMD is empty or missing in it — the hook is wired to nothing`);
  ok(`host wiring: BACKUP_OFFHOST_CMD=${m[1].trim()} (systemd drop-in active)`);
} else if (existsSync(PENDING)) {
  console.log("  ! host wiring: drop-in is PENDING THE KEY (offhost.conf.pending-key) — nightly off-host copies are NOT active yet");
} else {
  console.log("  ! host wiring: no systemd drop-in on this host — off-host copies are NOT wired here (expected on dev machines; a finding on prod)");
}

// ---- 3. B2 — the guard proves itself, on in-memory copies ------------------
const MUTANTS = [
  ["semantic neutralization: the size comparison becomes always-equal, markers intact",
    "offhost", '"${REMOTE_BYTES:-none}" != "$LOCAL_BYTES"', '"$LOCAL_BYTES" != "$LOCAL_BYTES"'],
  ["failure → warning: the verify block's exit 1 becomes an echo",
    "offhost", "  exit 1\nfi", '  echo "size mismatch (continuing anyway)"\nfi'],
  ["encryption removed: the upload sends $SRC, the plaintext artifact",
    "offhost", UPLOAD_LINE, 'rclone copyto "$SRC" ":b2:${B2_BUCKET}/${NAME}" --no-traverse -q'],
  ["swallowed upload: `|| true` appended to the rclone line",
    "offhost", UPLOAD_LINE, UPLOAD_LINE + " || true"],
  ["key requirement dropped: a keyless run improvises instead of refusing",
    "offhost", ': "${B2_APPLICATION_KEY:?OFFHOST FAIL: B2_APPLICATION_KEY is not set — fill /etc/guesthub-backup-b2.env}"\n', ""],
  ["drill remote pull removed: the remote copy is never tested again",
    "drill", DRILL_PULL, 'true # pull removed'],
  ["backup hook removed: the nightly run never calls the off-host command",
    "backup", '  $BACKUP_OFFHOST_CMD "$ENC"\n', ""],
];

for (const [label, target, oldText, newText] of MUTANTS) {
  const src = target === "offhost" ? offhostSrc : target === "drill" ? drillSrc : backupSrc;
  assert.equal(occurrences(src, oldText), 1,
    `B2 battery is stale: anchor for mutant "${label}" is not unique in the ${target} script — rewrite it`);
  const mutant = src.replace(oldText, newText);
  assert.notEqual(mutant, src, `B2 battery is stale: mutant "${label}" no longer changes the file — rewrite it`);
  const verdicts = validate(
    target === "offhost" ? mutant : offhostSrc,
    target === "backup" ? mutant : backupSrc,
    target === "drill" ? mutant : drillSrc,
  );
  assert.ok(verdicts.length > 0,
    `B2: mutant "${label}" PASSED the validator — the guard is not a guard`);
  if (verdicts.length > 0) console.log(`  ✓ B2 mutant rejected: ${label}`);
}
ok(`B2: all ${MUTANTS.length} mutants rejected — the off-host promise cannot be neutralized, softened, or unwired without this guard failing`);

console.log(`\nall ${n} backup-offhost checks passed — encrypted, verified, fail-loud, and drilled from the remote (H4)`);
