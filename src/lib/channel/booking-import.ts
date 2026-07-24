import "server-only";
import type { Sql, TransactionSql } from "postgres";
import {
  markRevisionFailed,
  markRevisionImported,
  quarantineRevision,
} from "./revisions";
import {
  otaSourceKey,
  type NormalizedRevision,
  type NormalizedRoom,
} from "./booking-normalize";
import { markAriDirty } from "./outbox";
import {
  dispatchExternalChangeEmails,
  recordExternalDateChange,
  roomLabelsFor,
} from "./external-changes";
import { logChannelError } from "./queue";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { checkRoomAvailability, lockRooms, CONFLICT_LABEL } from "@/lib/inventory";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import {
  otaCancellationSnapshot,
  resolveCancellationSnapshot,
} from "@/lib/commercial/policy-snapshot";
import { nightsBetween, rangesOverlap } from "@/lib/dates";

// ============================================================
// Canonical inbound booking import core (D76/D78) — the ONE path from a
// provider booking revision to a GuestHub reservation. Consumed exclusively by
// the PM2 channel worker's pull_booking_revisions job (today: Beds24, via
// beds24-booking-import.ts); nothing here runs in a web request.
//
// INVARIANTS
//  • Identity: one reservation per (connection, booking_id) — enforced
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

// The provider-neutral subset the post-normalize import core needs (D77):
// identity only — never credentials, never a provider property id. Every
// InboundConnection is structurally assignable to it.
export type ImportConnection = {
  id: string;
  tenant_id: string;
};

// A domain condition that must PARK the revision visibly (unmapped room,
// wrong property, local conflict) — distinct from a transient failure.
class QuarantineError extends Error {}

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

// ---------------------------------------------------------------
// room resolution seam (D77/D78) — the ONE provider-specific step inside the
// otherwise provider-neutral import core. The provider adapter injects its
// resolver via ImportCoreOptions (Beds24: channel_beds24_room_mappings).
// An unresolvable room returns { error } and the core quarantines — never a
// guessed room.
// ---------------------------------------------------------------

export type RoomResolution = { roomId: string } | { error: string };
export type RoomResolver = (
  db: Sql | TransactionSql,
  room: NormalizedRoom,
) => Promise<RoomResolution>;

