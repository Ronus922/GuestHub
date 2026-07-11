"use server";

import { revalidatePath } from "next/cache";
import type { TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { eachDay, nightsBetween, rangesOverlap, type DateOnly } from "@/lib/dates";
import type { CardSource } from "@/lib/card-rules";
import {
  checkRoomAvailability,
  lockRooms,
  INVENTORY_BLOCKING_STATUSES,
} from "@/lib/inventory";
// getRoomPlanRates/planNightlyPrice remain ONLY for the room-picker's
// display-only avg_price hint — never an authoritative price (that is the
// engine's, via the seam below).
import { getRoomPlanRates } from "@/lib/rates/effective-state";
import { indexByDate, planNightlyPrice } from "@/lib/rates/rules";
import {
  priceReservationStays,
  reservationTotal,
  StayPricingError,
  type PricedReservationStay,
  type StayPricingSnapshot,
} from "@/lib/pricing/reservation-pricing";
import { calculateReservationPrice } from "@/lib/pricing/engine";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import { loadCollectionView, type CollectionView } from "@/lib/payments/collection";
import {
  resolveCancellationSnapshot,
  type CancellationPolicySnapshot,
} from "@/lib/commercial/policy-snapshot";
import { markAriDirty } from "@/lib/channel/outbox";
import { publishDomainEvent } from "@/lib/realtime/publish";
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

// loadRoomMeta() lived here only to translate a room into its room_type for the
// channel outbox. D68 addresses the outbox by PHYSICAL ROOM, so the translation
// — and the room_types read behind it — is gone. Every call site already held
// the room ids it needed.

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

type PricedStay = PricedReservationStay<StayInput>;

// Full server-side gate for a set of stays — since D51 a thin wrapper over THE
// central pricing engine (src/lib/pricing): availability (incl. closures +
// room status), occupancy/capacity, stay restrictions, Rate-Plan rules and the
// canonical price all come from ONE calculation. Runs inside the caller's
// transaction AFTER lockRooms. `skip` lets a status-only edit bypass
// re-validating untouched stays (§F). A passed-in ratePerNight is an authorized
// manual override (§13) — the ACTION gates the permission; the committed-price
// snapshot rule (§6) is preserved by the seam.
async function validateAndPriceStays(
  tx: TransactionSql,
  tenantId: string,
  stays: StayInput[],
  opts: {
    excludeRrIds?: string[];
    enforceAvailability: boolean;
    enforceRestrictions: boolean;
    skipChecksForRr?: Set<string>;
    snapshotByRr?: Map<string, { ratePerNight: number; priceTotal?: number }>;
    actorUserId?: string;
  },
): Promise<PricedStay[]> {
  assertNoInternalOverlap(stays);
  try {
    return await priceReservationStays(tx, tenantId, stays, {
      source: "manual_reservation",
      ...opts,
    });
  } catch (e) {
    if (e instanceof StayPricingError) throw new DomainError(e.message);
    throw e;
  }
}

function aggregates(stays: PricedStay[]) {
  const checkIn = stays.reduce((m, s) => (s.checkIn < m ? s.checkIn : m), stays[0].checkIn);
  const checkOut = stays.reduce((m, s) => (s.checkOut > m ? s.checkOut : m), stays[0].checkOut);
  return {
    checkIn,
    checkOut,
    adults: stays.reduce((n, s) => n + s.adults, 0),
    children: stays.reduce((n, s) => n + s.children, 0),
    infants: stays.reduce((n, s) => n + s.infants, 0),
    roomsTotal: stays.reduce((sum, s) => sum + s.priceTotal, 0),
  };
}

// The tenant's ACTIVE default workflow status (D77 §B2) — applied to every
// newly created reservation (manual and imported alike).
export async function defaultWorkflowStatusId(
  db: TransactionSql,
  tenantId: string,
): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM guesthub.lookup_items
    WHERE tenant_id = ${tenantId} AND category = 'workflow_statuses'
      AND is_active AND (metadata->>'is_default') = 'true'`;
  return row?.id ?? null;
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
    // an explicit manual nightly price is an authorized override (§13)
    if (input.rooms.some((s) => s.isManualRate === true))
      requirePermission(actor, "reservations.price_override");

    const result = await sql.begin(async (tx) => {
      await lockRooms(tx, actor.tenantId, input.rooms.map((r) => r.roomId));
      const priced = await validateAndPriceStays(tx, actor.tenantId, input.rooms, {
        enforceAvailability: true,
        enforceRestrictions: true,
        actorUserId: actor.userId,
      });

      const guestId = await upsertGuest(tx, actor.tenantId, input.guest);
      const number = await allocateReservationNumber(tx, actor.tenantId);
      const discount = input.discountAmount ?? 0;
      const agg = aggregates(priced);
      const total = reservationTotal(agg.roomsTotal, discount, 0);
      const paid = input.paidAmount ?? 0;

      // explicit workflow choice (validated: this tenant, active) or default
      let workflowStatusId: string | null = null;
      if (input.workflowStatusId) {
        const [wf] = await tx<{ id: string }[]>`
          SELECT id FROM guesthub.lookup_items
          WHERE id = ${input.workflowStatusId} AND tenant_id = ${actor.tenantId}
            AND category = 'workflow_statuses' AND is_active`;
        if (!wf) throw new DomainError("סטטוס הטיפול שנבחר אינו זמין");
        workflowStatusId = wf.id;
      } else {
        workflowStatusId = await defaultWorkflowStatusId(tx, actor.tenantId);
      }
      // at-booking cancellation terms (034): the selected rate plan's assigned
      // Settings template → tenant default template → NULL. Multi-room
      // reservations snapshot the first stay's plan.
      const cancellationSnapshot = await resolveCancellationSnapshot(
        tx,
        actor.tenantId,
        priced[0]?.ratePlanId ?? null,
      );
      const [res] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.reservations
          (tenant_id, reservation_number, primary_guest_id, source_id, status,
           check_in, check_out, adults, children, infants,
           discount_amount, total_price, paid_amount, balance, currency,
           notes, expected_arrival_time, expected_arrival_time_source,
           cancellation_policy_snapshot, created_by, workflow_status_id)
        VALUES (${actor.tenantId}, ${number}, ${guestId}, ${input.sourceId ?? null},
                ${input.status}, ${agg.checkIn}, ${agg.checkOut},
                ${agg.adults}, ${agg.children}, ${agg.infants},
                ${discount}, ${total}, 0, ${total}, 'ILS',
                ${input.notes || null}, ${input.expectedArrivalTime ?? null},
                ${input.expectedArrivalTime ? "manual" : null},
                ${cancellationSnapshot === null ? null : tx.json(cancellationSnapshot as never)},
                ${actor.userId}, ${workflowStatusId})
        RETURNING id`;

      for (const s of priced) {
        const g = stayGuestCols(s);
        await tx`
          INSERT INTO guesthub.reservation_rooms
            (tenant_id, reservation_id, room_id, check_in, check_out,
             adults, children, infants, rate_per_night, price_total,
             is_manual_rate, rate_plan_id, pricing_snapshot,
             guest_first_name, guest_last_name, guest_phone, guest_email, guest_id_number)
          VALUES (${actor.tenantId}, ${res.id}, ${s.roomId}, ${s.checkIn}, ${s.checkOut},
                  ${s.adults}, ${s.children}, ${s.infants}, ${s.ratePerNight}, ${s.priceTotal},
                  ${s.isManualRate}, ${s.ratePlanId},
                  ${s.pricingSnapshot === null ? null : tx.json(s.pricingSnapshot as never)},
                  ${g.guest_first_name}, ${g.guest_last_name}, ${g.guest_phone},
                  ${g.guest_email}, ${g.guest_id_number})`;
      }

      if (paid > 0) {
        await tx`
          INSERT INTO guesthub.payments
            (tenant_id, reservation_id, amount, method, status, paid_at)
          VALUES (${actor.tenantId}, ${res.id}, ${paid},
                  ${input.paymentMethod ?? null}, 'paid', now())`;
      }
      // paid_amount/balance derive from the payments LEDGER (D51)
      await recomputePaymentAggregates(tx, actor.tenantId, res.id);

      await writeAudit(actor, {
        entityType: "reservation",
        entityId: res.id,
        action: "create",
        after: { number, status: input.status, rooms: priced.length, total },
      }, tx);

      // a blocking reservation consumes physical inventory → availability dirty
      if (isBlocking(input.status)) {
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomIds: priced.map((s) => s.roomId),
          dateFrom: agg.checkIn,
          dateTo: agg.checkOut,
        });
      }
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.created",
        reservationId: res.id,
        roomIds: priced.map((s) => s.roomId),
        dateFrom: agg.checkIn,
        dateTo: agg.checkOut,
        lifecycle: input.status,
      });
      if (isBlocking(input.status)) {
        await publishDomainEvent(tx, actor.tenantId, {
          type: "inventory.changed",
          roomIds: priced.map((s) => s.roomId),
          dateFrom: agg.checkIn,
          dateTo: agg.checkOut,
        });
      }
      return { reservationId: res.id, reservationNumber: number };
    });

    revalidatePath("/calendar");
    revalidatePath("/reservations");
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

      // Omitted status (the ordinary editor save) keeps the STORED lifecycle —
      // read FOR UPDATE in this same transaction, so it can never overwrite a
      // concurrent change with stale client data. Only the explicit
      // check-in/check-out quick actions send a status.
      const nextStatus = input.status ?? existing.status;

      const oldRows = await tx<
        { id: string; room_id: string | null; check_in: string; check_out: string;
          adults: number; children: number; infants: number; room_type_id: string | null;
          is_manual_rate: boolean; rate_per_night: number; price_total: number;
          rate_plan_id: string | null }[]
      >`
        SELECT rr.id, rr.room_id, rr.check_in::text, rr.check_out::text,
               rr.adults, rr.children, rr.infants, r.room_type_id,
               rr.is_manual_rate, rr.rate_per_night::float8 AS rate_per_night,
               rr.price_total::float8 AS price_total, rr.rate_plan_id
        FROM guesthub.reservation_rooms rr
        LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
        WHERE rr.reservation_id = ${input.id} AND rr.tenant_id = ${actor.tenantId}`;
      const oldById = new Map(oldRows.map((r) => [r.id, r]));

      // Turning ON a manual override, or changing an override's rate, requires
      // the authorization (§13). Preserved stored overrides don't re-require it
      // — an unauthorized editor can keep an approved price, never set one.
      const setsNewOverride = input.rooms.some((s) => {
        if (s.isManualRate !== true) return false;
        const old = s.rrId ? oldById.get(s.rrId) : undefined;
        if (!old) return true;
        return !old.is_manual_rate || (s.ratePerNight != null && s.ratePerNight !== old.rate_per_night);
      });
      if (setsNewOverride) requirePermission(actor, "reservations.price_override");

      // Preserve the authorized-override flag AND its committed rate across a
      // recompute-triggering edit (§13): an existing stay keeps its stored
      // is_manual_rate unless the caller explicitly changes it, and a manual
      // stay keeps its committed rate when no new price is resubmitted — so the
      // recompute can never silently overwrite the override or corrupt the flag.
      // The stay's Rate Plan is preserved the same way.
      for (const s of input.rooms) {
        if (!s.rrId) continue;
        const old = oldById.get(s.rrId);
        if (!old) continue;
        if (s.isManualRate === undefined) s.isManualRate = old.is_manual_rate;
        if (old.is_manual_rate && s.ratePerNight == null) s.ratePerNight = old.rate_per_night;
        if (s.ratePlanId === undefined) s.ratePlanId = old.rate_plan_id;
      }

      // stays whose room/dates/occupancy/plan are untouched skip re-validation —
      // a status-only edit can never fail on capacity it already holds (§F)
      const skipChecksForRr = new Set<string>();
      for (const s of input.rooms) {
        if (!s.rrId) continue;
        const old = oldById.get(s.rrId);
        if (!old) throw new DomainError("חדר הזמנה לא נמצא");
        if (
          old.room_id === s.roomId &&
          old.check_in === s.checkIn && old.check_out === s.checkOut &&
          old.adults === s.adults && old.children === s.children && old.infants === s.infants &&
          old.rate_plan_id === (s.ratePlanId ?? null)
        ) {
          skipChecksForRr.add(s.rrId);
        }
      }

      const wasBlocking = isBlocking(existing.status);
      const nowBlocking = isBlocking(nextStatus);
      // starting to consume inventory (e.g. draft → confirmed) must re-prove
      // availability for ALL stays, even untouched ones
      if (!wasBlocking && nowBlocking) skipChecksForRr.clear();

      // §6 committed-price snapshot: a non-manual stay whose price BASIS
      // (room + dates + occupancy + Rate Plan) is unchanged keeps its stored
      // price (never re-priced from current rates); a genuinely re-dated /
      // re-roomed / re-planned / re-occupied stay is re-priced. Confirming a
      // draft does NOT re-price an otherwise-unchanged stay.
      const snapshotByRr = new Map<string, { ratePerNight: number; priceTotal: number }>();
      for (const s of input.rooms) {
        if (!s.rrId) continue;
        const old = oldById.get(s.rrId);
        if (!old || s.isManualRate) continue;
        if (
          old.room_id === s.roomId && old.check_in === s.checkIn && old.check_out === s.checkOut &&
          old.adults === s.adults && old.children === s.children && old.infants === s.infants &&
          old.rate_plan_id === (s.ratePlanId ?? null)
        ) {
          snapshotByRr.set(s.rrId, { ratePerNight: old.rate_per_night, priceTotal: old.price_total });
        }
      }

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
        snapshotByRr,
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
          is_manual_rate: s.isManualRate,
          rate_plan_id: s.ratePlanId,
          ...stayGuestCols(s),
        };
        // pricingSnapshot null = the stay kept its committed price — the STORED
        // snapshot is preserved untouched (immutability §8); a re-priced stay
        // gets the fresh engine snapshot.
        if (s.rrId) {
          await tx`
            UPDATE guesthub.reservation_rooms SET ${tx(cols)}
            WHERE id = ${s.rrId} AND tenant_id = ${actor.tenantId}`;
          if (s.pricingSnapshot !== null) {
            await tx`
              UPDATE guesthub.reservation_rooms
              SET pricing_snapshot = ${tx.json(s.pricingSnapshot as never)}
              WHERE id = ${s.rrId} AND tenant_id = ${actor.tenantId}`;
          }
        } else {
          const g = stayGuestCols(s);
          await tx`
            INSERT INTO guesthub.reservation_rooms
              (tenant_id, reservation_id, room_id, check_in, check_out,
               adults, children, infants, rate_per_night, price_total,
               is_manual_rate, rate_plan_id, pricing_snapshot,
               guest_first_name, guest_last_name, guest_phone, guest_email, guest_id_number)
            VALUES (${actor.tenantId}, ${input.id}, ${s.roomId}, ${s.checkIn}, ${s.checkOut},
                    ${s.adults}, ${s.children}, ${s.infants}, ${s.ratePerNight}, ${s.priceTotal},
                    ${s.isManualRate}, ${s.ratePlanId},
                    ${s.pricingSnapshot === null ? null : tx.json(s.pricingSnapshot as never)},
                    ${g.guest_first_name}, ${g.guest_last_name}, ${g.guest_phone},
                    ${g.guest_email}, ${g.guest_id_number})`;
        }
      }

      const discount = input.discountAmount ?? Number(existing.discount_amount);
      const agg = aggregates(priced);
      const extra = Number(existing.extra_charges);
      const total = reservationTotal(agg.roomsTotal, discount, extra);
      const addPay = input.additionalPayment ?? 0;

      await tx`
        UPDATE guesthub.reservations SET
          primary_guest_id = ${guestId},
          source_id = ${input.sourceId ?? null},
          status = ${nextStatus},
          check_in = ${agg.checkIn}, check_out = ${agg.checkOut},
          adults = ${agg.adults}, children = ${agg.children}, infants = ${agg.infants},
          discount_amount = ${discount},
          total_price = ${total},
          notes = ${input.notes || null},
          expected_arrival_time = CASE
            WHEN ${input.expectedArrivalTime === undefined} THEN expected_arrival_time
            ELSE ${input.expectedArrivalTime ?? null}::time END,
          -- provenance (034): only an ACTUAL change flips the source to
          -- 'manual' — resaving the panel with the OTA-supplied value intact
          -- must not relabel it (SET expressions read the OLD row values)
          expected_arrival_time_source = CASE
            WHEN ${input.expectedArrivalTime === undefined} THEN expected_arrival_time_source
            WHEN ${input.expectedArrivalTime ?? null}::time IS NOT DISTINCT FROM expected_arrival_time
              THEN expected_arrival_time_source
            WHEN ${input.expectedArrivalTime ?? null}::time IS NULL THEN NULL
            ELSE 'manual' END
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;

      if (addPay > 0) {
        await tx`
          INSERT INTO guesthub.payments
            (tenant_id, reservation_id, amount, method, status, paid_at)
          VALUES (${actor.tenantId}, ${input.id}, ${addPay},
                  ${input.paymentMethod ?? null}, 'paid', now())`;
      }
      // paid_amount/balance derive from the payments LEDGER (D51)
      await recomputePaymentAggregates(tx, actor.tenantId, input.id);

      await writeAudit(actor, {
        entityType: "reservation",
        entityId: input.id,
        action: "update",
        before: { status: existing.status, check_in: existing.check_in, check_out: existing.check_out, rooms: oldRows.length },
        after: { status: nextStatus, check_in: agg.checkIn, check_out: agg.checkOut, rooms: priced.length, total },
      }, tx);

      // Dirty when inventory consumption changed on either side — including a
      // status flip into or out of a blocking status (a cancel/restore). Both
      // the OLD and the NEW room/date ranges are marked: the released nights
      // must be re-published as available, not just the newly-taken ones. The
      // span covers both sides (a superset is always safe — the projection
      // recomputes canonical state for every date it covers).
      const eventRoomIds = [
        ...oldRows.map((r) => r.room_id),
        ...priced.map((s) => s.roomId),
      ];
      const eventDates = [
        existing.check_in, existing.check_out, agg.checkIn, agg.checkOut,
      ].sort();
      if (wasBlocking || nowBlocking) {
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomIds: eventRoomIds,
          dateFrom: eventDates[0],
          dateTo: eventDates[eventDates.length - 1],
        });
      }

      // lifecycle-aware event: a check-in/out/no-show save is its own signal
      const lifecycleEvent =
        input.status !== existing.status && input.status === "checked_in"
          ? "reservation.checked_in"
          : input.status !== existing.status && input.status === "checked_out"
            ? "reservation.checked_out"
            : input.status !== existing.status && input.status === "no_show"
              ? "reservation.no_show"
              : "reservation.modified";
      await publishDomainEvent(tx, actor.tenantId, {
        type: lifecycleEvent,
        reservationId: input.id,
        roomIds: eventRoomIds,
        dateFrom: eventDates[0],
        dateTo: eventDates[eventDates.length - 1],
        lifecycle: input.status,
      });
      if (addPay > 0) {
        await publishDomainEvent(tx, actor.tenantId, {
          type: "reservation.payment_changed",
          reservationId: input.id,
        });
      }
      if (wasBlocking || nowBlocking) {
        await publishDomainEvent(tx, actor.tenantId, {
          type: "inventory.changed",
          roomIds: eventRoomIds,
          dateFrom: eventDates[0],
          dateTo: eventDates[eventDates.length - 1],
        });
      }
    });

    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// cancel
// ---------------------------------------------------------------
export async function cancelReservationAction(
  id: string,
  opts?: { reason?: string },
): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.cancel");
    const reason = opts?.reason?.trim() || null;
    await sql.begin(async (tx) => {
      const [res] = await tx<
        { id: string; status: string; check_in: string; check_out: string;
          channel_connection_id: string | null }[]
      >`
        SELECT id, status, check_in::text, check_out::text, channel_connection_id
        FROM guesthub.reservations
        WHERE id = ${id} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!res) throw new DomainError("הזמנה לא נמצאה");
      if (res.status === "cancelled") return;

      // D77 §9 — an ACTIVE OTA reservation is never cancelled locally: that
      // would release inventory while the booking stays live on the channel.
      // The provider-aware dialog offers the supported reporting actions; the
      // canonical local cancellation happens when the real cancelled revision
      // arrives (D76 applyCancellation).
      if (res.channel_connection_id && isBlocking(res.status)) {
        throw new DomainError(
          "הזמנת ערוץ פעילה — לא ניתן לבטל מקומית. יש לבטל ב-Booking.com ולהמתין לעדכון האוטומטי.",
        );
      }
      // a required reason keeps the cancellation history meaningful (§7/§9)
      if (!reason) throw new DomainError("נדרשת סיבת ביטול");

      // cancel-never-delete: the row keeps rooms/price/payments/identity;
      // who/when/why is recorded ON the row (031), full trail in audit
      await tx`
        UPDATE guesthub.reservations SET
          status = 'cancelled',
          cancelled_at = now(),
          cancelled_by_type = 'operator',
          cancelled_by_user_id = ${actor.userId},
          cancellation_origin = 'operator_direct_booking',
          cancellation_reason = ${reason}
        WHERE id = ${id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: id,
        action: "cancel",
        before: { status: res.status },
        after: { status: "cancelled", reason },
      }, tx);

      // the cancelled stay releases its nights → republish those rooms/dates
      const rooms = await tx<{ room_id: string | null }[]>`
        SELECT rr.room_id FROM guesthub.reservation_rooms rr
        WHERE rr.reservation_id = ${id} AND rr.tenant_id = ${actor.tenantId}`;
      const roomIds = rooms.map((r) => r.room_id).filter((x): x is string => !!x);
      if (isBlocking(res.status)) {
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomIds,
          dateFrom: res.check_in,
          dateTo: res.check_out,
        });
        await publishDomainEvent(tx, actor.tenantId, {
          type: "inventory.changed",
          roomIds,
          dateFrom: res.check_in,
          dateTo: res.check_out,
        });
      }
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.cancelled",
        reservationId: id,
        roomIds,
        dateFrom: res.check_in,
        dateTo: res.check_out,
        lifecycle: "cancelled",
      });
    });
    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// workflow status (D77 §B2/§C) — updates ONLY workflow_status_id.
// Deliberately touches no stay, no price, no lifecycle and no payment, so a
// status-only change never revalidates an unchanged stay.
// ---------------------------------------------------------------
export async function setWorkflowStatusAction(input: {
  reservationId: string;
  workflowStatusId: string;
}): Promise<ActionResult<{ workflowStatusId: string }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    await sql.begin(async (tx) => {
      const [res] = await tx<{ id: string; workflow_status_id: string | null }[]>`
        SELECT id, workflow_status_id FROM guesthub.reservations
        WHERE id = ${input.reservationId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!res) throw new DomainError("הזמנה לא נמצאה");
      // only an ACTIVE status of THIS tenant is selectable (deactivated ones
      // stay visible on history but are never newly assigned)
      const [status] = await tx<{ id: string }[]>`
        SELECT id FROM guesthub.lookup_items
        WHERE id = ${input.workflowStatusId} AND tenant_id = ${actor.tenantId}
          AND category = 'workflow_statuses' AND is_active`;
      if (!status) throw new DomainError("סטטוס לא זמין");
      if (res.workflow_status_id === input.workflowStatusId) return;
      await tx`
        UPDATE guesthub.reservations SET workflow_status_id = ${input.workflowStatusId}
        WHERE id = ${input.reservationId} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: input.reservationId,
        action: "workflow_status_change",
        before: { workflow_status_id: res.workflow_status_id },
        after: { workflow_status_id: input.workflowStatusId },
      }, tx);
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.workflow_status_changed",
        reservationId: input.reservationId,
      });
    });
    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true, data: { workflowStatusId: input.workflowStatusId } };
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
          rate_per_night: string; is_manual_rate: boolean; status: string;
          rate_plan_id: string | null; old_room_type: string | null;
        }[]
      >`
        SELECT rr.id, rr.reservation_id, rr.room_id,
               rr.check_in::text, rr.check_out::text,
               rr.adults, rr.children, rr.infants, rr.rate_per_night, rr.is_manual_rate,
               rr.rate_plan_id, res.status, r.room_type_id AS old_room_type
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
      // Manual overrides survive a move — room change included — exactly like the
      // edit path (§13). For an auto-priced stay: a same-room date change keeps the
      // committed nightly (§6); a room change re-prices from the target's rates.
      // The stay's Rate Plan rides along unchanged.
      const isManual = rr.is_manual_rate;
      const sameRoom = rr.room_id === input.targetRoomId;
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
          ratePlanId: rr.rate_plan_id,
          ...(isManual ? { isManualRate: true, ratePerNight: Number(rr.rate_per_night) } : {}),
        }],
        {
          excludeRrIds: [rr.id],
          enforceAvailability: true, // even drafts must not be dropped onto closures/unsellable rooms
          enforceRestrictions: blocking,
          snapshotByRr: !isManual && sameRoom
            ? new Map([[rr.id, { ratePerNight: Number(rr.rate_per_night) }]])
            : undefined,
          actorUserId: actor.userId,
        },
      );
      const s = priced[0];

      await tx`
        UPDATE guesthub.reservation_rooms SET
          room_id = ${s.roomId}, check_in = ${s.checkIn}, check_out = ${s.checkOut},
          rate_per_night = ${s.ratePerNight}, price_total = ${s.priceTotal}
        WHERE id = ${rr.id} AND tenant_id = ${actor.tenantId}`;
      // a re-priced move stores its fresh engine snapshot; a kept committed
      // price preserves the ORIGINAL stored snapshot (immutability §8 — the
      // audit entry below records the date/room change)
      if (s.pricingSnapshot !== null) {
        await tx`
          UPDATE guesthub.reservation_rooms
          SET pricing_snapshot = ${tx.json(s.pricingSnapshot as never)}
          WHERE id = ${rr.id} AND tenant_id = ${actor.tenantId}`;
      }

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

      // a move/resize frees the OLD room/dates and takes the NEW ones
      const moveDates = [rr.check_in, rr.check_out, s.checkIn, s.checkOut].sort();
      if (blocking) {
        await markAriDirty(tx, {
          tenantId: actor.tenantId,
          roomIds: [rr.room_id, s.roomId],
          dateFrom: moveDates[0],
          dateTo: moveDates[moveDates.length - 1],
        });
        await publishDomainEvent(tx, actor.tenantId, {
          type: "inventory.changed",
          roomIds: [rr.room_id, s.roomId],
          dateFrom: moveDates[0],
          dateTo: moveDates[moveDates.length - 1],
        });
      }
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.modified",
        reservationId: rr.reservation_id,
        roomIds: [rr.room_id, s.roomId],
        dateFrom: moveDates[0],
        dateTo: moveDates[moveDates.length - 1],
        lifecycle: rr.status,
      });
    });

    revalidatePath("/calendar");
    revalidatePath("/reservations");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---- pre-commit price preview for the drag/resize confirmation dialog ----
