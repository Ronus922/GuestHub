import "server-only";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { beds24BaseUrl } from "./config";
import { asObj } from "./channel-http";
import {
  beds24Fail,
  beds24Request,
  mapErrorStatus,
  type Beds24ApiFailure,
  type Beds24ReqOpts,
} from "./beds24-http";
import { getBeds24AccessToken } from "./beds24-token";
import { importNormalizedRevision, type RoomResolver } from "./booking-import";
import {
  beds24BookingIdentity,
  normalizeBeds24Booking,
  type Beds24NormalizeResult,
  type Beds24RoomMapping,
} from "./beds24-normalize";
import type { NormalizedRevision } from "./booking-normalize";
import { quarantineRevision } from "./revisions";
import { redactPayload } from "./payloads";
import { logChannelError } from "./queue";
import {
  createBeds24CreditGate, beds24CreditPauseMessage,
  type Beds24CreditGate, type Beds24CreditPause, type Beds24CreditSnapshot,
} from "./beds24-credits";
import { ARI_HORIZON_DAYS } from "./ranges";
import { dispatchExternalChangeEmails } from "./external-changes";

// ============================================================
// Beds24 inbound booking import (D78/D79) — bookings → GuestHub reservations
// through the shared post-normalize core (importNormalizedRevision),
// with the two provider-specific halves supplied here: the Beds24 normalizer
// and a room resolver over channel_beds24_room_mappings (D77).
//
// Beds24 has NO revisions feed and NO ack endpoint: each fetched booking
// persists into channel_booking_revisions under a SYNTHETIC revision id
//   "{id}:{modifiedTime}"          (modifiedTime = Beds24's own change stamp)
//   "{id}:{sha256(payload)[0:16]}" (fallback when modifiedTime is missing)
// so the existing UNIQUE (connection_id, provider_revision_id) makes a re-poll
// of an unchanged booking a no-op (0 inserts), and any upstream change
// naturally lands as a NEW revision row → the D76 modified path. Rows insert
// pre-acknowledged (ack semantics do not exist upstream).
//
// Pull model (POLL-ONLY for now — Beds24 webhooks are a later step; the 5-min
// fallback loop covers latency): the incremental key is `modifiedFrom`
// (now − 7 days, generous overlap). A connection that has NEVER imported
// (last_inbound_import_at NULL) additionally walks a full arrival window
// (today−30d → today+ARI_HORIZON_DAYS) so the backlog lands on first run.
// Both pulls are idempotent by the synthetic-id UNIQUE above.
//
// Convergence: newly-inserted rows import immediately; a bounded sweep then
// re-imports rows still pending/quarantined/failed (crash between insert and
// import, or a mapping fixed since) — the Beds24 analogue of a channel feed
// re-serving unacknowledged revisions every pull.
// ============================================================

export type Beds24InboundConnection = {
  id: string;
  tenant_id: string;
  /** the encrypted REFRESH token (long-life) */
  api_key_ciphertext: string;
  /** 24h access-token cache (encrypted); NULL = no cache yet */
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | string | null;
  /** NULL = this connection has never imported → first-run full window */
  last_inbound_import_at: Date | string | null;
};

export type Beds24InboundPullSummary = {
  fetched: number;
  inserted: number;
  imported: number;
  quarantined: number;
  failed: number;
  /** sanitized error messages (bounded) — never an upstream body */
  errors: string[];
  /** P0-4 — the newest Beds24 credit meter this pull saw (the /channels
   *  diagnostics reads it off the job row; the poll runs every 5 minutes, so
   *  it is the freshest credit reading the system has) */
  credits: Beds24CreditSnapshot | null;
  /** set when the credit window (or a 429) cut the page walk short */
  creditPause: Beds24CreditPause | null;
};

