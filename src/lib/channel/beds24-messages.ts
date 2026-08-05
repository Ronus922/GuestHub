import "server-only";
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
import {
  createBeds24CreditGate, beds24CreditPauseMessage,
  type Beds24CreditPause, type Beds24CreditSnapshot,
} from "./beds24-credits";
import { circuitAllowsRequest, type CircuitState } from "./circuit-breaker";
import { logChannelError } from "./queue";
import {
  upsertGuestConversation,
  insertGuestMessage,
} from "@/lib/messaging/guest-conversations";

// ============================================================
// Beds24 guest-message ingest (Phase 4, RECEIVE-ONLY) — GET /bookings/messages
// into guest_conversations / guest_messages (076). This module makes exactly
// ONE kind of Beds24 call. POST /bookings/messages (sending, marking read) is
// DELIBERATELY not built in this phase.
//
// THE WIRE, MEASURED (ref/audit/BEDS24-MESSAGES-SHAPE-2026-08-05.json — live
// probe, 56 messages / 30 days; corroborated 2026-08-02 with 47/9 days):
//   • a message is exactly nine keys: id, authorOwnerId (null on all 56),
//     bookingId, roomId, propertyId, time, read, message, source
//   • source ∈ {"host","guest"} is the ONLY direction discriminator
//     (authorOwnerId is null on every row); the spec's enum also names
//     internalNote/system — never observed, and skipped here (they are not
//     part of the guest conversation)
//   • time is UTC with a literal Z suffix (verified 56/56)
//   • there is NO thread id — a conversation is DEFINED AS "all messages
//     sharing a bookingId" (external_thread_key = bookingId)
//   • measured cost: 1.0 credit per call, envelope {success,count,pages,data}
//
// Reservation link: bookingId joins reservations.external_booking_id
// (measured 14/14) — the OPPOSITE identifier from the reviews feed; see
// beds24-reviews.ts before reusing this join anywhere near reviews.
//
// Poll model: a fixed MESSAGES_MAX_AGE_DAYS window every cycle, idempotent by
// UNIQUE (tenant_id, provider, external_message_id) — re-processing an
// unchanged window is all no-ops. No watermark to corrupt, no gap on downtime
// shorter than the window.
// ============================================================

/** How far back each pull looks (maxAge, in days). Wide on purpose: at the
 *  measured 1.0 credit the cost is per CALL, not per row, and the measured
 *  30-day volume is 56 rows — so the wide window buys downtime tolerance and
 *  read-flag freshness (in raw) for free. */
export const MESSAGES_MAX_AGE_DAYS = 30;
// hard bound — never an unbounded pagination loop (booking-import doctrine)
const MESSAGES_MAX_PAGES = 10;
const MAX_ERRORS = 20;

/** The connection slice this ingest needs — the inbound predicate plus the
 *  §16 circuit state (read-only here: an open breaker skips the pull, but a
 *  read-only poll never advances outbound breaker state). */
export type Beds24IngestConnection = {
  id: string;
  tenant_id: string;
  api_key_ciphertext: string;
  access_token_ciphertext: string | null;
  access_token_expires_at: Date | string | null;
  circuit_open_until: string | null;
  consecutive_failures: number;
};

// Same eligibility as loadBeds24InboundConnections (booking-import): guest
// messages are inbound guest data, so they follow the inbound switch — plus
// the circuit columns the pull respects.
export async function loadBeds24IngestConnections(db: Sql): Promise<Beds24IngestConnection[]> {
  return db<Beds24IngestConnection[]>`
    SELECT id, tenant_id, api_key_ciphertext,
           access_token_ciphertext, access_token_expires_at,
           circuit_open_until::text AS circuit_open_until, consecutive_failures
    FROM guesthub.channel_connections
    WHERE provider = 'beds24' AND is_active_provider = true
      AND state IN ('ready', 'active')
      AND inbound_sync_enabled = true AND api_key_ciphertext IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM guesthub.channel_beds24_room_mappings m
        WHERE m.connection_id = channel_connections.id AND m.status = 'mapped')`;
}

/** Distinct mapped Beds24 property ids — every list call is scoped by them
 *  (a propertyId-less call would pull the whole Beds24 account). */
export async function loadBeds24PropertyIds(db: Sql, connectionId: string): Promise<string[]> {
  const rows = await db<{ beds24_property_id: string }[]>`
    SELECT DISTINCT beds24_property_id
    FROM guesthub.channel_beds24_room_mappings
    WHERE connection_id = ${connectionId} AND status = 'mapped'`;
  return rows.map((r) => r.beds24_property_id);
}

export function ingestCircuitState(conn: Beds24IngestConnection): CircuitState {
  return {
    consecutiveFailures: conn.consecutive_failures,
    openUntil: conn.circuit_open_until ? Date.parse(conn.circuit_open_until) : null,
  };
}

