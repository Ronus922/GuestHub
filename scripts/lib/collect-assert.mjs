// ============================================================
// D127 collect-all: node:assert/strict with recording instead of aborting.
//
// A guard that halts on its first failing assertion reports a FLOOR, not a
// total — one red line can hide thirty. This module is a drop-in for the
// default export of node:assert/strict: every method delegates to the real
// assert, so comparison semantics, strictness and messages are byte-identical.
// The ONLY difference is what happens on failure: an ERR_ASSERTION is printed
// immediately (✗, numbered) and RECORDED, and execution continues, so one run
// reports every failing assertion it can reach. Any other exception still
// throws — a crash is a crash, not a finding.
//
// Exit contract: if anything was recorded, the process exits non-zero — also
// through an explicit process.exit(0) — and a COLLECT-ALL summary is printed.
// A guard's own final "all passed" line is printed by ITS code and may
// therefore appear above a non-empty summary; the summary and the exit code
// are the verdict, not that line.
//
// Deliberately NOT handled: guards that halt via explicit `process.exit(1)`
// control flow (no assert) — wrapping those means rewriting their logic.
// ============================================================
import real from "node:assert/strict";

const failures = [];

const record = (err) => {
  failures.push(err);
  console.error(`✗ ASSERT[${failures.length}] ${err.message}`);
};

const isAssertion = (err) =>
  err && (err.code === "ERR_ASSERTION" || err instanceof real.AssertionError);

// Inside an assert.throws / doesNotThrow callback, assertions must THROW as
// they always did — a guard may run a whole assertion suite against a mutant
// and expect the suite to die (check-connection-health does exactly this).
// Recording there would swallow the throw the enclosing call waits for.
let inExpectation = 0;

const wrap = (fn) =>
  function (...args) {
    let out;
    try {
      out = fn.apply(real, args);
    } catch (err) {
      if (isAssertion(err) && inExpectation === 0) return record(err);
      throw err;
    }
    // assert.rejects / assert.doesNotReject resolve asynchronously
    if (out && typeof out.then === "function") {
      return out.catch((err) => {
        if (isAssertion(err) && inExpectation === 0) return record(err);
        throw err;
      });
    }
    return out;
  };

// throws/doesNotThrow (and the sync entry of rejects/doesNotReject) execute
// their callback with the expectation flag raised.
const wrapExpectation = (fn) =>
  function (cb, ...rest) {
    const raised =
      typeof cb === "function"
        ? function (...a) {
            inExpectation++;
            try {
              return cb.apply(this, a);
            } finally {
              inExpectation--;
            }
          }
        : cb;
    return wrap(fn).call(undefined, raised, ...rest);
  };

const SKIP = new Set(["length", "name", "prototype", "AssertionError", "CallTracker", "strict"]);
const EXPECTATIONS = new Set(["throws", "doesNotThrow", "rejects", "doesNotReject"]);
const assert = wrap(real);
for (const k of Object.getOwnPropertyNames(real)) {
  if (SKIP.has(k)) continue;
  const v = real[k];
  assert[k] = typeof v !== "function" ? v : EXPECTATIONS.has(k) ? wrapExpectation(v) : wrap(v);
}
assert.AssertionError = real.AssertionError;
assert.strict = assert;

let summarized = false;
const summarize = () => {
  if (summarized || failures.length === 0) return;
  summarized = true;
  console.error(`\nCOLLECT-ALL: ${failures.length} assertion failure(s) this run — exit 1.`);
};

const realExit = process.exit.bind(process);
process.exit = (code) => {
  summarize();
  realExit(failures.length > 0 && !code ? 1 : code);
};
process.on("exit", (code) => {
  summarize();
  if (failures.length > 0 && code === 0) process.exitCode = 1;
});

export default assert;
export { failures };