const MAX_PAGES = 50; // hard bound — never an unbounded pagination loop
// EVERY status is requested EXPLICITLY on the window pulls. Beds24's GET
// /bookings default silently EXCLUDES cancelled bookings — that hid OTA
// cancellations from the import entirely (reservation 1021 stayed occupying
// after its Booking.com cancellation). The list is a superset of the default,
// so nothing that used to arrive is lost; cancelled now arrives too and flows
// through the existing applyCancellation path. NOTE: Beds24 rejects a CSV
// value (`status=a,b` → HTTP 400) — REPEATED params are the only accepted
// form. The targeted by-id pull needs none of this: an id fetch returns the
// booking in any status.
export const BEDS24_STATUS_FILTER = ["confirmed", "new", "request", "cancelled", "black", "inquiry"]
  .map((s) => `status=${s}`)
  .join("&");
// incremental pull key: bookings MODIFIED in the last 7 days (generous
// overlap over the 5-minute poll loop — absorbs downtime and clock skew)
const LOOKBACK_DAYS = 7;
// first-run backfill window: arrivals from a month back out to the one
// forward horizon the channel layer speaks (ranges.ts)
const BACKFILL_PAST_DAYS = 30;
const FORWARD_DAYS = ARI_HORIZON_DAYS;
const SWEEP_LIMIT = 200;
const MAX_ERRORS = 20;

// Loads the inbound connections for the beds24 provider — the
// worker's provider dispatch seam (D77/D78) selects by these. 'ready' is a
// valid inbound state for Beds24 (mapping exists before the first full sync).
export async function loadBeds24InboundConnections(
  db: Sql,
): Promise<Beds24InboundConnection[]> {
  return db<Beds24InboundConnection[]>`
    SELECT id, tenant_id, api_key_ciphertext,
           access_token_ciphertext, access_token_expires_at, last_inbound_import_at
    FROM guesthub.channel_connections
    WHERE provider = 'beds24' AND is_active_provider = true
      AND state IN ('ready', 'active')
      AND inbound_sync_enabled = true AND api_key_ciphertext IS NOT NULL
      -- review W-1: an inbound-enabled connection whose every room got
      -- unmapped must stop being polled (a pull with zero mappings would
      -- error → retry → dead-letter every 5-minute window, forever)
      AND EXISTS (
        SELECT 1 FROM guesthub.channel_beds24_room_mappings m
        WHERE m.connection_id = channel_connections.id AND m.status = 'mapped')`;
}

// ---------------------------------------------------------------
// bookings client (mirrors beds24-properties.ts style: envelope-only
// validation here, payloads handed onward verbatim)
// ---------------------------------------------------------------

type BookingsPage = {
  ok: true;
  bookings: unknown[];
  /** pages.nextPageExists when the envelope carries one */
  nextPageExists: boolean;
  /** the 5-minute credit meter this page reported */
  credits: Beds24CreditSnapshot;
};

// GET /bookings with the given pre-encoded filter string. Envelope mirrors
// /properties: { success, data: [...], pages: { nextPageExists } } — probed
// defensively (a bare array body is also accepted; success:false on a 200 is
// a bad response).
async function fetchBookingsPage(
  opts: Beds24ReqOpts,
  filters: string,
  page: number,
): Promise<BookingsPage | Beds24ApiFailure> {
  const path =
    `/bookings?${filters}` +
    `&includeGuests=true&includeInvoiceItems=true&page=${page}`;
  const res = await beds24Request({ ...opts, method: "GET", path });
  if ("ok" in res) return res;
  if (res.status !== 200) {
    const f = beds24Fail(mapErrorStatus(res.status), res.status);
    // P0-4 — a 429 carries its own cooldown forward (Retry-After, else the
    // credit window's resets-in); the page walker turns it into a real pause.
    return res.retryAfterMs !== undefined
      ? { ...f, retryAfterMs: res.retryAfterMs, credits: res.credits }
      : { ...f, credits: res.credits };
  }
  const root = asObj(res.body);
  if (root && root.success === false) return beds24Fail("bad_response", res.status);
  const data = root?.data ?? res.body;
  if (!Array.isArray(data)) return beds24Fail("bad_response", res.status);
  return {
    ok: true,
    bookings: data,
    nextPageExists: asObj(root?.pages)?.nextPageExists === true,
    credits: res.credits,
  };
}