// ---------------------------------------------------------------
// wire types + pure normalization (no DB, no HTTP)
// ---------------------------------------------------------------

/** One message as measured on the wire (all nine keys; see header). */
export type Beds24GuestMessage = {
  id: number;
  bookingId: number;
  roomId: number | null;
  propertyId: number | null;
  time: string;
  read: boolean;
  message: string;
  source: string;
  authorOwnerId: unknown;
};

export type NormalizedGuestMessage = {
  externalMessageId: string;
  /** the Beds24 bookingId — the thread key AND the reservation join key */
  bookingId: string;
  direction: "inbound" | "outbound";
  body: string;
  /** ISO-8601 UTC */
  sentAt: string;
  raw: unknown;
};

export type GuestMessageNormalizeResult =
  | { ok: true; value: NormalizedGuestMessage }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; error: string };

const asFiniteInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : null;

/** Pure. Defensive against every field: a malformed item is reported, never
 *  thrown. `internalNote`/`system` sources are SKIPPED (spec-only values —
 *  never observed live — and not part of the guest conversation). */
export function normalizeBeds24Message(payload: unknown): GuestMessageNormalizeResult {
  const m = asObj(payload);
  if (!m) return { ok: false, skipped: false, error: "הודעה מ-Beds24 אינה אובייקט" };
  const id = asFiniteInt(m.id);
  const bookingId = asFiniteInt(m.bookingId);
  if (id === null || bookingId === null) {
    return { ok: false, skipped: false, error: "הודעה מ-Beds24 ללא מזהה או ללא הזמנה" };
  }
  const source = typeof m.source === "string" ? m.source : "";
  if (source !== "guest" && source !== "host") {
    return { ok: false, skipped: true, reason: `source=${source || "?"}` };
  }
  const time = typeof m.time === "string" ? Date.parse(m.time) : NaN;
  if (!Number.isFinite(time)) {
    return { ok: false, skipped: false, error: `הודעה ${id} מ-Beds24 עם חותמת זמן בלתי קריאה` };
  }
  return {
    ok: true,
    value: {
      externalMessageId: String(id),
      bookingId: String(bookingId),
      direction: source === "guest" ? "inbound" : "outbound",
      body: typeof m.message === "string" ? m.message : "",
      sentAt: new Date(time).toISOString(),
      raw: payload,
    },
  };
}

// ---------------------------------------------------------------
// messages client — GET /bookings/messages ONLY
// ---------------------------------------------------------------

type MessagesPage = {
  ok: true;
  messages: unknown[];
  nextPageExists: boolean;
  credits: Beds24CreditSnapshot;
};

// Envelope mirrors /bookings: { success, data: [...], pages: { nextPageExists } },
// probed defensively; success:false on a 200 is a bad response.
async function fetchMessagesPage(
  opts: Beds24ReqOpts,
  propertyIds: string[],
  page: number,
): Promise<MessagesPage | Beds24ApiFailure> {
  const path =
    `/bookings/messages?propertyId=${propertyIds.map(encodeURIComponent).join(",")}` +
    `&maxAge=${MESSAGES_MAX_AGE_DAYS}&page=${page}`;
  const res = await beds24Request({ ...opts, method: "GET", path });
  if ("ok" in res) return res;
  if (res.status !== 200) {
    const f = beds24Fail(mapErrorStatus(res.status), res.status, res.raw);
    return res.retryAfterMs !== undefined
      ? { ...f, retryAfterMs: res.retryAfterMs, credits: res.credits }
      : { ...f, credits: res.credits };
  }
  const root = asObj(res.body);
  if (root && root.success === false) return beds24Fail("bad_response", res.status, res.raw);
  const data = root?.data ?? res.body;
  if (!Array.isArray(data)) return beds24Fail("bad_response", res.status, res.raw);
  return {
    ok: true,
    messages: data,
    nextPageExists: asObj(root?.pages)?.nextPageExists === true,
    credits: res.credits,
  };
}

// ---------------------------------------------------------------
// the pull — GET → normalize (pure) → conversation upsert → append message
// ---------------------------------------------------------------

export type Beds24GuestMessagesSummary = {
  fetched: number;
  inserted: number;
  /** replays of already-stored messages (idempotent no-ops) */
  duplicates: number;
  /** non-guest/host sources (internalNote/system) — not errors */
  skipped: number;
  failed: number;
  errors: string[];
  credits: Beds24CreditSnapshot | null;
  creditPause: Beds24CreditPause | null;
  /** the §16 breaker was open — nothing was attempted */
  circuitOpen: boolean;
};

function pushError(summary: { errors: string[] }, message: string): void {
  if (summary.errors.length < MAX_ERRORS) summary.errors.push(message);
}

