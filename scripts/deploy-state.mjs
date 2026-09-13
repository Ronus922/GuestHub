#!/usr/bin/env node
// ============================================================
// deploy-state — the release record of the canonical deploy (D191).
//
// Incident (2026-09-12, deploy #1): D185 derived the "previously deployed
// commit" from the working-tree HEAD captured before the fetch. A manual
// `git pull` right before the deploy had already moved HEAD to the target, so
// the manifest range collapsed to HEAD..HEAD, "dependencies unchanged" was
// printed, and the install was skipped for a release that changed package.json.
//
// The base of that diff is now the LAST DEPLOYED commit, read from a state
// file the deploy itself writes at the very end of a successful run:
//
//   read <file> <headCommit>
//     Prints the diff base on stdout. File present → its `commit` (verified to
//     be a git object here); if HEAD differs from it, a WARNING on stderr —
//     someone pulled manually — and the file's commit is still the base. File
//     missing → HEAD, with a loud line on stderr (the first run after D191, or
//     a fresh checkout). A file that exists but cannot be read is a failure
//     (exit 1): never guess a base from a corrupt record.
//
//   write <file> <commit> <buildId>
//     Writes {commit, build, at} atomically (tmp + rename). The deploy calls it
//     ONLY after every post-restart check passed — a failed deploy leaves the
//     previous record in place, so the next run diffs from the release that is
//     actually live.
//
// The pure functions are exported for check:deploy-script.
// ============================================================
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const NO_STATE_LINE = "no .deploy-state — base derived from HEAD";

/** parse the record; throws on anything that is not {commit: <40 hex>} */
export function parseState(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error(`deploy-state is not JSON: ${e.message}`); }
  if (!obj || typeof obj.commit !== "string" || !/^[0-9a-f]{40}$/.test(obj.commit)) {
    throw new Error("deploy-state carries no full commit sha");
  }
  return obj;
}

/** the diff base for the dependency check (D185) — see the header */
export function resolveBase({ stateFile, headCommit, cwd = process.cwd(), commitExists = (sha) => gitObjectExists(sha, cwd) }) {
  if (!existsSync(stateFile)) {
    return { base: headCommit, source: "head", log: [NO_STATE_LINE] };
  }
  const state = parseState(readFileSync(stateFile, "utf8"));
  if (!commitExists(state.commit)) {
    throw new Error(`deploy-state commit ${state.commit.slice(0, 8)} is not in this repository`);
  }
  const log = [];
  if (state.commit !== headCommit) {
    log.push(`WARNING: HEAD ${headCommit.slice(0, 8)} != .deploy-state commit ${state.commit.slice(0, 8)} (manual pull?) — diff base is the deployed commit ${state.commit.slice(0, 8)}, not HEAD`);
  }
  return { base: state.commit, source: "state", log, state };
}

export function gitObjectExists(sha, cwd = process.cwd()) {
  try { execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" }); return true; }
  catch { return false; }
}

/** write the record atomically; returns the record */
export function writeState(stateFile, { commit, build, at = new Date().toISOString() }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("writeState: commit must be a full sha");
  const record = { commit, build, at };
  const tmp = `${stateFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, stateFile);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, file, a, b] = process.argv.slice(2);
  try {
    if (cmd === "read") {
      if (!file || !a) { console.error("usage: deploy-state.mjs read <file> <headCommit>"); process.exit(2); }
      const r = resolveBase({ stateFile: file, headCommit: a });
      for (const l of r.log) console.error(`→ ${l}`);
      process.stdout.write(r.base);
      process.exit(0);
    }
    if (cmd === "write") {
      if (!file || !a || !b) { console.error("usage: deploy-state.mjs write <file> <commit> <buildId>"); process.exit(2); }
      const rec = writeState(file, { commit: a, build: b });
      console.log(`→ recorded ${file}: commit=${rec.commit.slice(0, 8)} build=${rec.build} at=${rec.at}`);
      process.exit(0);
    }
    console.error("usage: deploy-state.mjs read <file> <headCommit> | write <file> <commit> <buildId>");
    process.exit(2);
  } catch (e) {
    console.error(`✗ deploy-state: ${e.message}`);
    process.exit(1);
  }
}
