import "server-only";
import type { Sql } from "postgres";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { beds24BaseUrl } from "./config";
import { getBeds24AccessToken } from "./beds24-token";
import { beds24Request, beds24Fail, mapErrorStatus } from "./beds24-http";
import { asObj, asInt } from "./channel-http";
import { projectBeds24Ari } from "./beds24-ari-projection";
import {
  buildBeds24CalendarRequests,
  type Beds24RoomCalendarEntry,
} from "./beds24-ari-payloads";
import {
  loadBeds24Mappings, toBuilderMappings as toBeds24BuilderMappings,
  type Beds24AriConnection,
} from "./beds24-ari-sync";
import { recordAriEvidence, type EvidenceOutcome } from "./evidence";
import { logChannelError } from "./queue";

// ============================================================
// Beds24 ARI READ-BACK (P0-3) — the OUTBOUND half of the overbooking hole.
//
// D93 closed the inbound half: an OTA cancellation that never reached us left a
// room blocked here. This module closes the mirror-image failure: a room that is
// OCCUPIED here while Beds24 still holds `numAvail: 1` — a push that was lost,
// rejected per-value on a 200, or overwritten at the provider — and therefore
// keeps selling a bed we already sold. Nothing in the outbound path ever looked
// at what Beds24 actually HOLDS; it only looked at what we sent.
//
// STRICTLY READ-ONLY — DETECT AND ALERT, NEVER CORRECT.
// The ONE network call this module can make is
//   GET /inventory/rooms/calendar
// (READBACK_PATH + method "GET", a single call site). It imports NOTHING from
// beds24-ari.ts, so `pushBeds24Calendar` is not even reachable from here, and it
// writes no dirty range, no mapping and no connection state. A drift is
// reported to the operator; the correction is the operator's decision (the
// existing Full Sync / the drain), never an automatic write triggered by a read.
// If a future change adds a fix-up path here, it is out of scope by design —
// move it to the sync layer where the write invariants live.
//
// WINDOW: 14 days forward from today in the property timezone. Not the 500-day
// ARI horizon. Overbooking is an imminent-arrivals problem; a stale price 400
// days out costs nothing per cycle, and 500 days of read-back would be pure
// noise plus bytes. Anything beyond the window is re-stated by the next Full
// Sync, which still covers ARI_HORIZON_DAYS.
//
// CREDITS — the cadence is DERIVED, not chosen (measured live 2026-07-24
// against api.beds24.com with the production access token; see DECISIONS D95):
//
//   response headers on the wire (Apache; HTTP/1.1 names are case-insensitive):
//     x-request-cost: 1        x-five-min-limit-remaining: 97.8 → 96.8 → 95.8
//     x-five-min-limit-resets-in: 288
//   NOTE the documented apiV2.yaml spellings (X-RequestCost /
//   X-FiveMinCreditLimit-Remaining) are NOT what the server sends — three
//   consecutive probes moved `x-five-min-limit-remaining` by exactly 1.0 each,
//   which is the only reason we can call the measured cost authoritative.
//
//   · ONE request covers EVERY mapped room (14 rooms in production today) for
//     the whole 14-day window: `roomId` is a REPEATED query param and the reply
//     came back complete with pages.nextPageExists=false. Cost was 1 credit for
//     14 rooms × 14 days, and 1 credit for a single room — the meter bills per
//     REQUEST, not per room or per date.
//   · ceiling: 100 credits per rolling 5 minutes, per account.
//   · worst case per cycle: BEDS24_READBACK_MAX_REQUESTS (3, the page bound)
//     × 1 = 3 credits = 3% of the ceiling, in the ONE window a cycle lands in.
//   · amortised at the reconcile cadence (worker.ts RECONCILE_MINUTES = 20):
//     3 credits × (5/20) = 0.75 credits per 5-minute window = 0.75%.
//   ⇒ 20 minutes is affordable by a factor of >30 even on the burst figure, so
//     the read-back needs NO cadence of its own: it rides the EXISTING
//     reconcile_inventory job (which already spends up to RECONCILE_LIMIT=50
//     credits per cycle on booking reconciliation — the read-back adds ≤6% to
//     that job's own bill). No new job type, no new timer, no new cron.
//
// The affordability arithmetic is not a comment-only claim:
// beds24ReadbackCreditsPerWindow() is asserted against the real cadence
// constant by check:beds24-ari-readback.
// ============================================================