export async function runBeds24GuestMessagesPull(
  db: Sql,
  conn: Beds24IngestConnection,
): Promise<Beds24GuestMessagesSummary> {
  const summary: Beds24GuestMessagesSummary = {
    fetched: 0, inserted: 0, duplicates: 0, skipped: 0, failed: 0,
    errors: [], credits: null, creditPause: null, circuitOpen: false,
  };

  // §16 — an open breaker (outbound cooldown after a 429 / repeated failures)
  // is respected READ-ONLY: this pull yields instead of adding traffic, but a
  // poll never advances the breaker — that state machine belongs to the drain.
  if (!circuitAllowsRequest(ingestCircuitState(conn), Date.now())) {
    summary.circuitOpen = true;
    return summary;
  }

  const propertyIds = await loadBeds24PropertyIds(db, conn.id);
  if (propertyIds.length === 0) {
    pushError(summary, "אין חדרי Beds24 ממופים לחיבור זה");
    return summary;
  }

  const access = await getBeds24AccessToken(db, conn);
  if (!access.ok) {
    pushError(summary, access.error);
    return summary;
  }
  const creds: Beds24ReqOpts = { token: access.token, baseUrl: beds24BaseUrl() };
  const gate = createBeds24CreditGate();

  // per-run cache: bookingId → conversation id (one upsert per thread per run)
  const conversationByBooking = new Map<string, string>();

  for (let page = 1; page <= MESSAGES_MAX_PAGES; page++) {
    if (gate.pause) {
      pushError(summary, beds24CreditPauseMessage(gate.pause));
      break;
    }
    const res = await fetchMessagesPage(creds, propertyIds, page);
    const rateLimited = "ok" in res && res.ok === false && res.category === "rate_limited";
    gate.observe(res.credits, {
      ...(rateLimited ? { httpStatus: 429 } : {}),
      ...(rateLimited && res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
    });
    summary.credits = gate.last;
    summary.creditPause = gate.pause;
    if (!res.ok) {
      pushError(summary, gate.pause ? beds24CreditPauseMessage(gate.pause) : res.message);
      // D112 — raw evidence on the error record; one unresolved row per code,
      // because the poll repeats every cycle while the API is broken.
      const [dup] = await db<{ x: number }[]>`
        SELECT 1 AS x FROM guesthub.channel_sync_errors
        WHERE tenant_id = ${conn.tenant_id} AND connection_id = ${conn.id}
          AND error_code = ${`guest_messages_${res.category}`} AND resolved_at IS NULL
        LIMIT 1`;
      if (!dup) {
        await logChannelError(db, {
          tenantId: conn.tenant_id,
          connectionId: conn.id,
          code: `guest_messages_${res.category}`,
          message: res.message,
          httpStatus: res.raw?.httpStatus ?? null,
          responseBody: res.raw?.body ?? null,
          responseTruncated: res.raw?.truncated ?? false,
          responseReceivedAt: res.raw?.receivedAt ?? null,
        });
      }
      break;
    }
    for (const item of res.messages) {
      summary.fetched += 1;
      const norm = normalizeBeds24Message(item);
      if (!norm.ok) {
        if (norm.skipped) summary.skipped += 1;
        else {
          summary.failed += 1;
          pushError(summary, norm.error);
        }
        continue;
      }
      let conversationId = conversationByBooking.get(norm.value.bookingId);
      if (!conversationId) {
        // the measured join: bookingId = reservations.external_booking_id
        // (14/14). No match is a normal state — the conversation renders
        // unlinked and a later pull fills the link in (COALESCE upsert).
        const [reservation] = await db<{ id: string; primary_guest_id: string | null }[]>`
          SELECT id, primary_guest_id FROM guesthub.reservations
          WHERE tenant_id = ${conn.tenant_id}
            AND channel_connection_id = ${conn.id}
            AND external_booking_id = ${norm.value.bookingId}
          ORDER BY created_at DESC LIMIT 1`;
        conversationId = await upsertGuestConversation(
          {
            tenantId: conn.tenant_id,
            channel: "beds24",
            externalThreadKey: norm.value.bookingId,
            reservationId: reservation?.id ?? null,
            guestId: reservation?.primary_guest_id ?? null,
          },
          db,
        );
        conversationByBooking.set(norm.value.bookingId, conversationId);
      }
      const isNew = await insertGuestMessage(
        {
          tenantId: conn.tenant_id,
          conversationId,
          direction: norm.value.direction,
          provider: "beds24",
          externalMessageId: norm.value.externalMessageId,
          body: norm.value.body,
          sentAt: norm.value.sentAt,
          raw: norm.value.raw,
        },
        db,
      );
      if (isNew) summary.inserted += 1;
      else summary.duplicates += 1;
    }
    if (!res.nextPageExists || res.messages.length === 0) break;
  }
  return summary;
}
