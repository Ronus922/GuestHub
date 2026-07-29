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
// LEAK POLICY (revised by D112). The token and headers still never leave this
// module. The response BODY does: a failure must carry its own evidence — the
// verbatim HTTP status and raw body ride along on `raw` and are persisted on
// the error record, and the provider's own message text (e.g. "invalid dates")
// is surfaced to internal operator screens. Before D112 the body was mapped to
// a category and discarded, and diagnosis required re-running the failure.
//
// CREDITS: Beds24 bills per request by credits. The whole 5-minute credit
// meter (remaining + resets-in + this call's cost — bare header numbers
// surfaced by beds24-http, names measured live: ./beds24-credits) rides along
// on every result. The sync layer puts it in the evidence context AND feeds it
// to the credit gate, which is what stops a burst before the window empties.
// ============================================================

import {
  beds24Request, beds24Fail, mapErrorStatus, rawEvidenceOf,
  type Beds24ApiFailure, type RawResponseEvidence,
} from "./beds24-http";
import { EMPTY_BEDS24_CREDITS, type Beds24CreditSnapshot } from "./beds24-credits";
import { asObj, asStr, asInt } from "./channel-http";
import {
  validateBeds24CalendarRequest,
  type Beds24CalendarRequest,
} from "./beds24-ari-payloads";

/** A structurally-extracted warning: the room it concerns, the NAMES of the
 *  rejected fields, and (D112) the provider's own message text — shown on
 *  internal operator screens, never on guest-facing surfaces. */
export type SafeBeds24Warning = {
  roomId: number | null;
  /** the names of the rejected fields, e.g. ["price1","minStay"] */
  fields: string[];
  /** the provider's own message texts, e.g. ["invalid dates"] (bounded) */
  messages: string[];
};

// No task system exists at Beds24, so a clean success carries
// no ids — the evidence trail records request counts + bytes + credits instead.
export type Beds24CalendarPushResult =
  | { ok: true; partial: false; credits: Beds24CreditSnapshot }
  | {
      ok: true; partial: true; warnings: SafeBeds24Warning[];
      credits: Beds24CreditSnapshot;
      /** D112 — the verbatim response that carried the warnings */
      raw: RawResponseEvidence;
    }
  | (Beds24ApiFailure & { credits: Beds24CreditSnapshot });

export type Beds24PushDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// Defensive structural extraction over the per-item envelope: the numeric
// roomId, the field names, and (D112) the provider's own `message` texts —
// bounded, because the whole verbatim body already survives on `raw`.
type EnvelopeVerdict = {
  /** true when ANY item (or the root) says success:false */
  anyFailure: boolean;
  warnings: SafeBeds24Warning[];
};

const MAX_PROVIDER_MESSAGES = 5;
const MAX_PROVIDER_MESSAGE_CHARS = 200;

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

// D112 — the provider's own words. In today's incident the word that mattered
// ("invalid dates") sat exactly here while the operator saw only the action
// name. Distinct, order-preserving, bounded.
function extractMessages(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const msg = asStr(asObj(item)?.message);
    if (!msg) continue;
    const capped = msg.slice(0, MAX_PROVIDER_MESSAGE_CHARS);
    if (!out.includes(capped)) out.push(capped);
    if (out.length >= MAX_PROVIDER_MESSAGES) break;
  }
  return out;
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
      // else still marks the push partial.
      verdict.warnings.push({
        roomId: asInt(o.roomId),
        fields: extractFieldNames(arr),
        messages: extractMessages(arr),
      });
    }
  }
  return verdict;
}

/**
 * Append the names of the fields Beds24 objected to, in the SAME wording the
 * partial path already uses — the failure path used to extract them and then
 * drop them on the floor, leaving an operator with a fixed string that named
 * nothing. An EMPTY set is appended as nothing at all: summarizeBeds24Warnings
 * has no empty guard of its own and would state "Beds24 דחה 0 ערכים", which is
 * a worse lie than saying less (a bare success:false carries no errors[]).
 */
function withFields(message: string, warnings: SafeBeds24Warning[]): string {
  return warnings.length === 0 ? message : `${message} — ${summarizeBeds24Warnings(warnings)}`;
}

/** The distinct provider message texts across a warning set, bounded. */
function providerTexts(warnings: SafeBeds24Warning[]): string[] {
  const out: string[] = [];
  for (const w of warnings) {
    for (const m of w.messages) {
      if (!out.includes(m)) out.push(m);
      if (out.length >= MAX_PROVIDER_MESSAGES) return out;
    }
  }
  return out;
}