async function resolveStays(
  db: Sql | TransactionSql,
  conn: ImportConnection,
  rooms: NormalizedRoom[],
  resolveRoom: RoomResolver,
): Promise<ResolvedStay[]> {
  const stays: ResolvedStay[] = [];
  for (const room of rooms) {
    const resolved = await resolveRoom(db, room);
    if ("error" in resolved) {
      throw new QuarantineError(resolved.error);
    }
    // rate-plan association is the provider adapter's business (Beds24: the
    // designated plan lives on the room mapping; the imported price is the
    // channel's own, stored as a manual rate — D76/D78).
    const localRatePlanId: string | null = null;
    stays.push({
      roomId: resolved.roomId,
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
  // zip has no dedicated guests column — folded into the address line, never invented
  const address = [customer.address, customer.zip].filter(Boolean).join(", ") || null;
  if (existingGuestId) {
    await tx`
      UPDATE guesthub.guests SET
        first_name = ${customer.firstName}, last_name = ${customer.lastName},
        full_name = ${fullName},
        phone = COALESCE(${customer.phone}, phone),
        email = COALESCE(${customer.email}, email),
        address = COALESCE(${address}, address),
        city = COALESCE(${customer.city}, city),
        country = COALESCE(${customer.country}, country)
      WHERE id = ${existingGuestId} AND tenant_id = ${tenantId}`;
    return existingGuestId;
  }

  // ADR-0005 import dedup seam: before creating a new guest, reuse the canonical
  // guest matched by a STRONG key (normalized email). Only a UNIQUE match is
  // reused; zero or ambiguous (>1) matches fall through to a new record — never
  // a silent wrong merge (fail-visible, V2 §8). This stops the "new guest per
  // OTA booking" duplication (defect M24 foundation); operator merge UI = Stage 5.
  const dedupEmail = (customer.email ?? "").trim().toLowerCase() || null;
  if (dedupEmail) {
    const matches = await tx<{ id: string }[]>`
      SELECT id FROM guesthub.guests
      WHERE tenant_id = ${tenantId} AND lower(email) = ${dedupEmail} LIMIT 2`;
    if (matches.length === 1) {
      await tx`
        UPDATE guesthub.guests SET
          first_name = ${customer.firstName}, last_name = ${customer.lastName},
          full_name = ${fullName},
          phone = COALESCE(${customer.phone}, phone),
          email = COALESCE(${customer.email}, email),
          address = COALESCE(${address}, address),
          city = COALESCE(${customer.city}, city),
          country = COALESCE(${customer.country}, country)
        WHERE id = ${matches[0].id} AND tenant_id = ${tenantId}`;
      return matches[0].id;
    }
  }

  const [created] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.guests
      (tenant_id, first_name, last_name, full_name, phone, email, country, language,
       address, city)
    VALUES (${tenantId}, ${customer.firstName}, ${customer.lastName}, ${fullName},
            ${customer.phone}, ${customer.email}, ${customer.country}, ${customer.language},
            ${address}, ${customer.city})
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
  reservation_number: string;
  status: string;
  primary_guest_id: string | null;
  check_in: string;
  check_out: string;
  external_cancellation_requested_at: string | null;
};

async function lockExternalReservation(
  tx: TransactionSql,
  conn: ImportConnection,
  bookingId: string,
): Promise<{ existing: ExistingReservation | null; rrIds: string[]; oldRoomIds: string[] }> {
  const [existing] = await tx<ExistingReservation[]>`
    SELECT id, reservation_number, status, primary_guest_id,
           check_in::text AS check_in, check_out::text AS check_out,
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

// A quarantined revision that targets an EXISTING reservation with different
// dates is an unresolved external date change — recorded (idempotently, keyed
// by the revision) so the operator sees the OTA's dates even though the
// calendar still shows the old ones.
async function recordConflictDateChange(
  db: Sql,
  conn: ImportConnection,
  norm: NormalizedRevision,
  conflictDetail: string,
): Promise<void> {
  const [existing] = await db<
    { id: string; reservation_number: string; check_in: string; check_out: string }[]
  >`
    SELECT id, reservation_number, check_in::text AS check_in, check_out::text AS check_out
    FROM guesthub.reservations
    WHERE tenant_id = ${conn.tenant_id}
      AND channel_connection_id = ${conn.id}
      AND external_booking_id = ${norm.bookingId}`;
  if (!existing) return; // a brand-new booking in conflict — quarantine alone covers it
  const liveRooms = norm.rooms.filter((r) => !r.isCancelled);
  const newCheckIn = liveRooms.reduce(
    (m, r) => (r.checkinDate < m ? r.checkinDate : m),
    norm.arrivalDate,
  );
  const newCheckOut = liveRooms.reduce(
    (m, r) => (r.checkoutDate > m ? r.checkoutDate : m),
    norm.departureDate,
  );
  if (existing.check_in === newCheckIn && existing.check_out === newCheckOut) return;
  const roomRows = await db<{ room_id: string }[]>`
    SELECT room_id FROM guesthub.reservation_rooms
    WHERE reservation_id = ${existing.id} AND tenant_id = ${conn.tenant_id}
      AND room_id IS NOT NULL`;
  await recordExternalDateChange(db, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    providerRevisionId: norm.revisionId,
    providerBookingId: norm.bookingId,
    otaReservationCode: norm.otaReservationCode,
    otaName: norm.otaName,
    reservationId: existing.id,
    reservationNumber: existing.reservation_number,
    oldCheckIn: existing.check_in,
    oldCheckOut: existing.check_out,
    newCheckIn,
    newCheckOut,
    roomLabels: await roomLabelsFor(
      db,
      conn.tenant_id,
      roomRows.map((r) => r.room_id),
    ),
    applyStatus: "conflict",
    conflictDetail,
  });
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
  conn: ImportConnection,
  norm: NormalizedRevision,
  resolveRoom: RoomResolver,
): Promise<string> {
  const liveRooms = norm.rooms.filter((r) => !r.isCancelled);
  const stays = await resolveStays(tx, conn, liveRooms, resolveRoom);
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
        -- H6: preserve locally-added discount/extra_charges across an OTA
        -- modification. The channel total is folded through the reservation's
        -- own adjustments (reservationTotal semantics: max(0, channel+extra−disc))
        -- instead of blindly overwriting total_price with the raw channel amount.
        total_price = GREATEST(0, ${total} + extra_charges - discount_amount),
        currency = ${norm.currency ?? "ILS"},
        notes = ${norm.notes},
        expected_arrival_time = COALESCE(${norm.arrivalHour}, expected_arrival_time),
        expected_arrival_time_source = CASE
          WHEN ${norm.arrivalHour === null} THEN expected_arrival_time_source
          ELSE 'ota' END,
        cancellation_policy_snapshot = COALESCE(cancellation_policy_snapshot,
          ${norm.cancellation ? tx.json(otaCancellationSnapshot(norm.cancellation, norm.otaName) as never) : null}),
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
    // at-booking cancellation terms (034): the OTA's own imported terms win;
    // otherwise the mapped rate plan's template → tenant default template —
    // the same resolver the manual path uses. Multi-room bookings snapshot the
    // first stay's plan. NULL when nothing applies (nothing is fabricated).
    const cancellationSnapshot = norm.cancellation
      ? otaCancellationSnapshot(norm.cancellation, norm.otaName)
      : await resolveCancellationSnapshot(tx, conn.tenant_id, stays[0]?.localRatePlanId ?? null);
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, source_id, status,
         check_in, check_out, adults, children, infants,
         total_price, paid_amount, balance, currency, notes, expected_arrival_time,
         expected_arrival_time_source, cancellation_policy_snapshot,
         created_by, booking_origin,
         channel_connection_id, external_booking_id, external_revision_id,
         external_unique_id, ota_reservation_code, ota_name, external_booked_at,
         workflow_status_id)
      VALUES (${conn.tenant_id}, ${number}, ${guestId}, ${sourceId}, 'confirmed',
              ${agg.checkIn}, ${agg.checkOut},
              ${agg.adults}, ${agg.children}, ${agg.infants},
              ${total}, 0, ${total}, ${norm.currency ?? "ILS"}, ${norm.notes},
              ${norm.arrivalHour},
              ${norm.arrivalHour ? "ota" : null},
              ${cancellationSnapshot === null ? null : tx.json(cancellationSnapshot as never)},
              NULL, 'ota',
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
      arrival_hour: norm.arrivalHour,
      ota_commission: norm.otaCommission,
    },
    norm.otaName,
  );

  // an external revision MOVED an existing stay → one reconcilable
  // notification per revision, riding this transaction (exists iff durable)
  if (existing && (existing.check_in !== agg.checkIn || existing.check_out !== agg.checkOut)) {
    await recordExternalDateChange(tx, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      providerRevisionId: norm.revisionId,
      providerBookingId: norm.bookingId,
      otaReservationCode: norm.otaReservationCode,
      otaName: norm.otaName,
      reservationId: existing.id,
      reservationNumber: existing.reservation_number,
      oldCheckIn: existing.check_in,
      oldCheckOut: existing.check_out,
      newCheckIn: agg.checkIn,
      newCheckOut: agg.checkOut,
      roomLabels: await roomLabelsFor(tx, conn.tenant_id, roomIds),
      applyStatus: "applied",
    });
  }

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
  conn: ImportConnection,
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

export type ImportCoreOptions = {
  /** provider-specific room resolution — required; the core never guesses */
  resolveRoom: RoomResolver;
};

// The post-normalize import core (D77) — the SHARED half of importRevisionRow,
// lifted mechanically so a second provider (Hospitable) can feed its own
// normalized revisions through the identical transaction / quarantine /
// failure path. The caller has already: loaded the revision row, checked
// import_status, normalized the payload, and run its provider-specific
// property-ownership guard. `norm.revisionId` must equal the row's
// provider_revision_id and `norm.bookingId` its provider_booking_id.
export async function importNormalizedRevision(
  db: Sql,
  conn: ImportConnection,
  revisionRowId: string,
  norm: NormalizedRevision,
  opts: ImportCoreOptions,
): Promise<ImportOutcome> {
  const resolveRoom = opts.resolveRoom;
  try {
    const reservationId = await db.begin(async (tx) => {
      const id =
        norm.kind === "cancelled"
          ? await applyCancellation(tx, conn, norm)
          : await applyLiveRevision(tx, conn, norm, resolveRoom);
      await markRevisionImported(tx, conn.tenant_id, revisionRowId, id);
      return id;
    });
    return { status: "imported", reservationId: reservationId ?? null };
  } catch (e) {
    if (e instanceof QuarantineError) {
      await quarantineRevision(db, revisionRowId, e.message);
      await logChannelError(db, {
        tenantId: conn.tenant_id,
        connectionId: conn.id,
        code: "inbound_quarantine",
        message: e.message,
        context: { revision_id: norm.revisionId, booking_id: norm.bookingId },
      });
      // a PARKED revision that moves an EXISTING stay must still be visible as
      // an unresolved external change — the calendar keeps the old dates and
      // the OTA already regards the new ones as confirmed. Best-effort: a
      // failure here never masks the quarantine outcome.
      if (norm.kind !== "cancelled") {
        try {
          await recordConflictDateChange(db, conn, norm, e.message);
        } catch {
          /* the quarantine row itself remains the durable record */
        }
      }
      return { status: "quarantined", reason: e.message };
    }
    const message = e instanceof Error ? e.message : "ייבוא הרוויזיה נכשל";
    await markRevisionFailed(db, revisionRowId, message);
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: "inbound_import_failed",
      message,
      context: { revision_id: norm.revisionId },
    });
    return { status: "failed", error: message };
  }
}
