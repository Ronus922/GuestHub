// ============================================================
// Hospitable ARI client (D77 Phase 4) — the ONLY module that sends calendar
// state (price + availability + restrictions) to Hospitable. Mirror of
// channex-ari.ts: goes through the shared, leak-proof core in
// ./hospitable-http (single attempt, bounded timeout, fixed safe messages,
// PAT never echoed).
//
// SCOPE: PUT /properties/{uuid}/calendar ONLY. It never calls properties
// listing, reservations or webhooks, and never DELETE.
//
// THE 200-WITH-WARNINGS TRAP, DEFENSIVELY. Hospitable documents no partial-
// rejection channel, but the Channex lesson (a 200 carrying warnings silently
// dropping rejected dates) is applied here anyway: any warnings/errors-shaped
// array found on a 2xx body is reported as `partial`, never as clean success,
// and the caller keeps the affected range retryable.
//
// LEAK POLICY (identical to channex-ari.ts). Only whitelisted, structural
// fields ever leave this module: the date a warning concerns and the NAMES of
// the fields Hospitable objected to. No PAT, no headers, no raw upstream
// body, no rejected values.
// ============================================================

import {
  hospitableRequest, hospitableFail, mapErrorStatus,
  type HospitableApiFailure,
} from "./hospitable-http";
import { asObj, asStr } from "./channel-http";
import {
  validateHospitableCalendarBatch,
  type HospitableCalendarDate,
} from "./hospitable-ari-payloads";

/** A structurally-extracted warning. Carries no upstream text and no values. */
export type SafeHospitableWarning = {
  date: string | null;
  /** the names of the rejected fields, e.g. ["price","min_stay"] */
  fields: string[];
};

// No task system exists at Hospitable (unlike Channex), so a clean success
// carries no ids — the evidence trail records request counts + bytes instead.
export type HospitableCalendarPushResult =
  | { ok: true; partial: false }
  | { ok: true; partial: true; warnings: SafeHospitableWarning[] }
  | HospitableApiFailure;

export type HospitablePushDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

// Defensive structural extraction: accept `warnings`/`errors` arrays at the
// top level or under `meta`/`data`, keep ONLY the date and the field names.
// Upstream text and every echoed value is discarded here and never persisted.
function extractWarnings(body: unknown): SafeHospitableWarning[] {
  const root = asObj(body);
  if (!root) return [];
  const candidates: unknown[] = [
    root.warnings, root.errors,
    asObj(root.meta)?.warnings, asObj(root.meta)?.errors,
  ];
  const out: SafeHospitableWarning[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    for (const item of candidate) {
      const w = asObj(item);
      if (!w) {
        // a bare string entry still marks the push partial — with no leak
        out.push({ date: null, fields: [] });
        continue;
      }
      const detail = asObj(w.errors) ?? asObj(w.warning) ?? asObj(w.fields);
      out.push({
        date: asStr(w.date),
        fields: detail ? Object.keys(detail).sort() : [],
      });
    }
  }
  return out;
}

export async function pushHospitableCalendar(
  deps: HospitablePushDeps,
  args: {
    token: string;
    baseUrl: string; // from hospitableBaseUrl() — never a literal at the call site
    propertyId: string;
    dates: HospitableCalendarDate[];
  },
): Promise<HospitableCalendarPushResult> {
  // structural gate: a malformed payload never reaches the network
  const invalid = validateHospitableCalendarBatch({ dates: args.dates });
  if (invalid) return hospitableFail("validation");

  const r = await hospitableRequest({
    token: args.token,
    baseUrl: args.baseUrl,
    method: "PUT",
    path: `/properties/${args.propertyId}/calendar`,
    body: { dates: args.dates },
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if ("ok" in r) return r; // transport-level failure, already a safe category
  if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
    const f = hospitableFail(mapErrorStatus(r.status), r.status);
    // §16 — carry the 429 cooldown forward so the circuit opens for the right span
    return r.retryAfterMs !== undefined ? { ...f, retryAfterMs: r.retryAfterMs } : f;
  }

  const warnings = extractWarnings(r.body);
  if (warnings.length > 0) return { ok: true, partial: true, warnings };
  return { ok: true, partial: false };
}

/** Human-safe, fixed-vocabulary summary of a warning set. Never an upstream body. */
export function summarizeHospitableWarnings(warnings: SafeHospitableWarning[]): string {
  const fields = [...new Set(warnings.flatMap((w) => w.fields))].sort();
  const dates = warnings.map((w) => w.date).filter((d): d is string => !!d).sort();
  const span = dates.length ? ` (${dates[0]}…${dates[dates.length - 1]})` : "";
  const list = fields.length ? `: ${fields.join(", ")}` : "";
  return `Hospitable דחה ${warnings.length} ערכים${span}${list}`;
}