// ---------------------------------------------------------------
// persistence — synthetic revision rows, pre-acknowledged
// ---------------------------------------------------------------

// The synthetic revision identity: modifiedTime is Beds24's own change stamp
// (re-stamped on every upstream edit), so "{id}:{modifiedTime}" is the natural
// revision key. When it is missing, a content hash of the payload keys the
// revision instead — an unchanged payload stays a no-op either way.
export function beds24RevisionId(
  bookingId: string,
  modifiedTime: string | null,
  payload: unknown,
): string {
  if (modifiedTime) return `${bookingId}:${modifiedTime}`;
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `${bookingId}:${digest.slice(0, 16)}`;
}

// Idempotent insert with the Beds24 specifics: ack columns pre-set (no ack semantics upstream)
// and NO card staging — Beds24 booking payloads are fetched without card data
// (cards need a dedicated scope + endpoint that this import never requests).
// The stored payload is still redacted for hygiene.
async function insertRevisionRow(
  db: Sql,
  conn: Beds24InboundConnection,
  rev: {
    providerBookingId: string;
    providerRevisionId: string;
    otaReservationCode: string | null;
    otaName: string | null;
    revisionKind: "new" | "modified" | "cancelled";
    rawStatus: string | null;
    payload: unknown;
  },
): Promise<string | null> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id,
       ota_reservation_code, ota_name, revision_kind, raw_status,
       payload, import_status, ack_status, acknowledged_at)
    VALUES
      (${conn.tenant_id}, ${conn.id}, ${rev.providerBookingId}, ${rev.providerRevisionId},
       ${rev.otaReservationCode}, ${rev.otaName},
       ${rev.revisionKind}, ${rev.rawStatus},
       ${db.json(redactPayload(rev.payload) as never)},
       'pending', 'acknowledged', now())
    ON CONFLICT (connection_id, provider_revision_id) DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------
// import — normalize (provider half) → shared core
// ---------------------------------------------------------------

function beds24RoomResolver(conn: Beds24InboundConnection): RoomResolver {
  return async (db, room) => {
    // the room's externalRoomId slot carries the Beds24 room id
    // (in-memory convention, beds24-normalize.ts)
    const [mapping] = await db<{ room_id: string }[]>`
      SELECT room_id FROM guesthub.channel_beds24_room_mappings
      WHERE connection_id = ${conn.id}
        AND beds24_room_id = ${room.externalRoomId}
        AND status = 'mapped'`;
    return mapping
      ? { roomId: mapping.room_id }
      : { error: `חדר Beds24 ללא מיפוי לחדר מקומי (${room.externalRoomId})` };
  };
}

function pushError(summary: { errors: string[] }, message: string): void {
  if (summary.errors.length < MAX_ERRORS) summary.errors.push(message);
}

