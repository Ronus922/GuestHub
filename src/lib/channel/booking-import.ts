import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { decryptSecret } from "./crypto";
import { CHANNEX_BASE_URLS } from "./config";
import {
  acknowledgeBookingRevision,
  fetchBookingRevision,
  fetchBookingRevisionsFeed,
  FEED_PAGE_LIMIT,
  type FeedRevision,
} from "./channex-bookings";
import type { ChannexReqOpts } from "./channex-http";
import {
  markRevisionAcknowledged,
  markRevisionFailed,
  markRevisionImported,
  persistBookingRevision,
  quarantineRevision,
} from "./revisions";
import {
  normalizeBookingRevision,
  otaSourceKey,
  type NormalizedRevision,
  type NormalizedRoom,
} from "./booking-normalize";
import { markAriDirty } from "./outbox";
import { logChannelError } from "./queue";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { checkRoomAvailability, lockRooms, CONFLICT_LABEL } from "@/lib/inventory";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import { nightsBetween, rangesOverlap } from "@/lib/dates";

// ============================================================
// Canonical inbound booking import (D76) — the ONE path from a Channex booking
// revision to a GuestHub reservation. Consumed exclusively by the PM2 channel
// worker's pull_booking_revisions job; nothing here runs in a web request.
//
// INVARIANTS
//  • Identity: one reservation per (connection, Channex booking_id) — enforced
//    by uq_reservations_external_booking (migration 029), not by code.
//  • A revision is imported exactly once (UNIQUE connection+revision, 005),
//    inside ONE transaction with its reservation writes; markRevisionImported
//    runs in that same transaction, so "imported" implies durably saved.
//  • Acknowledgement happens ONLY after that transaction committed; the WHERE
//    clause of markRevisionAcknowledged is the structural backstop. An
//    ambiguous ack is never blindly retried — the next feed pull re-converges.
//  • Rooms resolve by external UUID through channel_room_mappings — NEVER by
//    title. Unmapped room / wrong property / local conflict → visible
//    quarantine; never a guessed room, never an overwritten local stay.
//  • Prices are the CHANNEL's (is_manual_rate=true, pricing_snapshot NULL —
//    the price is external; the local engine never repriced this stay).
//  • paid_amount stays ledger-derived: hotel-collect arrives UNPAID (§8).
// ============================================================

export type InboundConnection = {
  id: string;
  tenant_id: string;
  environment: "staging" | "production";
  channex_property_id: string;
  api_key_ciphertext: string;
};

export type InboundPullSummary = {
  pulled: number;
  imported: number;
  alreadyImported: number;
  quarantined: number;
  failed: number;
  acked: number;
  /** sanitized error messages (bounded) — never an upstream body */
  errors: string[];
};

// A domain condition that must PARK the revision visibly (unmapped room,
// wrong property, local conflict) — distinct from a transient failure.
class QuarantineError extends Error {}

const MAX_FEED_ROUNDS = 20;
const REACK_BATCH = 50;

export function inboundCreds(conn: InboundConnection): ChannexReqOpts {
  return {
    apiKey: decryptSecret(conn.api_key_ciphertext),
    baseUrl: CHANNEX_BASE_URLS[conn.environment] ?? CHANNEX_BASE_URLS.staging,
  };
}

export async function loadInboundConnections(db: Sql): Promise<InboundConnection[]> {
  return db<InboundConnection[]>`
    SELECT id, tenant_id, environment, channex_property_id, api_key_ciphertext
    FROM guesthub.channel_connections
    WHERE state = 'active' AND inbound_sync_enabled = true
      AND channex_property_id IS NOT NULL AND api_key_ciphertext IS NOT NULL`;
}

// ---------------------------------------------------------------
// mapping resolution — external UUID → canonical physical room
// ---------------------------------------------------------------

type ResolvedStay = {
  roomId: string;
  localRatePlanId: string | null;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
  amount: number;
  nights: number;
};