/** GET-only. The single Beds24 path this module is allowed to touch. */
const READBACK_PATH = "/inventory/rooms/calendar";

/** Forward window compared each cycle, in property-local dates. */
export const BEDS24_READBACK_DAYS = 14;

/** Hard page bound per cycle — pagination can never become an unbounded loop. */
export const BEDS24_READBACK_MAX_REQUESTS = 3;

/** MEASURED `x-request-cost` of one read-back call (live, 2026-07-24). */
export const BEDS24_READBACK_REQUEST_COST = 1;

/** Beds24's metered window and its ceiling (credits per account). */
export const BEDS24_CREDIT_WINDOW_MINUTES = 5;
export const BEDS24_CREDIT_CEILING = 100;

/** Worst case a single cycle can spend, all pages walked. */
export const BEDS24_READBACK_BURST_CREDITS =
  BEDS24_READBACK_MAX_REQUESTS * BEDS24_READBACK_REQUEST_COST;

/** Credits the read-back costs per rolling 5-minute window at a given cadence
 *  (amortised). Pure — the cadence derivation is checkable without a network. */
export function beds24ReadbackCreditsPerWindow(cadenceMinutes: number): number {
  if (!(cadenceMinutes > 0)) return Number.POSITIVE_INFINITY;
  return BEDS24_READBACK_BURST_CREDITS * (BEDS24_CREDIT_WINDOW_MINUTES / cadenceMinutes);
}

// ---- the comparison unit: one (Beds24 room, date) cell ----
export type Beds24DayCell = {
  beds24RoomId: number;
  date: DateOnly;
  /** 0/1 on our side; ANY integer from Beds24 — negative means overbooked there */
  numAvail: number | null;
  /** major currency units; null = no price statement */
  price1: number | null;
};

export type Beds24DriftKind = "availability" | "price" | "missing";

export type Beds24Drift = {
  beds24RoomId: number;
  date: DateOnly;
  kind: Beds24DriftKind;
  expected: number | null;
  remote: number | null;
  /** THE overbooking signature: we hold the room, Beds24 still sells it */
  oversell: boolean;
};

/** A calendar range as it appears on EITHER side of the comparison. `to` is
 *  INCLUSIVE (the verified Beds24 shape, both on GET and POST). */