// Import ONE persisted revision row through the shared core. The Beds24
// room-ownership guard lives HERE (the wrong-property
// rejection in importRevisionRow): a booking whose Beds24 room id has no
// 'mapped' row in channel_beds24_room_mappings is visibly parked and
// recorded — never imported into this tenant.
async function importRevisionRowBeds24(
  db: Sql,
  conn: Beds24InboundConnection,
  resolveRoom: RoomResolver,
  mappings: ReadonlyMap<string, Beds24RoomMapping>,
  row: { id: string; provider_revision_id: string; payload: unknown },
  summary: Beds24InboundPullSummary,
  preNormalized?: Beds24NormalizeResult,
): Promise<void> {
  const norm = preNormalized ?? normalizeBeds24Booking(row.payload, mappings);
  if (!norm.ok) {
    await quarantineRevision(db, row.id, norm.error);
    if (norm.unmappedRoomId) {
      await logChannelError(db, {
        tenantId: conn.tenant_id,
        connectionId: conn.id,
        code: "unmapped_room",
        message: norm.error,
        context: {
          revision_id: row.provider_revision_id,
          beds24_room_id: norm.unmappedRoomId,
        },
      });
    }
    summary.quarantined += 1;
    pushError(summary, norm.error);
    return;
  }

  // the durable row's synthetic id becomes the revision identity everywhere
  // downstream (external_revision_id, audits, date-change records)
  const normalized: NormalizedRevision = {
    ...norm.value,
    revisionId: row.provider_revision_id,
  };
  const outcome = await importNormalizedRevision(db, conn, row.id, normalized, { resolveRoom });
  if (outcome.status === "imported" || outcome.status === "already") {
    summary.imported += 1;
  } else if (outcome.status === "quarantined") {
    summary.quarantined += 1;
    pushError(summary, outcome.reason);
  } else {
    summary.failed += 1;
    pushError(summary, outcome.error);
  }
}

async function processBooking(
  db: Sql,
  conn: Beds24InboundConnection,
  resolveRoom: RoomResolver,
  mappings: ReadonlyMap<string, Beds24RoomMapping>,
  payload: unknown,
  summary: Beds24InboundPullSummary,
  processedRowIds: Set<string>,
): Promise<void> {
  const identity = beds24BookingIdentity(payload);
  if (!identity.bookingId) {
    // no booking identity at all — nothing durable can be keyed to it
    summary.failed += 1;
    const message = "הזמנה מ-Beds24 ללא מזהה — לא ניתן לשמור";
    pushError(summary, message);
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: "inbound_normalize_failed",
      message,
    });
    return;
  }

  const providerRevisionId = beds24RevisionId(
    identity.bookingId,
    identity.modifiedTime,
    payload,
  );
  const norm = normalizeBeds24Booking(payload, mappings);
  const rowId = await insertRevisionRow(db, conn, {
    providerBookingId: identity.bookingId,
    providerRevisionId,
    otaReservationCode: norm.ok ? norm.value.otaReservationCode : identity.otaReservationCode,
    otaName: norm.ok ? norm.value.otaName : identity.otaName,
    revisionKind: norm.ok ? norm.value.kind : "new",
    rawStatus: identity.rawStatus,
    payload,
  });
  if (!rowId) return; // duplicate — unchanged booking, idempotent no-op

  summary.inserted += 1;
  processedRowIds.add(rowId);
  await importRevisionRowBeds24(
    db,
    conn,
    resolveRoom,
    mappings,
    { id: rowId, provider_revision_id: providerRevisionId, payload },
    summary,
    norm,
  );
}

// Bounded convergence sweep — rows still pending (crash between insert and
// import), quarantined (mapping may have been fixed) or failed (transient),
// excluding rows already processed this run. Re-normalizes from the STORED
// redacted payload; scoped to THIS
// connection's rows only.
async function sweepUnimportedRows(
  db: Sql,
  conn: Beds24InboundConnection,
  resolveRoom: RoomResolver,
  mappings: ReadonlyMap<string, Beds24RoomMapping>,
  summary: Beds24InboundPullSummary,
  processedRowIds: Set<string>,
): Promise<void> {
  const rows = await db<{ id: string; provider_revision_id: string; payload: unknown }[]>`
    SELECT id, provider_revision_id, payload
    FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${conn.id}
      AND import_status IN ('pending', 'quarantined', 'failed')
    ORDER BY created_at
    LIMIT ${SWEEP_LIMIT}`;
  for (const row of rows) {
    if (processedRowIds.has(row.id)) continue;
    await importRevisionRowBeds24(db, conn, resolveRoom, mappings, row, summary);
  }
}