async function resolveStays(
  db: Sql | TransactionSql,
  conn: InboundConnection,
  rooms: NormalizedRoom[],
): Promise<ResolvedStay[]> {
  const stays: ResolvedStay[] = [];
  for (const room of rooms) {
    const [mapping] = await db<{ room_id: string }[]>`
      SELECT room_id FROM guesthub.channel_room_mappings
      WHERE connection_id = ${conn.id}
        AND channex_room_type_id = ${room.channexRoomTypeId}
        AND status = 'mapped'`;
    if (!mapping) {
      throw new QuarantineError(
        `חדר ערוץ ללא מיפוי לחדר פיזי (Room Type ${room.channexRoomTypeId.slice(0, 8)}…)`,
      );
    }
    let localRatePlanId: string | null = null;
    if (room.channexRatePlanId) {
      const [ratePlan] = await db<{ local_rate_plan_id: string; room_id: string }[]>`
        SELECT local_rate_plan_id, room_id FROM guesthub.channel_room_rate_mappings
        WHERE connection_id = ${conn.id}
          AND channex_rate_plan_id = ${room.channexRatePlanId}
          AND status = 'mapped'`;
      if (!ratePlan) {
        throw new QuarantineError(
          `תוכנית תעריף של הערוץ ללא מיפוי מקומי (Rate Plan ${room.channexRatePlanId.slice(0, 8)}…)`,
        );
      }
      if (ratePlan.room_id !== mapping.room_id) {
        throw new QuarantineError("מיפוי תוכנית התעריף אינו תואם את חדר ההזמנה");
      }
      localRatePlanId = ratePlan.local_rate_plan_id;
    }
    stays.push({
      roomId: mapping.room_id,
      localRatePlanId,
      checkIn: room.checkinDate,
      checkOut: room.checkoutDate,
      adults: room.adults,
      children: room.children,
      infants: room.infants,
      amount: room.amount ?? 0,
      nights: nightsBetween(room.checkinDate, room.checkoutDate),
    });
  }
  // the same physical room twice on overlapping nights is channel-side data
  // corruption — park it, never let it half-import
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      if (
        stays[i].roomId === stays[j].roomId &&
        rangesOverlap(stays[i].checkIn, stays[i].checkOut, stays[j].checkIn, stays[j].checkOut)
      ) {
        throw new QuarantineError("אותו חדר פיזי מופיע פעמיים בתאריכים חופפים");
      }
    }
  }
  return stays;
}

// ---------------------------------------------------------------
// reservation write helpers (worker context — no session actor)
// ---------------------------------------------------------------

// Same allocation rule as the manual create path (reservations/actions.ts):
// tenant row locked for the transaction, unique index as the hard backstop.
// ponytail: 6 duplicated lines — extract to a shared lib when a third caller appears.
async function allocateReservationNumber(tx: TransactionSql, tenantId: string): Promise<string> {
  await tx`SELECT id FROM guesthub.tenants WHERE id = ${tenantId} FOR UPDATE`;
  const [row] = await tx<{ next: string }[]>`
    SELECT (COALESCE(MAX(NULLIF(regexp_replace(reservation_number, '\\D', '', 'g'), '')::bigint), 1000) + 1)::text AS next
    FROM guesthub.reservations WHERE tenant_id = ${tenantId}`;
  return row.next;
}

async function channelAudit(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
  action: string,
  after: Record<string, unknown>,
  otaName: string | null,
): Promise<void> {
  await tx`
    INSERT INTO guesthub.audit_logs
      (tenant_id, user_id, entity_type, entity_id, action, after_data, session_info)
    VALUES (${tenantId}, NULL, 'reservation', ${reservationId}, ${action},
            ${tx.json(after as never)}, ${`channel:${otaName ?? "unknown"}`})`;
}

async function upsertChannelGuest(
  tx: TransactionSql,
  tenantId: string,
  existingGuestId: string | null,
  customer: NormalizedRevision["customer"],
): Promise<string> {
  const fullName = `${customer.firstName} ${customer.lastName}`.trim();
  if (existingGuestId) {
    await tx`
      UPDATE guesthub.guests SET
        first_name = ${customer.firstName}, last_name = ${customer.lastName},
        full_name = ${fullName},
        phone = COALESCE(${customer.phone}, phone),
        email = COALESCE(${customer.email}, email)
      WHERE id = ${existingGuestId} AND tenant_id = ${tenantId}`;
    return existingGuestId;
  }
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.guests
      (tenant_id, first_name, last_name, full_name, phone, email, country, language)
    VALUES (${tenantId}, ${customer.firstName}, ${customer.lastName}, ${fullName},
            ${customer.phone}, ${customer.email}, ${customer.country}, ${customer.language})
    RETURNING id`;
  return created.id;
}

async function lookupSourceId(
  db: Sql | TransactionSql,
  tenantId: string,
  otaName: string | null,
): Promise<string | null> {
  const key = otaSourceKey(otaName);
  if (!key) return null;
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM guesthub.lookup_items
    WHERE tenant_id = ${tenantId} AND category = 'booking_sources' AND key = ${key}`;
  return row?.id ?? null;
}

