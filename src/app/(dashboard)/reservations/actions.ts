"use server";

import { revalidatePath } from "next/cache";
import type { TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { addDays, eachDay, nightsBetween, rangesOverlap, type DateOnly } from "@/lib/dates";
import {
  checkRoomAvailability,
  lockRooms,
  getRoomCapacities,
  getRateRows,
  CONFLICT_LABEL,
  INVENTORY_BLOCKING_STATUSES,
} from "@/lib/inventory";
import {
  capacityViolation,
  effectiveNightlyPrice,
  restrictionViolation,
  resolveRate,
} from "@/lib/inventory-rules";
import { markAriDirty } from "@/lib/channel/outbox";
import {
  createReservationSchema,
  updateReservationSchema,
  rescheduleSchema,
  type CreateReservationInput,
  type UpdateReservationInput,
  type ExistingRoomStayInput,
} from "@/lib/validation/reservation";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// Domain failure that should surface as a friendly toast (vs unexpected 500).
class DomainError extends Error {}

const fail = (error: string): ActionResult<never> => ({ success: false, error });

function errorMessage(e: unknown): string {
  if (e instanceof AuthorizationError || e instanceof DomainError) return e.message;
  console.error("[reservations]", e);
  return "אירעה שגיאה בלתי צפויה";
}

const isBlocking = (status: string) =>
  (INVENTORY_BLOCKING_STATUSES as readonly string[]).includes(status);

// ---------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------

type StayInput = ExistingRoomStayInput; // superset of the create stay (rrId optional)

type RoomMeta = { id: string; room_type_id: string | null; base_price: number };

async function loadRoomMeta(
  db: TransactionSql,
  tenantId: string,
  roomIds: string[],
): Promise<Map<string, RoomMeta>> {
  const rows = await db<RoomMeta[]>`
    SELECT r.id, r.room_type_id, COALESCE(rt.base_price, 0)::float8 AS base_price
    FROM guesthub.rooms r
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE r.tenant_id = ${tenantId} AND r.id = ANY(${roomIds}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

// The same room may not be requested twice for overlapping nights inside one
// reservation (the DB check excludes the reservation's own rows on edit, so
// internal overlaps are validated here — pure, same overlap rule).
function assertNoInternalOverlap(stays: StayInput[]): void {
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      if (
        stays[i].roomId === stays[j].roomId &&
        rangesOverlap(stays[i].checkIn, stays[i].checkOut, stays[j].checkIn, stays[j].checkOut)
      ) {
        throw new DomainError("אותו חדר נבחר פעמיים בתאריכים חופפים");
      }
    }
  }
}

type PricedStay = StayInput & { ratePerNight: number; priceTotal: number; nights: number };

// Full server-side gate for a set of stays: availability (incl. closures +
// room status), capacity, stay restrictions, effective pricing. Runs inside
// the caller's transaction AFTER lockRooms. `skip` lets a status-only edit
// bypass re-validating untouched stays (§F) — inventory consumption changes
// are still availability-checked by the caller.
async function validateAndPriceStays(
  tx: TransactionSql,
  tenantId: string,
  stays: StayInput[],
  opts: {
    excludeRrIds?: string[];
    enforceAvailability: boolean;
    enforceRestrictions: boolean;
    skipChecksForRr?: Set<string>;
  },
): Promise<PricedStay[]> {
  assertNoInternalOverlap(stays);
  const roomIds = [...new Set(stays.map((s) => s.roomId))];
  const meta = await loadRoomMeta(tx, tenantId, roomIds);
  if (meta.size !== roomIds.length) throw new DomainError("חדר לא נמצא");
  const caps = await getRoomCapacities(tx, tenantId, roomIds);

  const priced: PricedStay[] = [];
  for (const stay of stays) {
    const skip = stay.rrId != null && opts.skipChecksForRr?.has(stay.rrId);
    const m = meta.get(stay.roomId)!;

    if (!skip && opts.enforceAvailability) {
      const conflicts = await checkRoomAvailability(tx, {
        tenantId,
        roomIds: [stay.roomId],
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        excludeReservationRoomIds: opts.excludeRrIds,
      });
      if (conflicts.length > 0) throw new DomainError(CONFLICT_LABEL[conflicts[0].conflict_kind]);
    }

    if (!skip) {
      const cap = caps.get(stay.roomId);
      if (!cap) throw new DomainError("חדר לא נמצא");
      const capErr = capacityViolation(cap, stay);
      if (capErr) throw new DomainError(capErr);
    }

    const rateRows = await getRateRows(
      tx, tenantId, stay.roomId, m.room_type_id, stay.checkIn, stay.checkOut,
    );
    if (!skip && opts.enforceRestrictions) {
      const restrictionErr = restrictionViolation(
        rateRows,
        { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: eachDay(stay.checkIn, stay.checkOut) },
        stay.roomId,
        m.room_type_id,
      );
      if (restrictionErr) throw new DomainError(restrictionErr);
    }

    const nights = nightsBetween(stay.checkIn, stay.checkOut);
    let priceTotal: number;
    let ratePerNight: number;
    if (stay.ratePerNight != null) {
      ratePerNight = stay.ratePerNight;
      priceTotal = ratePerNight * nights;
    } else {
      priceTotal = eachDay(stay.checkIn, stay.checkOut).reduce(
        (sum, d) => sum + effectiveNightlyPrice(rateRows, d, stay.roomId, m.room_type_id, m.base_price),
        0,
      );
      ratePerNight = nights > 0 ? Math.round((priceTotal / nights) * 100) / 100 : 0;
    }
    priced.push({ ...stay, ratePerNight, priceTotal, nights });
  }
  return priced;
}

function aggregates(stays: PricedStay[], discount: number) {
  const checkIn = stays.reduce((m, s) => (s.checkIn < m ? s.checkIn : m), stays[0].checkIn);
  const checkOut = stays.reduce((m, s) => (s.checkOut > m ? s.checkOut : m), stays[0].checkOut);
  const roomsTotal = stays.reduce((sum, s) => sum + s.priceTotal, 0);
  return {
    checkIn,
    checkOut,
    adults: stays.reduce((n, s) => n + s.adults, 0),
    children: stays.reduce((n, s) => n + s.children, 0),
    infants: stays.reduce((n, s) => n + s.infants, 0),
    total: Math.max(0, roomsTotal - discount),
  };
}

// Per-tenant running reservation number. The tenant row is locked for the
// transaction, serializing allocations (unique index is the hard backstop).
async function allocateReservationNumber(tx: TransactionSql, tenantId: string): Promise<string> {
  await tx`SELECT id FROM guesthub.tenants WHERE id = ${tenantId} FOR UPDATE`;
  const [row] = await tx<{ next: string }[]>`
    SELECT (COALESCE(MAX(NULLIF(regexp_replace(reservation_number, '\\D', '', 'g'), '')::bigint), 1000) + 1)::text AS next
    FROM guesthub.reservations WHERE tenant_id = ${tenantId}`;
  return row.next;
}

async function upsertGuest(
  tx: TransactionSql,
  tenantId: string,
  guest: CreateReservationInput["guest"],
): Promise<string> {
  const fullName = `${guest.firstName} ${guest.lastName}`.trim();
  if (guest.id) {
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM guesthub.guests WHERE id = ${guest.id} AND tenant_id = ${tenantId}`;
    if (!existing) throw new DomainError("אורח לא נמצא");
    await tx`
      UPDATE guesthub.guests SET
        first_name = ${guest.firstName}, last_name = ${guest.lastName},
        full_name = ${fullName},
        phone = COALESCE(${guest.phone ?? null}, phone),
        email = COALESCE(${guest.email || null}, email),
        id_number = COALESCE(${guest.idNumber ?? null}, id_number)
      WHERE id = ${guest.id} AND tenant_id = ${tenantId}`;
    return guest.id;
  }
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.guests
      (tenant_id, first_name, last_name, full_name, phone, email, id_number, country, language)
    VALUES (${tenantId}, ${guest.firstName}, ${guest.lastName}, ${fullName},
            ${guest.phone ?? null}, ${guest.email || null}, ${guest.idNumber ?? null},
            ${guest.country ?? null}, ${guest.language ?? null})
    RETURNING id`;
  return created.id;
}

const stayGuestCols = (s: StayInput) => ({
  guest_first_name: s.guestFirstName || null,
  guest_last_name: s.guestLastName || null,
  guest_phone: s.guestPhone || null,
  guest_email: s.guestEmail || null,
  guest_id_number: s.guestIdNumber || null,
});

// ---------------------------------------------------------------
// create
// ---------------------------------------------------------------
export async function createReservationAction(
  raw: CreateReservationInput,
): Promise<ActionResult<{ reservationId: string; reservationNumber: string }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.create");
    const parsed = createReservationSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    const result = await sql.begin(async (tx) => {
      await lockRooms(tx, actor.tenantId, input.rooms.map((r) => r.roomId));
      const priced = await validateAndPriceStays(tx, actor.tenantId, input.rooms, {
        enforceAvailability: true,
        enforceRestrictions: true,
      });

      const guestId = await upsertGuest(tx, actor.tenantId, input.guest);
      const number = await allocateReservationNumber(tx, actor.tenantId);
      const discount = input.discountAmount ?? 0;
      const agg = aggregates(priced, discount);
      const paid = input.paidAmount ?? 0;

      const [res] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.reservations
          (tenant_id, reservation_number, primary_guest_id, source_id, status,
           check_in, check_out, adults, children, infants,
           discount_amount, total_price, paid_amount, balance, currency,
           notes, created_by)
        VALUES (${actor.tenantId}, ${number}, ${guestId}, ${input.sourceId ?? null},
                ${input.status}, ${agg.checkIn}, ${agg.checkOut},
                ${agg.adults}, ${agg.children}, ${agg.infants},
                ${discount}, ${agg.total}, ${paid}, ${agg.total - paid}, 'ILS',
                ${input.notes || null}, ${actor.userId})
        RETURNING id`;

      for (const s of priced) {
        await tx`
          INSERT INTO guesthub.reservation_rooms ${tx({
            tenant_id: actor.tenantId,
            reservation_id: res.id,
            room_id: s.roomId,
            check_in: s.checkIn,
            check_out: s.checkOut,
            adults: s.adults,
            children: s.children,
            infants: s.infants,
            rate_per_night: s.ratePerNight,
            price_total: s.priceTotal,
            ...stayGuestCols(s),
          })}`;
      }

      if (paid > 0) {
        await tx`
          INSERT INTO guesthub.payments
            (tenant_id, reservation_id, amount, method, status, paid_at)
          VALUES (${actor.tenantId}, ${res.id}, ${paid},
                  ${input.paymentMethod ?? null}, 'paid', now())`;
      }

      await writeAudit(actor, {
        entityType: "reservation",
        entityId: res.id,
        action: "create",
        after: { number, status: input.status, rooms: priced.length, total: agg.total },
      }, tx);

      if (isBlocking(input.status)) {
        const meta = await loadRoomMeta(tx, actor.tenantId, priced.map((s) => s.roomId));
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomTypeIds: priced.map((s) => meta.get(s.roomId)?.room_type_id ?? null),
          dateFrom: agg.checkIn,
          dateTo: agg.checkOut,
        });
      }
      return { reservationId: res.id, reservationNumber: number };
    });

    revalidatePath("/calendar");
    return { success: true, data: result };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// update (full edit panel — never cancels; see cancelReservationAction)
