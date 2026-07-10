// ============================================================
// Channex ARI client (D68) — the ONLY module that sends availability, rates or
// restrictions. Goes through the shared, leak-proof core in ./channex-http
// (single attempt, bounded timeout, fixed safe messages, api-key never echoed).
//
// SCOPE: POST /availability and POST /restrictions ONLY. It never calls
// properties, room_types, rate_plans, webhooks or bookings, and never DELETE.
// scripts/check-channex-ari.mjs asserts that at the source level.
//
// THE 200-WITH-WARNINGS TRAP. Channex answers a partially-rejected ARI update
// with HTTP 200 and a populated `meta.warnings` array (`data` may be empty).
// Treating that as success silently drops the rejected dates. Here a response
// carrying ANY warning is reported as `partial`, never as clean success, and the
// caller keeps the affected range retryable.
//
// LEAK POLICY. Only whitelisted, structural fields ever leave this module: task
// UUIDs, the date range a warning concerns, and the NAMES of the fields Channex
// objected to. No api-key, no headers, no raw upstream body, no rejected values.
// ============================================================

import {
  channexRequest, fail, mapErrorStatus, asObj, asStr,
  type ChannexApiFailure, type ChannexReqOpts,
} from "./channex-http";
import { validateAriBatch } from "./ari-payloads";

export type AriKind = "availability" | "restrictions";

/** A structurally-extracted warning. Carries no upstream text and no values. */
export type SafeAriWarning = {
  kind: AriKind;
  dateFrom: string | null;
  dateTo: string | null;
  /** the external entity the warning concerns — a UUID we already know */
  entityId: string | null;
  /** the names of the rejected fields, e.g. ["min_stay_arrival","rate"] */
  fields: string[];
};

export type AriPushResult =
  | { ok: true; partial: false; taskIds: string[] }
  | { ok: true; partial: true; taskIds: string[]; warnings: SafeAriWarning[] }
  | ChannexApiFailure;

const PATHS: Record<AriKind, string> = {
  availability: "/availability",
  restrictions: "/restrictions",
};

// data: [{ id, type: "task" }] — collect the task references for the audit trail.
function extractTaskIds(body: unknown): string[] {
  const data = asObj(body)?.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    const id = asStr(asObj(item)?.id);
    if (id) ids.push(id);
  }
  return ids;
}

// meta.warnings: [{ date/date_from/date_to, rate_plan_id|room_type_id,
//                   warning: { <field>: [<upstream text>] }, ...other echoed keys }]
// We keep the dates, the entity UUID and the FIELD NAMES. The upstream text and
// every echoed value is discarded here and never persisted or logged.
function extractWarnings(body: unknown, kind: AriKind): SafeAriWarning[] {
  const warnings = asObj(asObj(body)?.meta)?.warnings;
  if (!Array.isArray(warnings)) return [];
  const out: SafeAriWarning[] = [];
  for (const item of warnings) {
    const w = asObj(item);
    if (!w) continue;
    const detail = asObj(w.warning);
    out.push({
      kind,
      dateFrom: asStr(w.date_from) ?? asStr(w.date),
      dateTo: asStr(w.date_to) ?? asStr(w.date),
      entityId: asStr(w.rate_plan_id) ?? asStr(w.room_type_id),
      fields: detail ? Object.keys(detail).sort() : [],
    });
  }
  return out;
}

export async function pushAri(
  opts: ChannexReqOpts & { kind: AriKind; batch: { values: unknown[] } },
): Promise<AriPushResult> {
  // structural gate: a malformed payload never reaches the network
  const invalid = validateAriBatch(opts.batch);
  if (invalid) return { ok: false, category: "validation", message: "הנתונים נדחו (422) — יש להשלים או לתקן שדות חובה" };

  const r = await channexRequest({
    ...opts,
    method: "POST",
    path: PATHS[opts.kind],
    body: { values: opts.batch.values },
  });
  if ("ok" in r) return r; // transport-level failure, already a safe category
  if (r.status !== 200 && r.status !== 201) return fail(mapErrorStatus(r.status), r.status);

  const taskIds = extractTaskIds(r.body);
  const warnings = extractWarnings(r.body, opts.kind);
  if (warnings.length > 0) return { ok: true, partial: true, taskIds, warnings };

  // A 2xx with neither a task reference nor a warning is not a shape we
  // recognise: refuse to record it as a clean success.
  if (taskIds.length === 0) return fail("bad_response", r.status);
  return { ok: true, partial: false, taskIds };
}

/** Human-safe, fixed-vocabulary summary of a warning set. Never an upstream body. */
export function summarizeWarnings(warnings: SafeAriWarning[]): string {
  const fields = [...new Set(warnings.flatMap((w) => w.fields))].sort();
  const dates = warnings.map((w) => w.dateFrom).filter((d): d is string => !!d).sort();
  const span = dates.length ? ` (${dates[0]}…${dates[dates.length - 1]})` : "";
  const list = fields.length ? `: ${fields.join(", ")}` : "";
  return `Channex דחה ${warnings.length} ערכים${span}${list}`;
}