// The mapping snapshot for one pull: beds24_room_id → local room (the
// normalizer's quarantine gate) plus the distinct Beds24 property ids that
// scope every /bookings call — a propertyId-less list call would pull the
// whole Beds24 account.
async function loadRoomMappings(
  db: Sql,
  conn: Beds24InboundConnection,
): Promise<{ byRoomId: Map<string, Beds24RoomMapping>; propertyIds: string[] }> {
  const rows = await db<{ beds24_room_id: string; beds24_property_id: string; room_id: string }[]>`
    SELECT beds24_room_id, beds24_property_id, room_id
    FROM guesthub.channel_beds24_room_mappings
    WHERE connection_id = ${conn.id} AND status = 'mapped'`;
  return {
    byRoomId: new Map(rows.map((r) => [r.beds24_room_id, { roomId: r.room_id }])),
    propertyIds: [...new Set(rows.map((r) => r.beds24_property_id))],
  };
}

const isoDate = (msFromToday: number): string =>
  new Date(Date.now() + msFromToday).toISOString().slice(0, 10);

// Beds24 accepts ISO 8601 datetimes; seconds precision without the trailing
// "Z" matches the documented examples. The 7-day overlap absorbs any timezone
// interpretation difference upstream.
const isoDateTime = (msFromNow: number): string =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19);

// One filtered window walk — shared by the incremental and the first-run
// pulls. A failed page aborts THIS window only (the error is surfaced).
async function pullWindow(
  db: Sql,
  conn: Beds24InboundConnection,
  creds: Beds24ReqOpts,
  filters: string,
  resolveRoom: RoomResolver,
  mappings: ReadonlyMap<string, Beds24RoomMapping>,
  summary: Beds24InboundPullSummary,
  processedRowIds: Set<string>,
  gate: Beds24CreditGate,
): Promise<void> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    // P0-4 — the credit window closed on an earlier page: walk no further.
    // MAX_PAGES is 50; at the measured 1.2 credits/call a blind walk is 60
    // credits, 60% of the whole 5-minute window, in one job.
    if (gate.pause) {
      pushError(summary, beds24CreditPauseMessage(gate.pause));
      break;
    }
    const res = await fetchBookingsPage(creds, filters, page);
    const rateLimited = "ok" in res && res.ok === false && res.category === "rate_limited";
    gate.observe(res.credits, {
      ...(rateLimited ? { httpStatus: 429 } : {}),
      ...(rateLimited && res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
    });
    summary.credits = gate.last;
    summary.creditPause = gate.pause;
    if (!res.ok) {
      pushError(summary, gate.pause ? beds24CreditPauseMessage(gate.pause) : res.message);
      break;
    }
    for (const booking of res.bookings) {
      summary.fetched += 1;
      await processBooking(db, conn, resolveRoom, mappings, booking, summary, processedRowIds);
    }
    if (!res.nextPageExists || res.bookings.length === 0) break;
  }
}

// ---------------------------------------------------------------
// the pull — GET → persist (synthetic id) → import via the shared core
// ---------------------------------------------------------------