export async function pushBeds24Calendar(
  deps: Beds24PushDeps,
  args: {
    token: string;
    baseUrl: string; // from beds24BaseUrl() — never a literal at the call site
    entries: Beds24CalendarRequest;
  },
): Promise<Beds24CalendarPushResult> {
  // Structural gate: a malformed payload never reaches the network. The reason
  // is OUR OWN fixed vocabulary (validateBeds24CalendarRequest), not upstream
  // text, so naming the offending field leaks nothing — and without it the
  // operator sees "הנתונים נדחו" with no way to know WHICH field, on a payload
  // that never left the process and therefore has no provider-side trace either.
  const invalid = validateBeds24CalendarRequest(args.entries);
  if (invalid) {
    // the payload never left the process, so there is no meter to report — but
    // the REASON must survive (#114): without it the operator sees only
    // "הנתונים נדחו" for a request that has no provider-side trace either.
    // D112: no response exists, and the evidence says exactly that (null
    // status, null body) — never a stand-in value. The message names no HTTP
    // status either, because none was received.
    const f = beds24Fail("validation", undefined, rawEvidenceOf(null, null));
    return {
      ...f,
      message: `המטען נפסל לפני שליחה — מטען לא תקין: ${invalid}`,
      credits: EMPTY_BEDS24_CREDITS,
    };
  }

  const r = await beds24Request({
    token: args.token,
    baseUrl: args.baseUrl,
    method: "POST",
    path: "/inventory/rooms/calendar",
    body: args.entries,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  // a transport-level failure never reached Beds24 — no meter to report; the
  // failure already carries its raw evidence (null status/body) from the core
  if ("ok" in r) return { ...r, credits: EMPTY_BEDS24_CREDITS };
  const credits = r.credits;
  // Inspected BEFORE the status check: a 4xx body carries the same
  // errors[]/field shape a 200-with-success:false does, and it used never to be
  // read at all — the operator got a fixed category string for a response that
  // named the offending field.
  const verdict = inspectEnvelope(r.body);
  if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
    // D112: the raw evidence (status + body, verbatim) rides on every failure.
    const base = beds24Fail(mapErrorStatus(r.status), r.status, r.raw);
    // The status code in CATEGORY_MESSAGE is truthful on THIS path by
    // construction: mapErrorStatus is one-to-one onto the categories whose text
    // carries a code (401/403/404/409/422/429), and every other status lands on
    // bad_response/server_error, whose text carries none. The one path that
    // could lie is the envelope branch below, which bypasses the mapping.
    const f: Beds24ApiFailure & { credits: Beds24CreditSnapshot } = {
      ...base, message: withFields(base.message, verdict.warnings), credits,
    };
    // §16 — carry the 429 cooldown forward so the circuit opens for the right span
    return r.retryAfterMs !== undefined ? { ...f, retryAfterMs: r.retryAfterMs } : f;
  }

  if (verdict.anyFailure) {
    // success:false on a 2xx — Beds24 rejected (some of) the write. Treated as
    // a full failure so the caller keeps every claimed range retryable.
    // The category stays `validation` (the backoff/circuit machinery keys on
    // the CODE), but the message is composed here rather than taken from
    // CATEGORY_MESSAGE, whose "(422)" is baked into the string. D112: it states
    // the status ACTUALLY received (this is the path that once printed "(422)"
    // for an HTTP 201) plus the fields and the provider's own words, and the
    // raw evidence rides on the failure verbatim.
    return {
      ...beds24Fail("validation", r.status, r.raw),
      message: withFields(`Beds24 דחה את העדכון (HTTP ${r.status}, success:false)`, verdict.warnings),
      credits,
    };
  }
  if (verdict.warnings.length > 0)
    return { ok: true, partial: true, warnings: verdict.warnings, credits, raw: r.raw };
  return { ok: true, partial: false, credits };
}

/** Operator-facing summary of a warning set. D112: includes the provider's own
 *  message texts — every value here comes off the response, never a stand-in. */
export function summarizeBeds24Warnings(warnings: SafeBeds24Warning[]): string {
  const fields = [...new Set(warnings.flatMap((w) => w.fields))].sort();
  const rooms = [...new Set(warnings.map((w) => w.roomId).filter((r): r is number => r !== null))];
  const span = rooms.length ? ` (${rooms.length} חדרים)` : "";
  const list = fields.length ? `: ${fields.join(", ")}` : "";
  const texts = providerTexts(warnings);
  const quoted = texts.length ? ` — ${texts.map((t) => `"${t}"`).join(" | ")}` : "";
  return `Beds24 דחה ${warnings.length} ערכים${span}${list}${quoted}`;
}