type ExistingReservation = {
  id: string;
  status: string;
  primary_guest_id: string | null;
  check_in: string;
  check_out: string;
  external_cancellation_requested_at: string | null;
};

async function lockExternalReservation(
  tx: TransactionSql,
  conn: InboundConnection,
  bookingId: string,
): Promise<{ existing: ExistingReservation | null; rrIds: string[]; oldRoomIds: string[] }> {
  const [existing] = await tx<ExistingReservation[]>`
    SELECT id, status, primary_guest_id, check_in::text AS check_in, check_out::text AS check_out,
           external_cancellation_requested_at::text AS external_cancellation_requested_at
    FROM guesthub.reservations
    WHERE tenant_id = ${conn.tenant_id}
      AND channel_connection_id = ${conn.id}
      AND external_booking_id = ${bookingId}
    FOR UPDATE`;
  if (!existing) return { existing: null, rrIds: [], oldRoomIds: [] };
  const rows = await tx<{ id: string; room_id: string | null }[]>`
    SELECT id, room_id FROM guesthub.reservation_rooms
    WHERE reservation_id = ${existing.id} AND tenant_id = ${conn.tenant_id}`;
  return {
    existing,
    rrIds: rows.map((r) => r.id),
    oldRoomIds: rows.map((r) => r.room_id).filter((x): x is string => !!x),
  };
}

// Operator-advanced states survive a channel modification; everything else
// snaps to the channel's live status.
const PRESERVED_STATUSES = new Set(["checked_in", "checked_out"]);