export async function runBeds24InboundPull(
  db: Sql,
  conn: Beds24InboundConnection,
  opts?: { bookingId?: string },
): Promise<Beds24InboundPullSummary> {
  const summary: Beds24InboundPullSummary = {
    fetched: 0,
    inserted: 0,
    imported: 0,
    quarantined: 0,
    failed: 0,
    errors: [],
    credits: null,
    creditPause: null,
  };
  const { byRoomId: mappings, propertyIds } = await loadRoomMappings(db, conn);
  const resolveRoom = beds24RoomResolver(conn);
  const processedRowIds = new Set<string>();
  // ONE gate per pull: every page of every window observes the same meter, so
  // the second window can never restart spending after the first one paused.
  const gate = createBeds24CreditGate();

  if (mappings.size === 0) {
    // without a single mapped room, nothing can import — and a propertyId-less
    // list call would pull the whole account
    pushError(summary, "אין חדרי Beds24 ממופים לחיבור זה");
    return summary;
  }

  const access = await getBeds24AccessToken(db, conn);
  if (!access.ok) {
    pushError(summary, access.error);
    return summary;
  }
  const creds: Beds24ReqOpts = { token: access.token, baseUrl: beds24BaseUrl() };
  const propertyFilter = `propertyId=${propertyIds.map(encodeURIComponent).join(",")}`;

  let windowPull = !opts?.bookingId;
  if (opts?.bookingId) {
    // targeted fast-path (future webhook / operator recovery): ONE named
    // booking through the SAME pipeline. An id filter that matches nothing
    // falls through to the full window pull — the correctness backstop.
    const before = summary.fetched;
    await pullWindow(
      db,
      conn,
      creds,
      `id=${encodeURIComponent(opts.bookingId)}`,
      resolveRoom,
      mappings,
      summary,
      processedRowIds,
      gate,
    );
    if (summary.fetched === before) windowPull = true;
  }
  if (windowPull) {
    // incremental pull — everything MODIFIED in the lookback window, scoped to
    // this connection's mapped properties. The explicit status list is the
    // cancellation fix: without it Beds24 omits cancelled bookings entirely.
    await pullWindow(
      db,
      conn,
      creds,
      `${propertyFilter}&${BEDS24_STATUS_FILTER}&modifiedFrom=${encodeURIComponent(isoDateTime(-LOOKBACK_DAYS * 86_400_000))}`,
      resolveRoom,
      mappings,
      summary,
      processedRowIds,
      gate,
    );
    if (conn.last_inbound_import_at === null) {
      // first run — the connection has never imported: additionally walk the
      // full arrival window so the pre-existing backlog lands (idempotent —
      // any overlap with the incremental pull dedupes on the synthetic id)
      await pullWindow(
        db,
        conn,
        creds,
        `${propertyFilter}&${BEDS24_STATUS_FILTER}` +
          `&arrivalFrom=${isoDate(-BACKFILL_PAST_DAYS * 86_400_000)}` +
          `&arrivalTo=${isoDate(FORWARD_DAYS * 86_400_000)}`,
        resolveRoom,
        mappings,
        summary,
        processedRowIds,
        gate,
      );
    }
  }

  await sweepUnimportedRows(db, conn, resolveRoom, mappings, summary, processedRowIds);

  // ops emails for external date changes — strictly AFTER the import
  // transactions committed (after the pull); a mail
  // failure never fails the pull.
  try {
    await dispatchExternalChangeEmails(db, conn.tenant_id);
  } catch (e) {
    pushError(summary, e instanceof Error ? e.message : "שליחת התראות המייל נכשלה");
  }

  if (summary.imported > 0) {
    await db`
      UPDATE guesthub.channel_connections SET last_inbound_import_at = now()
      WHERE id = ${conn.id}`;
  }
  return summary;
}

// ---------------------------------------------------------------
// booking reconciliation (safety net over the status-filter fix) — every
// RECONCILE cycle, each locally-OCCUPYING externally-sourced reservation is
// compared against its source booking's live status. A booking the source
// says is cancelled while we still block inventory is the overbooking gap;
// it is released through the SAME targeted pull → applyCancellation path the
// worker always uses — never a hand-rolled status flip.
// ---------------------------------------------------------------

// bounded per cycle (one GET per reservation); the bound is REPORTED, never silent
const RECONCILE_LIMIT = 50;

export type Beds24ReconcileSummary = {
  checked: number;
  released: number;
  /** cancelled at source but the guest is CHECKED IN — alert only, never auto-released */
  alerts: number;
  errors: string[];
  /** P0-4 — the newest credit meter seen (fresh: this runs every 20 minutes) */
  credits: Beds24CreditSnapshot | null;
  /** set when the credit window (or a 429) cut the sweep short */
  creditPause: Beds24CreditPause | null;
};