// Runs the SAME validation + pricing as the reschedule commit but persists
// NOTHING (the transaction is rolled back). Returns the current and proposed
// reservation totals so the floating dialog can show an accurate price
// difference before the user confirms. The commit re-validates server-side.
export async function previewRescheduleAction(raw: {
  rrId: string;
  targetRoomId: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
}): Promise<ActionResult<{ currentTotal: number; proposedTotal: number }>> {
  const ROLLBACK = Symbol("preview-rollback");
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.edit");
    const parsed = rescheduleSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    let result: { currentTotal: number; proposedTotal: number } | null = null;
    try {
      await sql.begin(async (tx) => {
        const [rr] = await tx<
          {
            id: string; reservation_id: string; room_id: string | null;
            adults: number; children: number; infants: number;
            rate_per_night: string; is_manual_rate: boolean; status: string;
            rate_plan_id: string | null; price_total: string;
          }[]
        >`
          SELECT rr.id, rr.reservation_id, rr.room_id,
                 rr.adults, rr.children, rr.infants, rr.rate_per_night, rr.is_manual_rate,
                 rr.rate_plan_id, res.status, rr.price_total
          FROM guesthub.reservation_rooms rr
          JOIN guesthub.reservations res ON res.id = rr.reservation_id
          WHERE rr.id = ${input.rrId} AND rr.tenant_id = ${actor.tenantId}`;
        if (!rr) throw new DomainError("הזמנה לא נמצאה");
        if (rr.status === "cancelled") throw new DomainError("הזמנה מבוטלת — לא ניתן להזיז");

        const isManual = rr.is_manual_rate;
        const sameRoom = rr.room_id === input.targetRoomId;
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
            ratePlanId: rr.rate_plan_id,
            ...(isManual ? { isManualRate: true, ratePerNight: Number(rr.rate_per_night) } : {}),
          }],
          {
            excludeRrIds: [rr.id],
            enforceAvailability: true,
            enforceRestrictions: isBlocking(rr.status),
            snapshotByRr: !isManual && sameRoom
              ? new Map([[rr.id, { ratePerNight: Number(rr.rate_per_night) }]])
              : undefined,
          },
        );

        const [agg] = await tx<{ others: number; discount: number; extra: number; current_total: number }[]>`
          SELECT
            COALESCE(SUM(rr.price_total) FILTER (WHERE rr.id <> ${rr.id}), 0)::float8 AS others,
            res.discount_amount::float8 AS discount,
            res.extra_charges::float8 AS extra,
            res.total_price::float8 AS current_total
          FROM guesthub.reservations res
          JOIN guesthub.reservation_rooms rr ON rr.reservation_id = res.id
          WHERE res.id = ${rr.reservation_id} AND res.tenant_id = ${actor.tenantId}
          GROUP BY res.discount_amount, res.extra_charges, res.total_price`;

        const proposedRooms = (agg?.others ?? 0) + priced[0].priceTotal;
        const proposedTotal = reservationTotal(proposedRooms, agg?.discount ?? 0, agg?.extra ?? 0);
        result = { currentTotal: agg?.current_total ?? 0, proposedTotal };
        throw ROLLBACK; // never persist a preview
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }

    if (!result) return fail("חישוב המחיר נכשל");
    return { success: true, data: result };
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

    // Canonical commercial prices (§0.4): room → SU → base plan → pricing_plan_rates.
    const planRates = await getRoomPlanRates(
      sql, actor.tenantId, rooms.map((r) => r.id), args.checkIn, args.checkOut,
    );

    const nights = eachDay(args.checkIn, args.checkOut);
    const data = rooms.map((r) => {
      const rp = planRates.get(r.id);
      const byDate = indexByDate(rp?.rows ?? []);
      const base = rp?.basePrice ?? r.base_price;
      const total = nights.reduce((sum, d) => sum + planNightlyPrice(byDate, d, base), 0);
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

// Live quote for one room stay (booking panel step 2, edit panel, and the
// dblclick default-checkout rule) — THE central engine, read-only. The same
// calculation the save path commits, so the preview can never disagree with
// the stored price.
export async function getStayQuoteAction(args: {
  roomId: string;
  checkIn: DateOnly;
  checkOut: DateOnly;
  adults?: number;
  children?: number;
  infants?: number;
  ratePlanId?: string | null;
}): Promise<ActionResult<{
  nights: number;
  total: number;
  ratePerNight: number;
  restriction: string | null;
  vatRate: number;
  vatAmount: number;
  extraGuestTotal: number;
  nightly: { date: string; price: number | null }[];
}>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.create");
    if (!(args.checkIn < args.checkOut)) return fail("טווח תאריכים לא תקין");

    const quote = await calculateReservationPrice(sql, {
      tenantId: actor.tenantId,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      rooms: [{
        roomId: args.roomId,
        ratePlanId: args.ratePlanId ?? null,
        // StayDraft defaults — explicit occupancy overrides for extra-guest math
        adults: args.adults ?? 2,
        children: args.children ?? 0,
        infants: args.infants ?? 0,
        manualRatePerNight: null,
      }],
      source: "manual_reservation",
    });
    const rq = quote.rooms[0];
    if (!rq) return fail(quote.errors[0]?.message ?? "חישוב המחיר נכשל");

    // the panel warns on anything the confirmed save would block on;
    // availability is surfaced separately by the room picker
    const restriction =
      rq.errors.find((e) => !["ROOM_UNAVAILABLE", "ROOM_DUPLICATED"].includes(e.code))?.message ?? null;
    const nights = quote.numberOfNights;
    const total = rq.roomSubtotal;
    return {
      success: true,
      data: {
        nights,
        total,
        ratePerNight: nights ? Math.round((total / nights) * 100) / 100 : 0,
        restriction,
        vatRate: quote.vatRate,
        vatAmount: quote.vatAmount,
        extraGuestTotal: rq.extraGuestTotal,
        nightly: rq.nights.map((n) => ({ date: n.date, price: n.nightTotal })),
      },
    };
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
  /** tenant workflow status (D77 §B2) — operator tag, never inventory/payment */
  workflow_status_id: string | null;
  /** OTA context (D76/D77) — null for manual/direct reservations */
  ota: {
    otaName: string | null;
    otaReservationCode: string | null;
    externalUniqueId: string | null;
    externalBookingId: string | null;
    invalidCardReportedAt: string | null;
    externalCancellationRequestedAt: string | null;
    noShowReportedAt: string | null;
  } | null;
  /** honest payment-collection state (D77 §D) */
  collection: CollectionView;
  /** cancellation history (031) — non-null only when status='cancelled' */
  cancellation: {
    at: string | null;
    byType: string | null;
    byUserName: string | null;
    origin: string | null;
    reason: string | null;
    externalConfirmedAt: string | null;
  } | null;
  source_id: string | null;
  notes: string | null;
  /** שעת הגעה משוערת "HH:MM" — dedicated field, independent of notes (D80) */
  expected_arrival_time: string | null;
  /** provenance of expected_arrival_time (034): OTA import vs operator edit;
   *  null = unknown (legacy rows) — never guessed */
  expected_arrival_time_source: "ota" | "manual" | null;
  /** immutable at-booking cancellation terms (034) — the reservation displays
   *  this snapshot, never the live Settings template */
  cancellation_policy: CancellationPolicySnapshot | null;
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
    isManualRate: boolean;
    ratePlanId: string | null;
    ratePlanName: string | null;
    pricingSnapshot: StayPricingSnapshot | null;
    guestFirstName: string | null;
    guestLastName: string | null;
    guestPhone: string | null;
    guestEmail: string | null;
    guestIdNumber: string | null;
  }[];
  payments: { id: string; amount: number; method: string | null; paid_at: string | null; reference: string | null }[];
  activity: { action: string; created_at: string; user_name: string | null }[];
  // masked stored-card metadata ONLY — the PAN never rides this payload
  // (explicit reveal via revealReservationCardAction, D41)
  card: {
    id: string;
    brand: string | null;
    last4: string;
    expMonth: number;
    expYear: number;
    holderName: string;
    source: CardSource;
    sourceChannel: string | null;
    isVirtual: boolean;
    availableUntil: string | null;
    billingNotes: string | null;
    updatedAt: string;
  } | null;
};