// ---------------------------------------------------------------
export async function updateReservationAction(
  raw: UpdateReservationInput,
): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const parsed = updateReservationSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    await sql.begin(async (tx) => {
      const [existing] = await tx<
        { id: string; status: string; primary_guest_id: string | null; check_in: string; check_out: string;
          discount_amount: string; extra_charges: string; paid_amount: string }[]
      >`
        SELECT id, status, primary_guest_id, check_in::text, check_out::text,
               discount_amount, extra_charges, paid_amount
        FROM guesthub.reservations
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}
        FOR UPDATE`;
      if (!existing) throw new DomainError("הזמנה לא נמצאה");
      if (existing.status === "cancelled") throw new DomainError("הזמנה מבוטלת — לא ניתן לערוך");

      const oldRows = await tx<
        { id: string; room_id: string | null; check_in: string; check_out: string;
          adults: number; children: number; infants: number; room_type_id: string | null }[]
      >`
        SELECT rr.id, rr.room_id, rr.check_in::text, rr.check_out::text,
               rr.adults, rr.children, rr.infants, r.room_type_id
        FROM guesthub.reservation_rooms rr
        LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
        WHERE rr.reservation_id = ${input.id} AND rr.tenant_id = ${actor.tenantId}`;
      const oldById = new Map(oldRows.map((r) => [r.id, r]));

      // stays whose room/dates/occupancy are untouched skip re-validation —
      // a status-only edit can never fail on capacity it already holds (§F)
      const skipChecksForRr = new Set<string>();
      for (const s of input.rooms) {
        if (!s.rrId) continue;
        const old = oldById.get(s.rrId);
        if (!old) throw new DomainError("חדר הזמנה לא נמצא");
        if (
          old.room_id === s.roomId &&
          old.check_in === s.checkIn && old.check_out === s.checkOut &&
          old.adults === s.adults && old.children === s.children && old.infants === s.infants
        ) {
          skipChecksForRr.add(s.rrId);
        }
      }

      const wasBlocking = isBlocking(existing.status);
      const nowBlocking = isBlocking(input.status);
      // starting to consume inventory (e.g. draft → confirmed) must re-prove
      // availability for ALL stays, even untouched ones
      if (!wasBlocking && nowBlocking) skipChecksForRr.clear();

      const allRoomIds = [
        ...new Set([
          ...input.rooms.map((s) => s.roomId),
          ...oldRows.map((r) => r.room_id).filter((x): x is string => !!x),
        ]),
      ];
      await lockRooms(tx, actor.tenantId, allRoomIds);

      const priced = await validateAndPriceStays(tx, actor.tenantId, input.rooms, {
        excludeRrIds: oldRows.map((r) => r.id),
        enforceAvailability: nowBlocking,
        enforceRestrictions: nowBlocking,
        skipChecksForRr,
      });

      const guestId = await upsertGuest(tx, actor.tenantId, {
        ...input.guest,
        id: input.guest.id ?? existing.primary_guest_id ?? undefined,
      });

      // apply room rows: delete removed, update kept, insert new
      const keptIds = new Set(input.rooms.map((s) => s.rrId).filter(Boolean) as string[]);
      const removed = oldRows.filter((r) => !keptIds.has(r.id));
      if (removed.length > 0) {
        await tx`
          DELETE FROM guesthub.reservation_rooms
          WHERE id = ANY(${removed.map((r) => r.id)}::uuid[]) AND tenant_id = ${actor.tenantId}`;
      }
      for (const s of priced) {
        const cols = {
          room_id: s.roomId,
          check_in: s.checkIn,
          check_out: s.checkOut,
          adults: s.adults,
          children: s.children,
          infants: s.infants,
          rate_per_night: s.ratePerNight,
          price_total: s.priceTotal,
          ...stayGuestCols(s),
        };
        if (s.rrId) {
          await tx`
            UPDATE guesthub.reservation_rooms SET ${tx(cols)}
            WHERE id = ${s.rrId} AND tenant_id = ${actor.tenantId}`;
        } else {
          await tx`
            INSERT INTO guesthub.reservation_rooms ${tx({
              tenant_id: actor.tenantId,
              reservation_id: input.id,
              ...cols,
            })}`;
        }
      }

      const discount = input.discountAmount ?? Number(existing.discount_amount);
      const agg = aggregates(priced, discount);
      const extra = Number(existing.extra_charges);
      const total = Math.max(0, agg.total + extra);
      const addPay = input.additionalPayment ?? 0;
      const paid = Number(existing.paid_amount) + addPay;

      await tx`
        UPDATE guesthub.reservations SET
          primary_guest_id = ${guestId},
          source_id = ${input.sourceId ?? null},
          status = ${input.status},
          check_in = ${agg.checkIn}, check_out = ${agg.checkOut},
          adults = ${agg.adults}, children = ${agg.children}, infants = ${agg.infants},
          discount_amount = ${discount},
          total_price = ${total}, paid_amount = ${paid}, balance = ${total - paid},
          notes = ${input.notes || null}
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;

      if (addPay > 0) {
        await tx`
          INSERT INTO guesthub.payments
            (tenant_id, reservation_id, amount, method, status, paid_at)
          VALUES (${actor.tenantId}, ${input.id}, ${addPay},
                  ${input.paymentMethod ?? null}, 'paid', now())`;
      }

      await writeAudit(actor, {
        entityType: "reservation",
        entityId: input.id,
        action: "update",
        before: { status: existing.status, check_in: existing.check_in, check_out: existing.check_out, rooms: oldRows.length },
        after: { status: input.status, check_in: agg.checkIn, check_out: agg.checkOut, rooms: priced.length, total },
      }, tx);

      // dirty when inventory consumption changed on either side
      if (wasBlocking || nowBlocking) {
        const meta = await loadRoomMeta(tx, actor.tenantId, allRoomIds);
        const dates = [
          existing.check_in, existing.check_out, agg.checkIn, agg.checkOut,
        ].sort();
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomTypeIds: [
            ...oldRows.map((r) => r.room_type_id),
            ...priced.map((s) => meta.get(s.roomId)?.room_type_id ?? null),
          ],
          dateFrom: dates[0],
          dateTo: dates[dates.length - 1],
        });
      }
    });

    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// cancel
// ---------------------------------------------------------------
export async function cancelReservationAction(id: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.cancel");
    await sql.begin(async (tx) => {
      const [res] = await tx<
        { id: string; status: string; check_in: string; check_out: string }[]
      >`
        SELECT id, status, check_in::text, check_out::text
        FROM guesthub.reservations
        WHERE id = ${id} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!res) throw new DomainError("הזמנה לא נמצאה");
      if (res.status === "cancelled") return;

      await tx`
        UPDATE guesthub.reservations SET status = 'cancelled'
        WHERE id = ${id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: id,
        action: "cancel",
        before: { status: res.status },
        after: { status: "cancelled" },
      }, tx);

      if (isBlocking(res.status)) {
        const types = await tx<{ room_type_id: string | null }[]>`
          SELECT r.room_type_id FROM guesthub.reservation_rooms rr
          JOIN guesthub.rooms r ON r.id = rr.room_id
          WHERE rr.reservation_id = ${id} AND rr.tenant_id = ${actor.tenantId}`;
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomTypeIds: types.map((t) => t.room_type_id),
          dateFrom: res.check_in,
          dateTo: res.check_out,
        });
      }
    });
    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// calendar move / resize — one server-validated commit (§J)
// ---------------------------------------------------------------
export async function rescheduleReservationRoomAction(raw: {
  rrId: string;
  targetRoomId: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
}): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const parsed = rescheduleSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    await sql.begin(async (tx) => {
      const [rr] = await tx<
        {
          id: string; reservation_id: string; room_id: string | null;
          check_in: string; check_out: string;
          adults: number; children: number; infants: number;
          rate_per_night: string; status: string;
          old_room_type: string | null;
        }[]
      >`
        SELECT rr.id, rr.reservation_id, rr.room_id,
               rr.check_in::text, rr.check_out::text,
               rr.adults, rr.children, rr.infants, rr.rate_per_night,
               res.status, r.room_type_id AS old_room_type
        FROM guesthub.reservation_rooms rr
        JOIN guesthub.reservations res ON res.id = rr.reservation_id
        LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
        WHERE rr.id = ${input.rrId} AND rr.tenant_id = ${actor.tenantId}
        FOR UPDATE OF rr, res`;
      if (!rr) throw new DomainError("הזמנה לא נמצאה");
      if (rr.status === "cancelled") throw new DomainError("הזמנה מבוטלת — לא ניתן להזיז");

      const lockIds = [input.targetRoomId, ...(rr.room_id ? [rr.room_id] : [])];
      await lockRooms(tx, actor.tenantId, lockIds);

      const blocking = isBlocking(rr.status);
      const priced = await validateAndPriceStays(
        tx,
        actor.tenantId,
        [{
          rrId: rr.id,
          roomId: input.targetRoomId,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          adults: rr.adults,
          children: rr.children,
          infants: rr.infants,
          // room change → reprice from the target room's rates; date-only
          // change keeps the committed nightly rate (guest-agreed price)
          ratePerNight: rr.room_id === input.targetRoomId ? Number(rr.rate_per_night) : undefined,
        }],
        {
          excludeRrIds: [rr.id],
          enforceAvailability: true, // even drafts must not be dropped onto closures/unsellable rooms
          enforceRestrictions: blocking,
        },
      );
      const s = priced[0];

      await tx`
        UPDATE guesthub.reservation_rooms SET
          room_id = ${s.roomId}, check_in = ${s.checkIn}, check_out = ${s.checkOut},
          rate_per_night = ${s.ratePerNight}, price_total = ${s.priceTotal}
        WHERE id = ${rr.id} AND tenant_id = ${actor.tenantId}`;

      // recompute parent aggregates from ALL rooms
      await tx`
        UPDATE guesthub.reservations res SET
          check_in = x.min_ci, check_out = x.max_co,
          total_price = GREATEST(0, x.rooms_total - res.discount_amount + res.extra_charges),
          balance = GREATEST(0, x.rooms_total - res.discount_amount + res.extra_charges) - res.paid_amount
        FROM (
          SELECT MIN(check_in) AS min_ci, MAX(check_out) AS max_co,
                 COALESCE(SUM(price_total), 0) AS rooms_total
          FROM guesthub.reservation_rooms
          WHERE reservation_id = ${rr.reservation_id} AND tenant_id = ${actor.tenantId}
        ) x
        WHERE res.id = ${rr.reservation_id} AND res.tenant_id = ${actor.tenantId}`;

      await writeAudit(actor, {
        entityType: "reservation_room",
        entityId: rr.id,
        action: "reschedule",
        before: { room_id: rr.room_id, check_in: rr.check_in, check_out: rr.check_out },
        after: { room_id: s.roomId, check_in: s.checkIn, check_out: s.checkOut },
      }, tx);

      if (blocking) {
        const meta = await loadRoomMeta(tx, actor.tenantId, lockIds);
        const dates = [rr.check_in, rr.check_out, s.checkIn, s.checkOut].sort();
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomTypeIds: [rr.old_room_type, meta.get(s.roomId)?.room_type_id ?? null],
          dateFrom: dates[0],
          dateTo: dates[dates.length - 1],
        });
      }
    });

    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// reads for the booking / edit panels
// ---------------------------------------------------------------

export async function searchGuestsAction(q: string): Promise<
  ActionResult<{ id: string; full_name: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; id_number: string | null }[]>
> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.create");
    const term = q.trim();
    if (term.length < 2) return { success: true, data: [] };
    const like = `%${term}%`;
    const rows = await sql<
      { id: string; full_name: string; first_name: string | null; last_name: string | null; phone: string | null; email: string | null; id_number: string | null }[]
    >`
      SELECT id, full_name, first_name, last_name, phone, email, id_number
      FROM guesthub.guests
      WHERE tenant_id = ${actor.tenantId}
        AND (full_name ILIKE ${like} OR phone ILIKE ${like} OR email ILIKE ${like})
        AND is_blocked = false
      ORDER BY full_name LIMIT 8`;
    return { success: true, data: rows };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// Free, sellable rooms for a window (booking panel room picker) with the
// resolved average nightly price.
export async function getAvailableRoomsAction(args: {
  checkIn: DateOnly;
  checkOut: DateOnly;
  excludeReservationId?: string;
}): Promise<
  ActionResult<{
    id: string; room_number: string; name: string | null;
    room_type_id: string | null; room_type_name: string | null;
    max_occupancy: number; max_adults: number; max_children: number; max_infants: number;
    avg_price: number; free: boolean;
  }[]>
> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.create");
    if (!(args.checkIn < args.checkOut)) return fail("טווח תאריכים לא תקין");
    if (nightsBetween(args.checkIn, args.checkOut) > 90) return fail("טווח ארוך מדי");

    const rooms = await sql<
      { id: string; room_number: string; name: string | null; room_type_id: string | null;
        room_type_name: string | null; base_price: number;
        max_occupancy: number; max_adults: number; max_children: number; max_infants: number }[]
    >`
      SELECT r.id, r.room_number, r.name, r.room_type_id, rt.name AS room_type_name,
             COALESCE(rt.base_price, 0)::float8 AS base_price,
             r.max_occupancy, r.max_adults, r.max_children, r.max_infants
      FROM guesthub.rooms r
      LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
      WHERE r.tenant_id = ${actor.tenantId} AND r.status = 'available' AND r.is_active
      ORDER BY r.room_number`;

    const excludeRr = args.excludeReservationId
      ? (
          await sql<{ id: string }[]>`
            SELECT id FROM guesthub.reservation_rooms
            WHERE reservation_id = ${args.excludeReservationId} AND tenant_id = ${actor.tenantId}`
        ).map((r) => r.id)
      : [];

    const conflicts = await checkRoomAvailability(sql, {
      tenantId: actor.tenantId,
      roomIds: rooms.map((r) => r.id),
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      excludeReservationRoomIds: excludeRr,
    });
    const busy = new Set(conflicts.map((c) => c.room_id));

    const rates = await sql<
      { date: string; room_id: string | null; room_type_id: string | null; price: number | null;
        min_nights: number | null; max_nights: number | null;
        closed: boolean; closed_to_arrival: boolean; closed_to_departure: boolean }[]
    >`
      SELECT date::text AS date, room_id, room_type_id, price::float8 AS price,
             min_nights, max_nights, closed, closed_to_arrival, closed_to_departure
      FROM guesthub.rates
      WHERE tenant_id = ${actor.tenantId}
        AND date >= ${args.checkIn} AND date < ${args.checkOut}`;

    const nights = eachDay(args.checkIn, args.checkOut);
    const data = rooms.map((r) => {
      const total = nights.reduce(
        (sum, d) => sum + effectiveNightlyPrice(rates, d, r.id, r.room_type_id, r.base_price),
        0,
      );
      return {
        id: r.id,
        room_number: r.room_number,
        name: r.name,
        room_type_id: r.room_type_id,
        room_type_name: r.room_type_name,
        max_occupancy: r.max_occupancy,
        max_adults: r.max_adults,
        max_children: r.max_children,
        max_infants: r.max_infants,
        avg_price: nights.length > 0 ? Math.round(total / nights.length) : 0,
        free: !busy.has(r.id),
      };
    });
    return { success: true, data };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// Price + restrictions quote for one room stay (booking panel step 2, and the
// dblclick default-checkout rule: arrival-date min_nights wins over 1 night).
export async function getStayQuoteAction(args: {
  roomId: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
}): Promise<ActionResult<{ nights: number; total: number; ratePerNight: number; restriction: string | null }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.create");
    if (!(args.checkIn < args.checkOut)) return fail("טווח תאריכים לא תקין");
    const [room] = await sql<{ id: string; room_type_id: string | null; base_price: number }[]>`
      SELECT r.id, r.room_type_id, COALESCE(rt.base_price, 0)::float8 AS base_price
      FROM guesthub.rooms r LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
      WHERE r.id = ${args.roomId} AND r.tenant_id = ${actor.tenantId}`;
    if (!room) return fail("חדר לא נמצא");
    const rateRows = await getRateRows(
      sql, actor.tenantId, room.id, room.room_type_id, args.checkIn, args.checkOut,
    );
    const nights = eachDay(args.checkIn, args.checkOut);
    const total = nights.reduce(
      (sum, d) => sum + effectiveNightlyPrice(rateRows, d, room.id, room.room_type_id, room.base_price),
      0,
    );
    const restriction = restrictionViolation(
      rateRows,
      { checkIn: args.checkIn, checkOut: args.checkOut, nights },
      room.id,
      room.room_type_id,
    );
    return {
      success: true,
      data: {
        nights: nights.length,
        total,
        ratePerNight: nights.length ? Math.round((total / nights.length) * 100) / 100 : 0,
        restriction,
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// Default checkout for an empty-cell double-click: at least one hotel night,
// stretched to the arrival date's min_nights when one applies (§G).
export async function getDefaultCheckoutAction(args: {
  roomId: string;
  checkIn: DateOnly;
}): Promise<ActionResult<{ checkOut: DateOnly }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.create");
    const [room] = await sql<{ id: string; room_type_id: string | null }[]>`
      SELECT id, room_type_id FROM guesthub.rooms
      WHERE id = ${args.roomId} AND tenant_id = ${actor.tenantId}`;
    if (!room) return fail("חדר לא נמצא");
    const rateRows = await getRateRows(
      sql, actor.tenantId, room.id, room.room_type_id, args.checkIn, args.checkIn,
    );
    const arrival = resolveRate(rateRows, args.checkIn, room.id, room.room_type_id);
    const nights = Math.max(1, arrival?.min_nights ?? 1);
    return { success: true, data: { checkOut: addDays(args.checkIn, nights) } };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// Full reservation detail for the edit panel (all rooms, per-room guests,
// pricing, payments, activity trail).
export type ReservationDetail = {
  id: string;
  reservation_number: string;
  status: string;
  source_id: string | null;
  notes: string | null;
  discount_amount: number;
  extra_charges: number;
  total_price: number;
  paid_amount: number;
  balance: number;
  created_at: string;
  updated_at: string;
  guest: {
    id: string | null;
    first_name: string;
    last_name: string;
    phone: string | null;
    email: string | null;
    id_number: string | null;
  };
  source_label: string | null;
  rooms: {
    rrId: string;
    roomId: string;
    roomLabel: string;
    roomTypeName: string | null;
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    infants: number;
    ratePerNight: number;
    priceTotal: number;
    guestFirstName: string | null;
    guestLastName: string | null;
    guestPhone: string | null;
    guestEmail: string | null;
    guestIdNumber: string | null;
  }[];
  payments: { id: string; amount: number; method: string | null; paid_at: string | null }[];
  activity: { action: string; created_at: string; user_name: string | null }[];
};

export async function getReservationAction(id: string): Promise<ActionResult<ReservationDetail>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.view");
    const [res] = await sql<
      {
        id: string; reservation_number: string; status: string; source_id: string | null;
        notes: string | null; discount_amount: number; extra_charges: number;
        total_price: number; paid_amount: number; balance: number;
        created_at: string; updated_at: string;
        guest_id: string | null; g_first: string | null; g_last: string | null; g_full: string | null;
        g_phone: string | null; g_email: string | null; g_idnum: string | null;
        source_label: string | null;
      }[]
    >`
      SELECT res.id, res.reservation_number, res.status, res.source_id, res.notes,
             res.discount_amount::float8 AS discount_amount,
             res.extra_charges::float8 AS extra_charges,
             res.total_price::float8 AS total_price,
             res.paid_amount::float8 AS paid_amount,
             res.balance::float8 AS balance,
             res.created_at::text AS created_at, res.updated_at::text AS updated_at,
             g.id AS guest_id, g.first_name AS g_first, g.last_name AS g_last,
             g.full_name AS g_full, g.phone AS g_phone, g.email AS g_email,
             g.id_number AS g_idnum,
             src.label AS source_label
      FROM guesthub.reservations res
      LEFT JOIN guesthub.guests g ON g.id = res.primary_guest_id
      LEFT JOIN guesthub.lookup_items src ON src.id = res.source_id
      WHERE res.id = ${id} AND res.tenant_id = ${actor.tenantId}`;
    if (!res) return fail("הזמנה לא נמצאה");

    const rooms = await sql<
      {
        rr_id: string; room_id: string; room_label: string; room_type_name: string | null;
        check_in: string; check_out: string; adults: number; children: number; infants: number;
        rate_per_night: number; price_total: number;
        guest_first_name: string | null; guest_last_name: string | null;
        guest_phone: string | null; guest_email: string | null; guest_id_number: string | null;
      }[]
    >`
      SELECT rr.id AS rr_id, rr.room_id,
             COALESCE(r.name, r.room_number, '—') AS room_label,
             rt.name AS room_type_name,
             rr.check_in::text AS check_in, rr.check_out::text AS check_out,
             rr.adults, rr.children, rr.infants,
             rr.rate_per_night::float8 AS rate_per_night,
             rr.price_total::float8 AS price_total,
             rr.guest_first_name, rr.guest_last_name, rr.guest_phone,
             rr.guest_email, rr.guest_id_number
      FROM guesthub.reservation_rooms rr
      LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
      LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
      WHERE rr.reservation_id = ${id} AND rr.tenant_id = ${actor.tenantId}
      ORDER BY rr.check_in, r.room_number`;

    const payments = await sql<{ id: string; amount: number; method: string | null; paid_at: string | null }[]>`
      SELECT id, amount::float8 AS amount, method, paid_at::text AS paid_at
      FROM guesthub.payments
      WHERE reservation_id = ${id} AND tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC LIMIT 20`;

    const activity = await sql<{ action: string; created_at: string; user_name: string | null }[]>`
      SELECT a.action, a.created_at::text AS created_at, u.full_name AS user_name
      FROM guesthub.audit_logs a
      LEFT JOIN guesthub.users u ON u.id = a.user_id
      WHERE a.tenant_id = ${actor.tenantId}
        AND ((a.entity_type = 'reservation' AND a.entity_id = ${id})
          OR (a.entity_type = 'reservation_room'
              AND a.entity_id IN (SELECT rr2.id FROM guesthub.reservation_rooms rr2 WHERE rr2.reservation_id = ${id})))
      ORDER BY a.created_at DESC LIMIT 10`;

    const [first, ...rest] = (res.g_full ?? "").split(" ");
    return {
      success: true,
      data: {
        id: res.id,
        reservation_number: res.reservation_number,
        status: res.status,
        source_id: res.source_id,
        notes: res.notes,
        discount_amount: res.discount_amount,
        extra_charges: res.extra_charges,
        total_price: res.total_price,
        paid_amount: res.paid_amount,
        balance: res.balance,
        created_at: res.created_at,
        updated_at: res.updated_at,
        guest: {
          id: res.guest_id,
          first_name: res.g_first ?? first ?? "",
          last_name: res.g_last ?? rest.join(" "),
          phone: res.g_phone,
          email: res.g_email,
          id_number: res.g_idnum,
        },
        source_label: res.source_label,
        rooms: rooms.map((r) => ({
          rrId: r.rr_id,
          roomId: r.room_id,
          roomLabel: r.room_label,
          roomTypeName: r.room_type_name,
          checkIn: r.check_in,
          checkOut: r.check_out,
          adults: r.adults,
          children: r.children,
          infants: r.infants,
          ratePerNight: r.rate_per_night,
          priceTotal: r.price_total,
          guestFirstName: r.guest_first_name,
          guestLastName: r.guest_last_name,
          guestPhone: r.guest_phone,
          guestEmail: r.guest_email,
          guestIdNumber: r.guest_id_number,
        })),
        payments,
        activity,
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