export async function runBeds24BookingReconciliation(
  db: Sql,
  conn: Beds24InboundConnection,
): Promise<Beds24ReconcileSummary> {
  const summary: Beds24ReconcileSummary = {
    checked: 0, released: 0, alerts: 0, errors: [], credits: null, creditPause: null,
  };
  // RECONCILE_LIMIT is 50 → up to 50 by-id calls = 60 credits at the measured
  // 1.2/call, 60% of one whole window. The gate stops the sweep instead; the
  // unchecked reservations are simply re-checked on the next 20-minute cycle.
  const gate = createBeds24CreditGate();

  const rows = await db<
    { id: string; reservation_number: string; status: string; external_booking_id: string }[]
  >`
    SELECT id, reservation_number, status, external_booking_id
    FROM guesthub.reservations
    WHERE tenant_id = ${conn.tenant_id}
      AND channel_connection_id = ${conn.id}
      AND external_booking_id IS NOT NULL
      AND status IN ('confirmed', 'checked_in')
      AND check_out >= CURRENT_DATE
    ORDER BY check_in
    LIMIT ${RECONCILE_LIMIT}`;
  if (rows.length === 0) return summary;
  if (rows.length === RECONCILE_LIMIT) {
    pushError(summary, `reconciliation checked only the first ${RECONCILE_LIMIT} reservations`);
  }

  const access = await getBeds24AccessToken(db, conn);
  if (!access.ok) {
    pushError(summary, access.error);
    return summary;
  }
  const creds: Beds24ReqOpts = { token: access.token, baseUrl: beds24BaseUrl() };

  for (const r of rows) {
    if (gate.pause) {
      pushError(summary, beds24CreditPauseMessage(gate.pause));
      break; // the rest are re-checked on the next 20-minute cycle
    }
    const res = await fetchBookingsPage(creds, `id=${encodeURIComponent(r.external_booking_id)}`, 1);
    const rateLimited = "ok" in res && res.ok === false && res.category === "rate_limited";
    gate.observe(res.credits, {
      ...(rateLimited ? { httpStatus: 429 } : {}),
      ...(rateLimited && res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
    });
    summary.credits = gate.last;
    summary.creditPause = gate.pause;
    if (!res.ok) {
      pushError(summary, gate.pause ? beds24CreditPauseMessage(gate.pause) : res.message);
      continue; // transient — the next cycle re-checks
    }
    summary.checked += 1;
    const source = res.bookings
      .map((b) => beds24BookingIdentity(b))
      .find((b) => b.bookingId === r.external_booking_id);
    // a booking the source no longer returns is NOT treated as cancelled —
    // absence is not evidence; only an explicit cancelled status releases
    if (!source || source.rawStatus?.toLowerCase() !== "cancelled") continue;

    if (r.status === "checked_in") {
      // the guest is physically in the room — releasing would erase a live
      // stay. Loud alert; the operator decides.
      summary.alerts += 1;
      await logChannelError(db, {
        tenantId: conn.tenant_id,
        connectionId: conn.id,
        code: "cancelled_at_source_checked_in",
        message: `הזמנה ${r.reservation_number} מבוטלת ב-Beds24 אבל האורח צ'ק-אין — נדרשת החלטת מפעיל`,
        context: { reservation_id: r.id, booking_id: r.external_booking_id },
      });
      continue;
    }

    // the gap: cancelled at source, still occupying here → canonical release
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: "cancellation_reconciled",
      message: `השלמת ביטול: הזמנה ${r.reservation_number} מבוטלת ב-Beds24 אך תפסה מלאי — משוחררת דרך מסלול הביטול הקנוני`,
      context: { reservation_id: r.id, booking_id: r.external_booking_id },
    });
    await runBeds24InboundPull(db, conn, { bookingId: r.external_booking_id });
    const [after] = await db<{ status: string }[]>`
      SELECT status FROM guesthub.reservations WHERE id = ${r.id}`;
    if (after?.status === "cancelled") summary.released += 1;
    else pushError(summary, `שחרור ${r.reservation_number} לא הושלם — עדיין ${after?.status ?? "?"}`);
  }
  return summary;
}
