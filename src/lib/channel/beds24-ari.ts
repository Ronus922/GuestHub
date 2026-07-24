// ============================================================
// Beds24 ARI client (D78/D79) — the ONLY module that sends calendar state
// (price + availability + restrictions) to Beds24. Goes through the shared,
// leak-proof core in ./beds24-http (single attempt, bounded timeout, fixed safe
// messages, token never echoed).
//
// SCOPE: POST /inventory/rooms/calendar ONLY. It never calls properties
// listing, bookings or authentication, and never DELETE.
//
// THE 200-WITH-ERRORS TRAP. Beds24 answers 200 with a per-item envelope:
// [{ success: bool, ... }] (a top-level { success: bool } is also seen). The
// hard-won lesson (a 200 silently dropping rejected values) is applied hard:
//   · ANY success:false found on a 2xx body ⇒ the push FAILED — the caller
//     keeps the affected ranges retryable. Never a clean success.
//   · any warnings/errors-shaped array on an otherwise-successful 2xx body ⇒
//     `partial`, never clean.
//
// LEAK POLICY. Only
// whitelisted, structural fields ever leave this module: the numeric roomId a
// warning concerns and the NAMES of the fields Beds24 objected to. No token,
// no headers, no raw upstream body, no rejected values.
//
// CREDITS: Beds24 bills per request by credits. The whole 5-minute credit
// meter (remaining + resets-in + this call's cost — bare header numbers
// surfaced by beds24-http, names measured live: ./beds24-credits) rides along
// on every result. The sync layer puts it in the evidence context AND feeds it
// to the credit gate, which is what stops a burst before the window empties.
// ============================================================

import {
  beds24Request, beds24Fail, mapErrorStatus,
  type Beds24ApiFailure,
} from "./beds24-http";
import { EMPTY_BEDS24_CREDITS, type Beds24CreditSnapshot } from "./beds24-credits";
import { asObj, asStr, asInt } from "./channel-http";
import {
  validateBeds24CalendarRequest,
  type Beds24CalendarRequest,
} from "./beds24-ari-payloads";

/** A structurally-extracted warning. Carries no upstream text and no values. */
export type SafeBeds24Warning = {
  roomId: number | null;
  /** the names of the rejected fields, e.g. ["price1","minStay"] */
  fields: string[];
};

// No task system exists at Beds24, so a clean success carries
// no ids — the evidence trail records request counts + bytes + credits instead.
export type Beds24CalendarPushResult =
  | { ok: true; partial: false; credits: Beds24CreditSnapshot }
  | { ok: true; partial: true; warnings: SafeBeds24Warning[]; credits: Beds24CreditSnapshot }
  | (Beds24ApiFailure & { credits: Beds24CreditSnapshot });

export type Beds24PushDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// Defensive structural extraction over the per-item envelope. Keeps ONLY the
// numeric roomId and the field names; upstream text and every echoed value is
// discarded here and never persisted.
type EnvelopeVerdict = {
  /** true when ANY item (or the root) says success:false */
  anyFailure: boolean;
  warnings: SafeBeds24Warning[];
};

function extractFieldNames(v: unknown): string[] {
  if (Array.isArray(v)) {
    const names = new Set<string>();
    for (const item of v) {
      const o = asObj(item);
      const field = asStr(o?.field) ?? asStr(o?.action);
      if (field) names.add(field);
    }
    return [...names].sort();
  }
  const o = asObj(v);
  return o ? Object.keys(o).sort() : [];
}

function inspectEnvelope(body: unknown): EnvelopeVerdict {
  const verdict: EnvelopeVerdict = { anyFailure: false, warnings: [] };
  const items: unknown[] = Array.isArray(body) ? body : body !== undefined ? [body] : [];
  for (const item of items) {
    const o = asObj(item);
    if (!o) continue;
    if (o.success === false) verdict.anyFailure = true;
    for (const key of ["warnings", "errors"] as const) {
      const arr = o[key];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      // errors alongside success:false are covered by anyFailure; anything
      // else still marks the push partial — with no leak.
      verdict.warnings.push({
        roomId: asInt(o.roomId),
        fields: extractFieldNames(arr),
      });
    }
  }
  return verdict;
}

export async function pushBeds24Calendar(
  deps: Beds24PushDeps,
  args: {
    token: string;
    baseUrl: string; // from beds24BaseUrl() — never a literal at the call site
    entries: Beds24CalendarRequest;
  },
): Promise<Beds24CalendarPushResult> {
  // structural gate: a malformed payload never reaches the network
  const invalid = validateBeds24CalendarRequest(args.entries);
  if (invalid) return { ...beds24Fail("validation"), credits: EMPTY_BEDS24_CREDITS };

  const r = await beds24Request({
    token: args.token,
    baseUrl: args.baseUrl,
    method: "POST",
    path: "/inventory/rooms/calendar",
    body: args.entries,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  // a transport-level failure never reached Beds24 — no meter to report
  if ("ok" in r) return { ...r, credits: EMPTY_BEDS24_CREDITS };
  const credits = r.credits;
  if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
    const f: Beds24ApiFailure & { credits: Beds24CreditSnapshot } = {
      ...beds24Fail(mapErrorStatus(r.status), r.status), credits,
    };
    // §16 — carry the 429 cooldown forward so the circuit opens for the right span
    return r.retryAfterMs !== undefined ? { ...f, retryAfterMs: r.retryAfterMs } : f;
  }

  const verdict = inspectEnvelope(r.body);
  if (verdict.anyFailure) {
    // success:false on a 200 — Beds24 rejected (some of) the write. Treated as
    // a full failure so the caller keeps every claimed range retryable.
    return { ...beds24Fail("validation", r.status), credits };
  }
  if (verdict.warnings.length > 0)
    return { ok: true, partial: true, warnings: verdict.warnings, credits };
  return { ok: true, partial: false, credits };
}

/** Human-safe, fixed-vocabulary summary of a warning set. Never an upstream body. */
export function summarizeBeds24Warnings(warnings: SafeBeds24Warning[]): string {
  const fields = [...new Set(warnings.flatMap((w) => w.fields))].sort();
  const rooms = [...new Set(warnings.map((w) => w.roomId).filter((r): r is number => r !== null))];
  const span = rooms.length ? ` (${rooms.length} חדרים)` : "";
  const list = fields.length ? `: ${fields.join(", ")}` : "";
  return `Beds24 דחה ${warnings.length} ערכים${span}${list}`;
}