function aggregate(stays: ResolvedStay[]) {
  return {
    checkIn: stays.reduce((m, s) => (s.checkIn < m ? s.checkIn : m), stays[0].checkIn),
    checkOut: stays.reduce((m, s) => (s.checkOut > m ? s.checkOut : m), stays[0].checkOut),
    adults: stays.reduce((n, s) => n + s.adults, 0),
    children: stays.reduce((n, s) => n + s.children, 0),
    infants: stays.reduce((n, s) => n + s.infants, 0),
    roomsTotal: stays.reduce((sum, s) => sum + s.amount, 0),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------
// the import transaction — NEW / MODIFIED / CANCELLED
// ---------------------------------------------------------------

export type ImportOutcome =
  | { status: "imported"; reservationId: string | null }
  | { status: "already"; reservationId: string | null }
  | { status: "quarantined"; reason: string }
  | { status: "failed"; error: string };

type RevisionRow = {
  id: string;
  tenant_id: string;
  provider_booking_id: string;
  provider_revision_id: string;
  revision_kind: "new" | "modified" | "cancelled";
  payload: unknown;
  import_status: string;
  local_reservation_id: string | null;
};

async function applyLiveRevision(
  tx: TransactionSql,
  conn: InboundConnection,
  norm: NormalizedRevision,
): Promise<string> {
  const liveRooms = norm.rooms.filter((r) => !r.isCancelled);
  const stays = await resolveStays(tx, conn, liveRooms);
  const agg = aggregate(stays);
  const total = round2(norm.amount ?? agg.roomsTotal);

  const { existing, rrIds, oldRoomIds } = await lockExternalReservation(
    tx,
    conn,
    norm.bookingId,
  );

  // serialize against local writers, then enforce the SAME availability rule
  // every local write goes through — excluding only this reservation's rows
  const roomIds = [...new Set(stays.map((s) => s.roomId))];
  await lockRooms(tx, conn.tenant_id, roomIds);
  for (const stay of stays) {
    const conflicts = await checkRoomAvailability(tx, {
      tenantId: conn.tenant_id,
      roomIds: [stay.roomId],
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      excludeReservationRoomIds: rrIds,
    });
    if (conflicts.length > 0) {
      throw new QuarantineError(
        `התנגשות מקומית בחדר: ${CONFLICT_LABEL[conflicts[0].conflict_kind]} (${stay.checkIn} → ${stay.checkOut})`,
      );
    }
  }

  const guestId = await upsertChannelGuest(
    tx,
    conn.tenant_id,
    existing?.primary_guest_id ?? null,
    norm.customer,
  );
  const sourceId = await lookupSourceId(tx, conn.tenant_id, norm.otaName);

  let reservationId: string;
  if (existing) {
    const status = PRESERVED_STATUSES.has(existing.status) ? existing.status : "confirmed";
    await tx`
      UPDATE guesthub.reservations SET
        primary_guest_id = ${guestId},
        source_id = COALESCE(${sourceId}, source_id),
        status = ${status},
        check_in = ${agg.checkIn}, check_out = ${agg.checkOut},
        adults = ${agg.adults}, children = ${agg.children}, infants = ${agg.infants},
        total_price = ${total}, currency = ${norm.currency ?? "ILS"},
        notes = ${norm.notes},
        external_revision_id = ${norm.revisionId},
        external_unique_id = COALESCE(${norm.uniqueId}, external_unique_id),
        ota_reservation_code = COALESCE(${norm.otaReservationCode}, ota_reservation_code),
        ota_name = COALESCE(${norm.otaName}, ota_name)
      WHERE id = ${existing.id} AND tenant_id = ${conn.tenant_id}`;
    await tx`
      DELETE FROM guesthub.reservation_rooms
      WHERE reservation_id = ${existing.id} AND tenant_id = ${conn.tenant_id}`;
    reservationId = existing.id;
  } else {
    const number = await allocateReservationNumber(tx, conn.tenant_id);
    // imported OTA reservations receive the tenant's default workflow status
    // (D77 §C) — an operator tag only, never inventory or payment state
    const [wf] = await tx<{ id: string }[]>`
      SELECT id FROM guesthub.lookup_items
      WHERE tenant_id = ${conn.tenant_id} AND category = 'workflow_statuses'
        AND is_active AND (metadata->>'is_default') = 'true'`;
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, source_id, status,
         check_in, check_out, adults, children, infants,
         total_price, paid_amount, balance, currency, notes, created_by,
         channel_connection_id, external_booking_id, external_revision_id,
         external_unique_id, ota_reservation_code, ota_name, external_booked_at,
         workflow_status_id)
      VALUES (${conn.tenant_id}, ${number}, ${guestId}, ${sourceId}, 'confirmed',
              ${agg.checkIn}, ${agg.checkOut},
              ${agg.adults}, ${agg.children}, ${agg.infants},
              ${total}, 0, ${total}, ${norm.currency ?? "ILS"}, ${norm.notes}, NULL,
              ${conn.id}, ${norm.bookingId}, ${norm.revisionId},
              ${norm.uniqueId}, ${norm.otaReservationCode}, ${norm.otaName},
              ${norm.insertedAt}, ${wf?.id ?? null})
      RETURNING id`;
    reservationId = created.id;
  }

  for (const stay of stays) {
    // the channel's price is authoritative for its own booking: is_manual_rate
    // marks "not engine-priced"; pricing_snapshot stays NULL — there is no
    // engine quote to snapshot, and inventing one would be dishonest.
    const ratePerNight = round2(stay.nights > 0 ? stay.amount / stay.nights : stay.amount);
    await tx`
      INSERT INTO guesthub.reservation_rooms
        (tenant_id, reservation_id, room_id, check_in, check_out,
         adults, children, infants, rate_per_night, price_total,
         is_manual_rate, rate_plan_id, pricing_snapshot,
         guest_first_name, guest_last_name, guest_phone, guest_email)
      VALUES (${conn.tenant_id}, ${reservationId}, ${stay.roomId},
              ${stay.checkIn}, ${stay.checkOut},
              ${stay.adults}, ${stay.children}, ${stay.infants},
              ${ratePerNight}, ${round2(stay.amount)},
              true, ${stay.localRatePlanId}, NULL,
              ${norm.customer.firstName}, ${norm.customer.lastName},
              ${norm.customer.phone}, ${norm.customer.email})`;
  }

  // hotel-collect arrives unpaid: no payment row is fabricated; the ledger
  // recompute keeps paid_amount/balance honest (0 / total)
  await recomputePaymentAggregates(tx, conn.tenant_id, reservationId);

  await channelAudit(
    tx,
    conn.tenant_id,
    reservationId,
    existing ? "channel_import_update" : "channel_import_create",
    {
      booking_id: norm.bookingId,
      revision_id: norm.revisionId,
      unique_id: norm.uniqueId,
      ota_reservation_code: norm.otaReservationCode,
      check_in: agg.checkIn,
      check_out: agg.checkOut,
      rooms: stays.length,
      total,
      currency: norm.currency,
      payment_collect: norm.paymentCollect,
      payment_type: norm.paymentType,
    },
    norm.otaName,
  );

  // consumed (and, on modification, released) nights → outbound ARI stays true
  const dirtyRoomIds = [...new Set([...oldRoomIds, ...roomIds])];
  const from = existing && existing.check_in < agg.checkIn ? existing.check_in : agg.checkIn;
  const to = existing && existing.check_out > agg.checkOut ? existing.check_out : agg.checkOut;
  await markAriDirty(tx, { tenantId: conn.tenant_id, roomIds: dirtyRoomIds, dateFrom: from, dateTo: to });

  // committed-only realtime (D77 §6): NOTIFY rides this transaction, so open
  // calendars/lists learn about the booking the moment it durably exists
  await publishDomainEvent(tx, conn.tenant_id, {
    type: existing ? "reservation.modified" : "reservation.created",
    reservationId,
    roomIds: dirtyRoomIds,
    dateFrom: from,
    dateTo: to,
    lifecycle: "confirmed",
  });
  await publishDomainEvent(tx, conn.tenant_id, {
    type: "inventory.changed",
    roomIds: dirtyRoomIds,
    dateFrom: from,
    dateTo: to,
  });

  return reservationId;
}

async function applyCancellation(
  tx: TransactionSql,
  conn: InboundConnection,
  norm: NormalizedRevision,
): Promise<string | null> {
  const { existing, oldRoomIds } = await lockExternalReservation(tx, conn, norm.bookingId);
  if (!existing) {
    // a cancellation for a booking we never imported: nothing occupies the
    // calendar and nothing must be released — record the revision as imported
    // (the durable revision row IS the history) without inventing a reservation
    return null;
  }
  if (existing.status !== "cancelled") {
    // Canonical inbound cancellation (D77 §8): cancel-never-delete. The row
    // keeps its rooms/price/identity for history; the status flip alone stops
    // it blocking inventory. Who/when/why is recorded ON the row:
    //  · a cancellation we requested (invalid card) → origin 'invalid_card'
    //  · otherwise the channel's own revision      → origin 'ota_revision'
    //  · external_cancellation_confirmed_at = when the channel's cancelled
    //    revision landed (vs *_requested_at = when WE asked, 030)
    const origin = existing.external_cancellation_requested_at ? "invalid_card" : "ota_revision";
    await tx`
      UPDATE guesthub.reservations SET
        status = 'cancelled',
        external_revision_id = ${norm.revisionId},
        cancelled_at = now(),
        cancelled_by_type = 'ota',
        cancellation_origin = ${origin},
        external_cancellation_confirmed_at = now()
      WHERE id = ${existing.id} AND tenant_id = ${conn.tenant_id}`;
    // same release semantics as the local cancel action: the status change
    // frees the nights; republish those rooms/dates
    await markAriDirty(tx, {
      tenantId: conn.tenant_id,
      roomIds: oldRoomIds,
      dateFrom: existing.check_in,
      dateTo: existing.check_out,
    });
    await publishDomainEvent(tx, conn.tenant_id, {
      type: "reservation.cancelled",
      reservationId: existing.id,
      roomIds: oldRoomIds,
      dateFrom: existing.check_in,
      dateTo: existing.check_out,
      lifecycle: "cancelled",
    });
    await publishDomainEvent(tx, conn.tenant_id, {
      type: "inventory.changed",
      roomIds: oldRoomIds,
      dateFrom: existing.check_in,
      dateTo: existing.check_out,
    });
  } else {
    await tx`
      UPDATE guesthub.reservations SET external_revision_id = ${norm.revisionId}
      WHERE id = ${existing.id} AND tenant_id = ${conn.tenant_id}`;
  }
  await channelAudit(
    tx,
    conn.tenant_id,
    existing.id,
    "channel_import_cancel",
    {
      booking_id: norm.bookingId,
      revision_id: norm.revisionId,
      previous_status: existing.status,
    },
    norm.otaName,
  );
  return existing.id;
}

// Import ONE persisted revision row, transactionally. Idempotent: an already
// imported row returns without touching anything.
export async function importRevisionRow(
  db: Sql,
  conn: InboundConnection,
  revisionRowId: string,
): Promise<ImportOutcome> {
  const [rev] = await db<RevisionRow[]>`
    SELECT id, tenant_id, provider_booking_id, provider_revision_id,
           revision_kind, payload, import_status, local_reservation_id
    FROM guesthub.channel_booking_revisions
    WHERE id = ${revisionRowId} AND connection_id = ${conn.id}`;
  if (!rev) return { status: "failed", error: "רשומת רוויזיה לא נמצאה" };
  if (rev.import_status === "imported")
    return { status: "already", reservationId: rev.local_reservation_id };

  const norm = normalizeBookingRevision(rev.payload);
  if (!norm.ok) {
    await quarantineRevision(db, rev.id, norm.error);
    return { status: "quarantined", reason: norm.error };
  }
  // an unknown property is REJECTED — visibly parked, never imported into this
  // tenant and never acknowledged
  if (norm.value.propertyId !== conn.channex_property_id) {
    const reason = "הרוויזיה שייכת לנכס אחר — נדחתה";
    await quarantineRevision(db, rev.id, reason);
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: "wrong_property",
      message: reason,
      context: { revision_id: rev.provider_revision_id },
    });
    return { status: "quarantined", reason };
  }

  try {
    const reservationId = await db.begin(async (tx) => {
      const id =
        norm.value.kind === "cancelled"
          ? await applyCancellation(tx, conn, norm.value)
          : await applyLiveRevision(tx, conn, norm.value);
      await markRevisionImported(tx, conn.tenant_id, rev.id, id);
      return id;
    });
    return { status: "imported", reservationId: reservationId ?? null };
  } catch (e) {
    if (e instanceof QuarantineError) {
      await quarantineRevision(db, rev.id, e.message);
      await logChannelError(db, {
        tenantId: conn.tenant_id,
        connectionId: conn.id,
        code: "inbound_quarantine",
        message: e.message,
        context: { revision_id: rev.provider_revision_id, booking_id: rev.provider_booking_id },
      });
      return { status: "quarantined", reason: e.message };
    }
    const message = e instanceof Error ? e.message : "ייבוא הרוויזיה נכשל";
    await markRevisionFailed(db, rev.id, message);
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: "inbound_import_failed",
      message,
      context: { revision_id: rev.provider_revision_id },
    });
    return { status: "failed", error: message };
  }
}

// ---------------------------------------------------------------
// the pull job — feed → persist → import → ack (in that order, per revision)
// ---------------------------------------------------------------

function kindOf(attributes: unknown): "new" | "modified" | "cancelled" | null {
  const status =
    attributes && typeof attributes === "object"
      ? (attributes as Record<string, unknown>).status
      : null;
  return status === "new" || status === "modified" || status === "cancelled" ? status : null;
}

async function processFeedRevision(
  db: Sql,
  conn: InboundConnection,
  creds: ChannexReqOpts,
  rev: FeedRevision,
  summary: InboundPullSummary,
): Promise<void> {
  const norm = normalizeBookingRevision(rev.attributes);
  if (!norm.ok) {
    summary.failed += 1;
    summary.errors.push(norm.error);
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: "inbound_normalize_failed",
      message: norm.error,
      context: { revision_id: rev.id },
    });
    return;
  }

  // persist idempotently (payload is redacted + card staged inside)
  const persisted = await persistBookingRevision(db, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    providerBookingId: norm.value.bookingId,
    providerRevisionId: rev.id,
    uniqueId: norm.value.uniqueId ?? undefined,
    systemId: norm.value.systemId ?? undefined,
    otaReservationCode: norm.value.otaReservationCode ?? undefined,
    otaName: norm.value.otaName ?? undefined,
    revisionKind: kindOf(rev.attributes) ?? norm.value.kind,
    rawStatus: norm.value.kind,
    payload: rev.attributes,
  });
  const rowId = persisted.duplicate
    ? (
        await db<{ id: string }[]>`
          SELECT id FROM guesthub.channel_booking_revisions
          WHERE connection_id = ${conn.id} AND provider_revision_id = ${rev.id}`
      )[0]?.id
    : persisted.id;
  if (!rowId) {
    summary.failed += 1;
    summary.errors.push("רשומת הרוויזיה לא נשמרה");
    return;
  }

  const outcome = await importRevisionRow(db, conn, rowId);
  if (outcome.status === "imported") summary.imported += 1;
  else if (outcome.status === "already") summary.alreadyImported += 1;
  else if (outcome.status === "quarantined") {
    summary.quarantined += 1;
    summary.errors.push(outcome.reason);
    return; // NOT acknowledged — stays in the upstream feed, visibly parked
  } else {
    summary.failed += 1;
    summary.errors.push(outcome.error);
    return; // NOT acknowledged — retried by the next pull
  }

  // acknowledge ONLY now — the import transaction is durably committed.
  // markRevisionAcknowledged additionally refuses any row not 'imported'.
  const ack = await acknowledgeBookingRevision(creds, rev.id);
  if (ack.ok) {
    const marked = await markRevisionAcknowledged(db, rowId);
    if (marked) summary.acked += 1;
  } else {
    summary.errors.push(`אישור הרוויזיה נכשל: ${ack.message}`);
  }
}

// Re-ack sweep: rows durably imported whose earlier acknowledgement failed.
// A DEFINITE upstream "this revision is not pending" (404/422/409) is treated
// as already-acknowledged; an ambiguous failure stays unacknowledged for the
// next pull — never a blind retry loop.
async function reacknowledgeImported(
  db: Sql,
  conn: InboundConnection,
  creds: ChannexReqOpts,
  summary: InboundPullSummary,
): Promise<void> {
  const rows = await db<{ id: string; provider_revision_id: string }[]>`
    SELECT id, provider_revision_id FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${conn.id}
      AND ack_status = 'unacknowledged' AND import_status = 'imported'
    ORDER BY created_at
    LIMIT ${REACK_BATCH}`;
  for (const row of rows) {
    const ack = await acknowledgeBookingRevision(creds, row.provider_revision_id);
    const definiteNotPending =
      !ack.ok &&
      (ack.category === "not_found" || ack.category === "validation" || ack.category === "conflict");
    if (ack.ok || definiteNotPending) {
      const marked = await markRevisionAcknowledged(db, row.id);
      if (marked) summary.acked += 1;
    } else {
      summary.errors.push(`אישור חוזר נכשל: ${ack.message}`);
    }
  }
}

export async function runInboundPull(
  db: Sql,
  conn: InboundConnection,
  opts?: { revisionId?: string },
): Promise<InboundPullSummary> {
  const summary: InboundPullSummary = {
    pulled: 0,
    imported: 0,
    alreadyImported: 0,
    quarantined: 0,
    failed: 0,
    acked: 0,
    errors: [],
  };
  const creds = inboundCreds(conn);

  if (opts?.revisionId) {
    // controlled recovery (§10): ONE named revision through the SAME pipeline
    const res = await fetchBookingRevision(creds, opts.revisionId);
    if (!res.ok) {
      summary.errors.push(res.message);
      return summary;
    }
    summary.pulled = 1;
    await processFeedRevision(db, conn, creds, res.revision, summary);
  } else {
    // the feed returns ONLY unacknowledged revisions, oldest first; acking as
    // we go shifts pagination, so always re-read page 1 and stop when a page
    // brings nothing new (quarantined/failed rows stay in the feed by design)
    const seen = new Set<string>();
    for (let round = 0; round < MAX_FEED_ROUNDS; round++) {
      const page = await fetchBookingRevisionsFeed(creds, conn.channex_property_id, 1);
      if (!page.ok) {
        summary.errors.push(page.message);
        break;
      }
      const fresh = page.revisions.filter((r) => !seen.has(r.id));
      if (fresh.length === 0) break;
      for (const rev of fresh) {
        seen.add(rev.id);
        summary.pulled += 1;
        await processFeedRevision(db, conn, creds, rev, summary);
      }
      if (page.revisions.length < FEED_PAGE_LIMIT) break;
    }
  }

  await reacknowledgeImported(db, conn, creds, summary);

  if (summary.imported > 0) {
    await db`
      UPDATE guesthub.channel_connections SET last_inbound_import_at = now()
      WHERE id = ${conn.id}`;
  }
  return summary;
}
