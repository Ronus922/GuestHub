import "server-only";
import type { Sql } from "postgres";
import { addDays, todayInTz, type DateOnly } from "@/lib/dates";
import { beds24BaseUrl } from "./config";
import { getBeds24AccessToken } from "./beds24-token";
import { beds24Request, beds24Fail, mapErrorStatus, type RawResponseEvidence } from "./beds24-http";
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
// STRICTLY READ-ONLY TOWARDS BEDS24 — DETECT AND ALERT, NEVER CORRECT.
// The module still never corrects Beds24 state and never writes a dirty range,
// a mapping or a connection field. What it DOES now write is the lifecycle of
// its OWN alert rows in guesthub.channel_sync_errors: it refreshes the open
// ari_readback_* row each cycle (occurrence_count, last_seen_at, message,
// context, window) and RESOLVES it on a clean cycle. That is bookkeeping about
// its own alarm, not a correction of the drift it found — the correction is
// still the operator's decision (Full Sync / drain), never an automatic write
// triggered by a read.
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
  /** THE overbooking signature: the room is PHYSICALLY taken (occupied here, or
   *  closed out of inventory) and Beds24 is still selling it. A real bed. */
  oversell: boolean;
  /** we publish 0 for a COMMERCIAL reason only — stop-sell, or no sellable
   *  price — and Beds24 sells anyway. Money, not a double-booking. */
  commercialBlock: boolean;
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
//
// WHY THE CAUSE MATTERS. `numAvail: 0` is one wire value with two very
// different meanings on our side, and beds24-ari-payloads.ts is where they get
// flattened: available = physicallyAvailable && !stopSell && !blocked. So a
// cell Beds24 still sells is EITHER a bed somebody is already sleeping in (or a
// room we took out of inventory) — a genuine overbooking risk — OR a date we
// merely declined to sell: stop-sell, or no resolvable price. Calling both
// "overbooking" cried wolf on the second kind, which is the loudest way to
// train an operator to ignore the first. `physicalAvail` un-flattens it: the
// SAME `availability` half of the projection the payload builder read, keyed by
// (beds24RoomId|date).
//
// FAIL LOUD, in both directions of ignorance:
//   · a key MISSING from the map is physically unavailable — the exact `?? 0`
//     the payload builder applies, so the two halves cannot disagree.
//   · the map ABSENT entirely (a caller with no projection in hand) means the
//     cause is unknowable, and an unknown cause is reported as the dangerous
//     one. Never the quiet one.
export function diffBeds24Calendar(
  expected: Map<string, Beds24DayCell>,
  remote: Map<string, Beds24DayCell>,
  physicalAvail?: ReadonlyMap<string, number>,
): Beds24Drift[] {
  const drift: Beds24Drift[] = [];
  for (const [key, want] of expected) {
    const got = remote.get(key);
    if (!got || got.numAvail === null) {
      drift.push({
        beds24RoomId: want.beds24RoomId, date: want.date, kind: "missing",
        expected: want.numAvail, remote: null,
        // no statement at the provider is not proof it is selling — but it is
        // not proof it is closed either. Never counted as a confirmed oversell,
        // and never as a commercial gap either: a partial page is not evidence.
        oversell: false, commercialBlock: false,
      });
      continue;
    }
    if (got.numAvail !== want.numAvail) {
      const stillSelling = want.numAvail === 0 && got.numAvail > 0;
      // absent map ⇒ unknowable cause ⇒ the dangerous reading (see above)
      const physicallyTaken =
        physicalAvail === undefined || (physicalAvail.get(key) ?? 0) === 0;
      drift.push({
        beds24RoomId: want.beds24RoomId, date: want.date, kind: "availability",
        expected: want.numAvail, remote: got.numAvail,
        oversell: stillSelling && physicallyTaken,
        commercialBlock: stillSelling && !physicallyTaken,
      });
    }
    if (want.price1 !== null && (got.price1 === null || Math.abs(got.price1 - want.price1) > 0.005)) {
      drift.push({
        beds24RoomId: want.beds24RoomId, date: want.date, kind: "price",
        expected: want.price1, remote: got.price1,
        oversell: false, commercialBlock: false,
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
  /** drift cells where a PHYSICALLY taken room is still on sale at Beds24 */
  oversellCells: number;
  /** drift cells we closed for a COMMERCIAL reason only (stop-sell / no price)
   *  and Beds24 sells anyway — a revenue/policy gap, not a double-booking */
  commercialBlockCells: number;
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
  driftCells: 0, oversellCells: 0, commercialBlockCells: 0,
  truncated: false, drift: [], errors: [],
});

// One unresolved alert per (connection, code): the cycle repeats every
// RECONCILE_MINUTES and a drift persists until an operator acts, so re-logging
// every cycle would push the 10-row /channels error list into a single repeating
// message and bury everything else. The per-cycle detail still lands in the
// append-only evidence ledger, which is the trail, not the alarm.
//
// 086 — the suppression used to be SILENCE: the second sighting and the
// three-hundredth were both a no-op, so the row froze at its first message,
// its first window and its first timestamp. An operator reading a row created
// two weeks ago could not tell whether the condition fired once or is firing
// right now, and the counts in `context` were whatever the FIRST cycle saw.
// The row is now REFRESHED instead: same one row per (connection, code) — the
// list still cannot flood — carrying the CURRENT message, context and window,
// a sighting counter and the last-seen timestamp.
async function alertOnce(
  db: Sql,
  conn: Beds24AriConnection,
  e: {
    code: string; message: string; dateFrom: DateOnly; dateTo: DateOnly; context: unknown;
    /** D112 — the response that failed the read-back, verbatim, when one exists */
    raw?: RawResponseEvidence | null;
  },
): Promise<void> {
  const [existing] = await db<{ id: string }[]>`
    SELECT id FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${conn.tenant_id} AND connection_id = ${conn.id}
      AND error_code = ${e.code} AND resolved_at IS NULL
    LIMIT 1`;
  if (existing) {
    // the raw provider evidence is refreshed too, INCLUDING back to NULL: a
    // drift cycle that follows a failed one must not leave the failure's body
    // standing next to a message that no longer describes it (D112).
    await db`
      UPDATE guesthub.channel_sync_errors
      SET occurrence_count     = occurrence_count + 1,
          last_seen_at         = now(),
          error_message        = ${e.message},
          context              = ${db.json((e.context ?? {}) as never)},
          date_from            = ${e.dateFrom},
          date_to              = ${e.dateTo},
          http_status          = ${e.raw?.httpStatus ?? null},
          response_body        = ${e.raw?.body ?? null},
          response_truncated   = ${e.raw?.truncated ?? false},
          response_received_at = ${e.raw?.receivedAt ?? null}
      WHERE id = ${existing.id}`;
    return;
  }
  await logChannelError(db, {
    tenantId: conn.tenant_id, connectionId: conn.id,
    dateFrom: e.dateFrom, dateTo: e.dateTo,
    code: e.code, message: e.message, context: e.context,
    httpStatus: e.raw?.httpStatus ?? null,
    responseBody: e.raw?.body ?? null,
    responseTruncated: e.raw?.truncated ?? false,
    responseReceivedAt: e.raw?.receivedAt ?? null,
  });
  // first sighting: last_seen_at IS created_at. Left to the INSERT's own
  // now() rather than a second write, so the two can never disagree.
  await db`
    UPDATE guesthub.channel_sync_errors
    SET last_seen_at = created_at
    WHERE tenant_id = ${conn.tenant_id} AND connection_id = ${conn.id}
      AND error_code = ${e.code} AND resolved_at IS NULL AND last_seen_at IS NULL`;
}

// The other half of the lifecycle. A read-back alert describes a condition the
// NEXT clean cycle disproves, so leaving it open until somebody remembers to
// close it by hand made the /channels list report problems that no longer
// existed — and a list known to be stale stops being read.
//
// SCOPE, deliberately narrow: only this connection, and only the codes this
// module itself raises (ari_readback_%). A clean read-back proves the published
// calendar matches for THIS connection's 14-day window and nothing else; it is
// no evidence at all about an import failure, a token error on another
// connection, or any other producer's row. Closing those would be a lie the
// operator has no way to notice.
async function resolveReadbackAlerts(db: Sql, conn: Beds24AriConnection): Promise<void> {
  await db`
    UPDATE guesthub.channel_sync_errors
    SET resolved_at = now()
    WHERE tenant_id = ${conn.tenant_id} AND connection_id = ${conn.id}
      AND error_code LIKE 'ari_readback_%'
      AND resolved_at IS NULL`;
}

/** ONE page of the read-back. GET only — the sole network call of this module. */
async function fetchCalendarPage(
  creds: { token: string; baseUrl: string },
  args: { beds24RoomIds: number[]; from: DateOnly; toInclusive: DateOnly; page: number },
): Promise<
  | { ok: true; entries: RawRoomEntry[]; nextPageExists: boolean }
  | { ok: false; message: string; raw: RawResponseEvidence | null }
> {
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
  // D112 — this helper used to keep only a fixed message and drop status+body.
  // The failure now carries the verbatim response for the alert to persist.
  if ("ok" in r) return { ok: false, message: r.message, raw: r.raw ?? null };
  if (r.status !== 200) {
    return { ok: false, message: beds24Fail(mapErrorStatus(r.status), r.status, r.raw).message, raw: r.raw };
  }
  const root = asObj(r.body);
  if (root?.success === false) {
    return { ok: false, message: beds24Fail("bad_response", r.status, r.raw).message, raw: r.raw };
  }
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
    // Until 086 this returned in silence: the cycle recorded the error on a
    // summary the worker discards, wrote no ledger row and raised no alert, so
    // a connection whose token stopped refreshing simply STOPPED being compared
    // and looked exactly like a connection with nothing to report. That is the
    // one failure mode this module exists to make impossible — an unverified
    // published calendar that nobody knows is unverified.
    //
    // The two exits above stay silent on purpose and are NOT the same thing:
    // no mappings and no expected cells mean there is nothing published to
    // compare, which is a true "nothing to report", not a failure to look.
    summary.errors.push(access.error);
    await alertOnce(db, conn, {
      code: "ari_readback_failed",
      message: "בדיקת ההשוואה מול Beds24 נכשלה — לא ניתן לאמת שהמלאי המפורסם מעודכן",
      dateFrom: from, dateTo: toInclusive,
      context: { rooms: summary.rooms, requests: summary.requests, stage: "token" },
      raw: null,
    });
    await recordReadbackEvidence(db, conn, jobId ?? null, summary, from, toInclusive, "failed");
    return summary;
  }
  const creds = { token: access.token, baseUrl: beds24BaseUrl() };

  const beds24RoomIds = [...new Set(
    built.requests.flat().map((e) => e.roomId),
  )].sort((a, b) => a - b);

  const remoteEntries: RawRoomEntry[] = [];
  let failureRaw: RawResponseEvidence | null = null;
  for (let page = 1; page <= BEDS24_READBACK_MAX_REQUESTS; page++) {
    const res = await fetchCalendarPage(creds, { beds24RoomIds, from, toInclusive, page });
    summary.requests += 1;
    if (!res.ok) {
      summary.errors.push(res.message);
      failureRaw = res.raw;
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
      raw: failureRaw,
    });
    await recordReadbackEvidence(db, conn, jobId ?? null, summary, from, toInclusive, "failed");
    return summary;
  }

  const remote = expandBeds24Calendar(remoteEntries, { from, toInclusive });
  // the physical half of the SAME projection the payload builder flattened,
  // re-keyed onto the wire (beds24RoomId|date) so the diff can say WHY we
  // published 0. No new query: `projection` is already in hand.
  const physicalAvail = new Map<string, number>();
  for (const m of mappings) {
    const beds24RoomId = Number(m.beds24RoomId);
    if (!Number.isInteger(beds24RoomId) || beds24RoomId <= 0) continue;
    for (const a of projection.availability) {
      if (a.roomId !== m.roomId) continue;
      physicalAvail.set(`${beds24RoomId}|${a.date}`, a.availability);
    }
  }
  summary.drift = diffBeds24Calendar(expected, remote, physicalAvail);
  summary.driftCells = summary.drift.length;
  summary.oversellCells = summary.drift.filter((d) => d.oversell).length;
  summary.commercialBlockCells = summary.drift.filter((d) => d.commercialBlock).length;

  if (summary.driftCells > 0) {
    const oversell = summary.oversellCells;
    const commercial = summary.commercialBlockCells;
    // ONE code and ONE message per cycle, picked by the WORST thing found. A
    // cycle holding both kinds is an overbooking cycle: the commercial gap is
    // real but it can wait, and merging the two into one hedged sentence would
    // make the urgent half unreadable. The exact split always travels in the
    // context, so nothing is lost by leading with the danger.
    await alertOnce(db, conn, {
      code:
        oversell > 0
          ? "ari_readback_oversell"
          : commercial > 0
            ? "ari_readback_commercial"
            : "ari_readback_drift",
      message:
        oversell > 0
          ? `Beds24 מוכר ${oversell} לילות שתפוסים/סגורים אצלנו — סכנת overbooking`
          : commercial > 0
            ? `Beds24 מוכר ${commercial} לילות שחסומים אצלנו מסחרית (stop-sell או ללא מחיר) — פער מסחרי, לא סכנת double-booking`
            : `נמצאו ${summary.driftCells} הפרשים בין המלאי שפורסם ל-Beds24 לבין המצב אצלנו`,
      dateFrom: from, dateTo: toInclusive,
      context: {
        rooms: summary.rooms, days: summary.days,
        compared_cells: summary.comparedCells,
        drift_cells: summary.driftCells,
        oversell_cells: summary.oversellCells,
        commercial_block_cells: summary.commercialBlockCells,
        truncated: summary.truncated,
        sample: summary.drift.slice(0, SAMPLE_LIMIT),
      },
    });
  } else if (summary.requests > 0 && summary.errors.length === 0 && summary.comparedCells > 0) {
    // THE clean cycle, and the only place an alert may be closed: cells were
    // actually compared, at least one request actually went out, no transport
    // error occurred, and the diff came back empty. Every weaker version of
    // this predicate closes on ignorance — a partial page (errors + some
    // entries) reaches the diff with `missing` cells and therefore never gets
    // here, and the failed and silent exits returned long before.
    await resolveReadbackAlerts(db, conn);
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
    // the SAME precedence the operator alert uses — the ledger must not
    // categorise a cycle differently from the alarm it raised for it.
    errorCode: summary.oversellCells > 0
      ? "ari_readback_oversell"
      : summary.commercialBlockCells > 0
        ? "ari_readback_commercial"
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
      commercialBlockCells: summary.commercialBlockCells,
      truncated: summary.truncated,
      sample: summary.drift.slice(0, SAMPLE_LIMIT),
    },
  });
}