export async function getReservationAction(id: string): Promise<ActionResult<ReservationDetail>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.view");
    const [res] = await sql<
      {
        id: string; reservation_number: string; status: string; source_id: string | null;
        notes: string | null; expected_arrival_time: string | null;
        expected_arrival_time_source: "ota" | "manual" | null;
        cancellation_policy_snapshot: CancellationPolicySnapshot | null;
        discount_amount: number; extra_charges: number;
        total_price: number; paid_amount: number; balance: number;
        created_at: string; updated_at: string;
        guest_id: string | null; g_first: string | null; g_last: string | null; g_full: string | null;
        g_phone: string | null; g_email: string | null; g_idnum: string | null;
        source_label: string | null;
        workflow_status_id: string | null;
        channel_connection_id: string | null;
        ota_name: string | null; ota_reservation_code: string | null;
        external_unique_id: string | null; external_booking_id: string | null;
        invalid_card_reported_at: string | null;
        external_cancellation_requested_at: string | null;
        no_show_reported_at: string | null;
        cancelled_at: string | null;
        cancelled_by_type: string | null;
        cancelled_by_name: string | null;
        cancellation_origin: string | null;
        cancellation_reason: string | null;
        external_cancellation_confirmed_at: string | null;
      }[]
    >`
      SELECT res.id, res.reservation_number, res.status, res.source_id, res.notes,
             to_char(res.expected_arrival_time, 'HH24:MI') AS expected_arrival_time,
             res.expected_arrival_time_source,
             res.cancellation_policy_snapshot,
             res.workflow_status_id, res.channel_connection_id,
             res.ota_name, res.ota_reservation_code,
             res.external_unique_id, res.external_booking_id,
             res.invalid_card_reported_at::text AS invalid_card_reported_at,
             res.external_cancellation_requested_at::text AS external_cancellation_requested_at,
             res.no_show_reported_at::text AS no_show_reported_at,
             res.cancelled_at::text AS cancelled_at,
             res.cancelled_by_type,
             cu.full_name AS cancelled_by_name,
             res.cancellation_origin, res.cancellation_reason,
             res.external_cancellation_confirmed_at::text AS external_cancellation_confirmed_at,
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
      LEFT JOIN guesthub.users cu ON cu.id = res.cancelled_by_user_id
      WHERE res.id = ${id} AND res.tenant_id = ${actor.tenantId}`;
    if (!res) return fail("הזמנה לא נמצאה");

    const rooms = await sql<
      {
        rr_id: string; room_id: string; room_label: string; room_type_name: string | null;
        check_in: string; check_out: string; adults: number; children: number; infants: number;
        rate_per_night: number; price_total: number; is_manual_rate: boolean;
        rate_plan_id: string | null; rate_plan_name: string | null;
        pricing_snapshot: unknown;
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
             rr.is_manual_rate, rr.rate_plan_id,
             COALESCE(pp.public_name, pp.name) AS rate_plan_name,
             rr.pricing_snapshot,
             rr.guest_first_name, rr.guest_last_name, rr.guest_phone,
             rr.guest_email, rr.guest_id_number
      FROM guesthub.reservation_rooms rr
      LEFT JOIN guesthub.pricing_plans pp ON pp.id = rr.rate_plan_id
      LEFT JOIN guesthub.rooms r ON r.id = rr.room_id
      LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
      WHERE rr.reservation_id = ${id} AND rr.tenant_id = ${actor.tenantId}
      ORDER BY rr.check_in, r.room_number`;

    const payments = await sql<{ id: string; amount: number; method: string | null; paid_at: string | null; reference: string | null }[]>`
      SELECT id, amount::float8 AS amount, method, paid_at::text AS paid_at, reference
      FROM guesthub.payments
      WHERE reservation_id = ${id} AND tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC LIMIT 20`;

    // masked metadata only — no decryption on the normal read path (D41)
    const [card] = await sql<
      { id: string; brand: string | null; last4: string; exp_month: number; exp_year: number;
        holder_name: string; source: string; source_channel: string | null; is_virtual: boolean;
        available_until: string | null; billing_notes: string | null; updated_at: string }[]
    >`
      SELECT id, brand, last4, exp_month, exp_year, holder_name,
             source, source_channel, is_virtual,
             available_until::text AS available_until, billing_notes,
             updated_at::text AS updated_at
      FROM guesthub.reservation_cards
      WHERE reservation_id = ${id} AND tenant_id = ${actor.tenantId}`;

    const collection = await loadCollectionView(sql, actor.tenantId, {
      id: res.id,
      status: res.status,
      channel_connection_id: res.channel_connection_id,
    });

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
        workflow_status_id: res.workflow_status_id,
        ota: res.channel_connection_id
          ? {
              otaName: res.ota_name,
              otaReservationCode: res.ota_reservation_code,
              externalUniqueId: res.external_unique_id,
              externalBookingId: res.external_booking_id,
              invalidCardReportedAt: res.invalid_card_reported_at,
              externalCancellationRequestedAt: res.external_cancellation_requested_at,
              noShowReportedAt: res.no_show_reported_at,
            }
          : null,
        collection,
        cancellation:
          res.status === "cancelled"
            ? {
                at: res.cancelled_at,
                byType: res.cancelled_by_type,
                byUserName: res.cancelled_by_name,
                origin: res.cancellation_origin,
                reason: res.cancellation_reason,
                externalConfirmedAt: res.external_cancellation_confirmed_at,
              }
            : null,
        source_id: res.source_id,
        notes: res.notes,
        expected_arrival_time: res.expected_arrival_time,
        expected_arrival_time_source: res.expected_arrival_time_source,
        cancellation_policy: res.cancellation_policy_snapshot,
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
          isManualRate: r.is_manual_rate,
          ratePlanId: r.rate_plan_id,
          ratePlanName: r.rate_plan_name,
          pricingSnapshot: (r.pricing_snapshot ?? null) as StayPricingSnapshot | null,
          guestFirstName: r.guest_first_name,
          guestLastName: r.guest_last_name,
          guestPhone: r.guest_phone,
          guestEmail: r.guest_email,
          guestIdNumber: r.guest_id_number,
        })),
        payments,
        activity,
        card: card
          ? {
              id: card.id,
              brand: card.brand,
              last4: card.last4,
              expMonth: card.exp_month,
              expYear: card.exp_year,
              holderName: card.holder_name,
              source: card.source as CardSource,
              sourceChannel: card.source_channel,
              isVirtual: card.is_virtual,
              availableUntil: card.available_until,
              billingNotes: card.billing_notes,
              updatedAt: card.updated_at,
            }
          : null,
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