type RawRange = { from: string; to: string; numAvail: number | null; price1: number | null };
type RawRoomEntry = { beds24RoomId: number; calendar: RawRange[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** finite number, or a numeric string (Beds24 has been seen to send both). */
function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---- range → per-day cells. ONE expander for both sides, so a compression bug
// can never make the two halves disagree for a reason that is not real drift.
export function expandBeds24Calendar(
  entries: readonly RawRoomEntry[],
  window: { from: DateOnly; toInclusive: DateOnly },
): Map<string, Beds24DayCell> {
  const out = new Map<string, Beds24DayCell>();
  for (const entry of entries) {
    for (const r of entry.calendar) {
      if (!DATE_RE.test(r.from) || !DATE_RE.test(r.to) || r.from > r.to) continue;
      // clamp to the compared window — Beds24 may answer with wider ranges
      let date = r.from < window.from ? window.from : r.from;
      const last = r.to > window.toInclusive ? window.toInclusive : r.to;
      // bounded: the window itself is the bound, never the provider's range
      for (let guard = 0; date <= last && guard <= BEDS24_READBACK_DAYS; guard++) {
        out.set(`${entry.beds24RoomId}|${date}`, {
          beds24RoomId: entry.beds24RoomId,
          date,
          numAvail: r.numAvail,
          price1: r.price1,
        });
        date = addDays(date, 1);
      }
    }
  }
  return out;
}

/** what we intend Beds24 to hold — the EXACT bodies the push would send. */
export function expectedEntriesOf(
  requests: readonly Beds24RoomCalendarEntry[][],
): RawRoomEntry[] {
  const out: RawRoomEntry[] = [];
  for (const request of requests) {
    for (const entry of request) {
      out.push({
        beds24RoomId: entry.roomId,
        calendar: entry.calendar.map((r) => ({
          from: r.from,
          to: r.to,
          numAvail: r.numAvail,
          price1: r.price1 ?? null,
        })),
      });
    }
  }
  return out;
}

// ---- defensive parse of the GET body. Only whitelisted numeric/date fields
// survive; no upstream text is ever kept (same leak policy as beds24-ari.ts).
export function parseBeds24CalendarBody(body: unknown): {
  entries: RawRoomEntry[];
  nextPageExists: boolean;
} {
  const root = asObj(body);
  const data = root && Array.isArray(root.data) ? root.data : [];
  const entries: RawRoomEntry[] = [];
  for (const item of data) {
    const o = asObj(item);
    const roomId = asInt(o?.roomId) ?? (o ? asNum(o.roomId) : null);
    if (o === null || roomId === null || !Number.isInteger(roomId)) continue;
    const cal = Array.isArray(o.calendar) ? o.calendar : [];
    const calendar: RawRange[] = [];
    for (const c of cal) {
      const range = asObj(c);
      if (!range) continue;
      const from = typeof range.from === "string" ? range.from : null;
      const to = typeof range.to === "string" ? range.to : from;
      if (from === null || to === null) continue;
      calendar.push({ from, to, numAvail: asNum(range.numAvail), price1: asNum(range.price1) });
    }
    entries.push({ beds24RoomId: roomId, calendar });
  }
  const pages = asObj(root?.pages);
  return { entries, nextPageExists: pages?.nextPageExists === true };
}

// ---- THE diff. Pure; the whole point of the job lives in these ~20 lines. ----
//
// Compared per (room, date) cell that WE have a statement about:
//   · numAvail — any mismatch is drift; expected 0 with remote > 0 is the
//     oversell signature (we hold the room, Beds24 still sells it).
//   · price1 — only when we actually publish a price. A blocked cell publishes
//     numAvail:0 with NO price1 (fail-closed, beds24-ari-payloads.ts), which
//     LEAVES Beds24's previous price in place: remote price with no expected
//     price is therefore expected behaviour, NOT drift. Alerting on it would
//     make every blocked date a false positive and train the operator to
//     ignore the alert.
//   · restrictions (minStay/maxStay) are deliberately NOT compared: the API
//     documents that a calendar without a minStay/maxStay returns the ROOM's
//     value instead, so a mismatch there does not distinguish drift from a
//     room-level default. Comparing them would be noise, not evidence.
export function diffBeds24Calendar(
  expected: Map<string, Beds24DayCell>,
  remote: Map<string, Beds24DayCell>,
): Beds24Drift[] {
  const drift: Beds24Drift[] = [];
  for (const [key, want] of expected) {
    const got = remote.get(key);
    if (!got || got.numAvail === null) {
      drift.push({
        beds24RoomId: want.beds24RoomId, date: want.date, kind: "missing",
        expected: want.numAvail, remote: null,
        // no statement at the provider is not proof it is selling — but it is
        // not proof it is closed either. Never counted as a confirmed oversell.
        oversell: false,
      });
      continue;
    }
    if (got.numAvail !== want.numAvail) {
      drift.push({
        beds24RoomId: want.beds24RoomId, date: want.date, kind: "availability",
        expected: want.numAvail, remote: got.numAvail,
        oversell: want.numAvail === 0 && got.numAvail > 0,
      });
    }
    if (want.price1 !== null && (got.price1 === null || Math.abs(got.price1 - want.price1) > 0.005)) {
      drift.push({
        beds24RoomId: want.beds24RoomId, date: want.date, kind: "price",
        expected: want.price1, remote: got.price1, oversell: false,
      });
    }
  }
  drift.sort((a, b) =>
    a.beds24RoomId - b.beds24RoomId || a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return drift;
}

// ============================================================
// The cycle
// ============================================================

export type Beds24ReadbackSummary = {
  rooms: number;
  days: number;
  /** GET requests actually issued (never more than the page bound) */
  requests: number;
  comparedCells: number;
  driftCells: number;
  oversellCells: number;
  /** the provider had more pages than the bound allows — reported, never silent */
  truncated: boolean;
  drift: Beds24Drift[];
  /** sanitized messages only — never an upstream body */
  errors: string[];
};

/** how many drift cells travel into the durable evidence context */
const SAMPLE_LIMIT = 25;

const emptySummary = (): Beds24ReadbackSummary => ({
  rooms: 0, days: BEDS24_READBACK_DAYS, requests: 0, comparedCells: 0,
  driftCells: 0, oversellCells: 0, truncated: false, drift: [], errors: [],
});

// One unresolved alert per (connection, code): the cycle repeats every
// RECONCILE_MINUTES and a drift persists until an operator acts, so re-logging
// every cycle would push the 10-row /channels error list into a single repeating
// message and bury everything else. The per-cycle detail still lands in the
// append-only evidence ledger, which is the trail, not the alarm.
async function alertOnce(
  db: Sql,
  conn: Beds24AriConnection,
  e: { code: string; message: string; dateFrom: DateOnly; dateTo: DateOnly; context: unknown },
): Promise<void> {
  const [existing] = await db<{ x: number }[]>`
    SELECT 1 AS x FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${conn.tenant_id} AND connection_id = ${conn.id}
      AND error_code = ${e.code} AND resolved_at IS NULL
    LIMIT 1`;
  if (existing) return;
  await logChannelError(db, {
    tenantId: conn.tenant_id, connectionId: conn.id,
    dateFrom: e.dateFrom, dateTo: e.dateTo,
    code: e.code, message: e.message, context: e.context,
  });
}

/** ONE page of the read-back. GET only — the sole network call of this module. */
async function fetchCalendarPage(
  creds: { token: string; baseUrl: string },
  args: { beds24RoomIds: number[]; from: DateOnly; toInclusive: DateOnly; page: number },
): Promise<{ ok: true; entries: RawRoomEntry[]; nextPageExists: boolean } | { ok: false; message: string }> {
  // repeated `roomId` params — the verified wire form (a CSV value is not the
  // accepted shape for Beds24 list filters; proven live for `status`, and the
  // repeated form was proven live for `roomId` on 2026-07-24).
  const qs = [
    `startDate=${args.from}`,
    `endDate=${args.toInclusive}`,
    ...args.beds24RoomIds.map((id) => `roomId=${encodeURIComponent(String(id))}`),
    "includeNumAvail=true",
    "includePrices=true",
    ...(args.page > 1 ? [`page=${args.page}`] : []),
  ].join("&");

  const r = await beds24Request({
    token: creds.token,
    baseUrl: creds.baseUrl,
    method: "GET", // READ-ONLY — this module never issues another method
    path: `${READBACK_PATH}?${qs}`,
  });
  if ("ok" in r) return { ok: false, message: r.message };
  if (r.status !== 200) return { ok: false, message: beds24Fail(mapErrorStatus(r.status), r.status).message };
  const root = asObj(r.body);
  if (root?.success === false) return { ok: false, message: beds24Fail("bad_response", r.status).message };
  const parsed = parseBeds24CalendarBody(r.body);
  return { ok: true, entries: parsed.entries, nextPageExists: parsed.nextPageExists };
}

/**
 * Compare what Beds24 HOLDS against what we intend it to hold, for the next
 * BEDS24_READBACK_DAYS days, and alert on any difference. Never writes to
 * Beds24. Never throws into the worker: a transport failure is a recorded
 * error, not a failed reconcile job (the booking half of that job must not be
 * marked failed because a read-back page timed out).
 */
export async function runBeds24AriReadback(
  db: Sql,
  conn: Beds24AriConnection,
  jobId?: string | null,
): Promise<Beds24ReadbackSummary> {
  const summary = emptySummary();

  const [tenant] = await db<{ timezone: string | null }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${conn.tenant_id}`;
  const from = todayInTz(tenant?.timezone || "Asia/Jerusalem");
  const toInclusive = addDays(from, BEDS24_READBACK_DAYS - 1);
  const toExclusive = addDays(from, BEDS24_READBACK_DAYS);

  const mappings = toBeds24BuilderMappings(await loadBeds24Mappings(db, conn.id));
  if (mappings.length === 0) return summary; // nothing published ⇒ nothing to compare
  summary.rooms = mappings.length;

  // the expected side is the EXACT payload the push would build — not a second
  // opinion about it. A projection change moves both halves together.
  const projection = await projectBeds24Ari(db, {
    tenantId: conn.tenant_id, connectionId: conn.id,
    dateFrom: from, dateTo: toExclusive,
    roomIds: mappings.map((m) => m.roomId),
  });
  const built = buildBeds24CalendarRequests(projection, mappings);
  const expected = expandBeds24Calendar(expectedEntriesOf(built.requests), { from, toInclusive });
  summary.comparedCells = expected.size;
  if (expected.size === 0) return summary;

  const access = await getBeds24AccessToken(db, conn);
  if (!access.ok) {
    summary.errors.push(access.error);
    return summary;
  }
  const creds = { token: access.token, baseUrl: beds24BaseUrl() };

  const beds24RoomIds = [...new Set(
    built.requests.flat().map((e) => e.roomId),
  )].sort((a, b) => a - b);

  const remoteEntries: RawRoomEntry[] = [];
  for (let page = 1; page <= BEDS24_READBACK_MAX_REQUESTS; page++) {
    const res = await fetchCalendarPage(creds, { beds24RoomIds, from, toInclusive, page });
    summary.requests += 1;
    if (!res.ok) {
      summary.errors.push(res.message);
      break;
    }
    remoteEntries.push(...res.entries);
    if (!res.nextPageExists) break;
    if (page === BEDS24_READBACK_MAX_REQUESTS) summary.truncated = true;
  }

  if (summary.errors.length > 0 && remoteEntries.length === 0) {
    await alertOnce(db, conn, {
      code: "ari_readback_failed",
      message: "בדיקת ההשוואה מול Beds24 נכשלה — לא ניתן לאמת שהמלאי המפורסם מעודכן",
      dateFrom: from, dateTo: toInclusive,
      context: { rooms: summary.rooms, requests: summary.requests },
    });
    await recordReadbackEvidence(db, conn, jobId ?? null, summary, from, toInclusive, "failed");
    return summary;
  }

  const remote = expandBeds24Calendar(remoteEntries, { from, toInclusive });
  summary.drift = diffBeds24Calendar(expected, remote);
  summary.driftCells = summary.drift.length;
  summary.oversellCells = summary.drift.filter((d) => d.oversell).length;

  if (summary.driftCells > 0) {
    const oversell = summary.oversellCells;
    await alertOnce(db, conn, {
      code: oversell > 0 ? "ari_readback_oversell" : "ari_readback_drift",
      message:
        oversell > 0
          ? `Beds24 מוכר ${oversell} לילות שתפוסים אצלנו — סכנת overbooking; הרץ סנכרון מלא`
          : `נמצאו ${summary.driftCells} הפרשים בין המלאי שפורסם ל-Beds24 לבין המצב אצלנו`,
      dateFrom: from, dateTo: toInclusive,
      context: {
        rooms: summary.rooms, days: summary.days,
        compared_cells: summary.comparedCells,
        drift_cells: summary.driftCells,
        oversell_cells: summary.oversellCells,
        truncated: summary.truncated,
        sample: summary.drift.slice(0, SAMPLE_LIMIT),
      },
    });
  }

  await recordReadbackEvidence(
    db, conn, jobId ?? null, summary, from, toInclusive,
    summary.driftCells > 0 || summary.errors.length > 0 ? "partial" : "success",
  );
  return summary;
}

async function recordReadbackEvidence(
  db: Sql,
  conn: Beds24AriConnection,
  jobId: string | null,
  summary: Beds24ReadbackSummary,
  from: DateOnly,
  toInclusive: DateOnly,
  outcome: EvidenceOutcome,
): Promise<void> {
  await recordAriEvidence(db, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    environment: conn.environment,
    scenarioKey: "ari_readback",
    kind: "calendar",
    uiWorkflow: "worker → reconcile_inventory (ARI read-back)",
    firingFile: "src/lib/channel/beds24-ari-readback.ts",
    firingFunction: "runBeds24AriReadback",
    requestCount: summary.requests,
    dateFrom: from,
    dateTo: toInclusive,
    outcome,
    errorCode: summary.oversellCells > 0
      ? "ari_readback_oversell"
      : summary.driftCells > 0
        ? "ari_readback_drift"
        : summary.errors.length > 0
          ? "ari_readback_failed"
          : null,
    errorMessage: summary.errors[0] ?? null,
    jobId,
    context: {
      rooms: summary.rooms,
      days: summary.days,
      comparedCells: summary.comparedCells,
      driftCells: summary.driftCells,
      oversellCells: summary.oversellCells,
      truncated: summary.truncated,
      sample: summary.drift.slice(0, SAMPLE_LIMIT),
    },
  });
}
