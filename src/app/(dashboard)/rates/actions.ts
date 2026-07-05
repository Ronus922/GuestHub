"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { addDays, eachDay, dayOfWeek, todayInTz, ratesWritableWindow, type DateOnly } from "@/lib/dates";
import { markAriDirty } from "@/lib/channel/outbox";
import { writeRateCells, type RateCell, type RateCellPatch } from "@/lib/rates/service";
import { applyPriceMode } from "@/lib/rates/rules";
import {
  upsertRateCellSchema,
  bulkUpdateRatesSchema,
  roomStatusSchema,
  type UpsertRateCellInput,
  type BulkUpdateRatesInput,
  type RoomStatusInput,
} from "@/lib/validation/rates";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// Commercial-write paths (§0.2). The Rate Grid (single cell) and Group Update
// (batch) both funnel through @/lib/rates/service → guesthub.pricing_plan_rates
// → the same outbox — they can never become competing sources. The occupancy
// calendar writes only physical rows and NEVER calls these actions. Also here:
// the rooms.status administrative toggle (§0.5).
// ============================================================

class DomainError extends Error {}
const fail = (error: string): ActionResult<never> => ({ success: false, error });

function errorMessage(e: unknown): string {
  if (e instanceof AuthorizationError || e instanceof DomainError) return e.message;
  console.error("[rates]", e);
  return "אירעה שגיאה בלתי צפויה";
}

// Tenant-local today (property timezone, never UTC) → the writable window. The
// SAME server-side date policy the grid/UI use, re-enforced at the trust
// boundary (Step 6): past dates and beyond-horizon dates are rejected here even
// if a client bypasses the pickers.
async function tenantWritableWindow(tenantId: string): Promise<{ earliest: DateOnly; latest: DateOnly }> {
  const [t] = await sql<{ timezone: string }[]>`
    SELECT timezone FROM guesthub.tenants WHERE id = ${tenantId}`;
  return ratesWritableWindow(todayInTz(t?.timezone || "Asia/Jerusalem"));
}

// camelCase validated patch → the snake_case service patch (touched keys only).
function toServicePatch(p: UpsertRateCellInput["patch"]): RateCellPatch {
  const out: RateCellPatch = {};
  if (p.price !== undefined) out.price = p.price;
  if (p.minStayThrough !== undefined) out.min_stay_through = p.minStayThrough;
  if (p.minStayArrival !== undefined) out.min_stay_arrival = p.minStayArrival;
  if (p.maxStay !== undefined) out.max_stay = p.maxStay;
  if (p.closedToArrival !== undefined) out.closed_to_arrival = p.closedToArrival;
  if (p.closedToDeparture !== undefined) out.closed_to_departure = p.closedToDeparture;
  if (p.stopSell !== undefined) out.stop_sell = p.stopSell;
  return out;
}

// ---------------------------------------------------------------
// Rate Grid — direct single-cell write path (§0.6.4)
// ---------------------------------------------------------------
export async function upsertRateCellAction(
  raw: UpsertRateCellInput,
): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rates.edit");
    const parsed = upsertRateCellSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    const { earliest, latest } = await tenantWritableWindow(actor.tenantId);
    if (input.date < earliest) return fail("לא ניתן לעדכן תעריף לתאריך שעבר");
    if (input.date > latest) return fail(`ניתן לעדכן תעריפים עד ${latest}`);

    await sql.begin(async (tx) => {
      let planId = input.pricingPlanId;
      if (!planId) {
        const [bp] = await tx<{ id: string }[]>`
          SELECT id FROM guesthub.pricing_plans
          WHERE tenant_id = ${actor.tenantId} AND sellable_unit_id = ${input.sellableUnitId}
            AND is_base AND is_active`;
        if (!bp) throw new DomainError("לא נמצאה תוכנית בסיס ליחידת המכירה");
        planId = bp.id;
      }
      const patch = toServicePatch(input.patch);
      await writeRateCells(tx, actor.tenantId, [
        { sellableUnitId: input.sellableUnitId, pricingPlanId: planId, date: input.date, patch },
      ]);
      await writeAudit(
        actor,
        {
          entityType: "pricing_plan_rates",
          entityId: input.sellableUnitId,
          action: "rate_edit",
          after: { pricingPlanId: planId, date: input.date, ...patch },
        },
        tx,
      );
    });

    revalidatePath("/rates");
    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// Group Update — batch write path over the SAME service (§0.6.5)
// ---------------------------------------------------------------
export async function bulkUpdateRatesAction(
  raw: BulkUpdateRatesInput,
): Promise<ActionResult<{ cells: number; units: number; dates: number }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rates.bulk_update");
    const parsed = bulkUpdateRatesSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    const { earliest, latest } = await tenantWritableWindow(actor.tenantId);
    if (input.dateFrom < earliest) return fail("לא ניתן לעדכן תאריכים שעברו — התחל מהיום");
    if (input.dateTo > latest) return fail(`ניתן לעדכן תעריפים עד ${latest}`);

    // dates in [from, to] inclusive, filtered by weekday chips (§7b)
    const allDays = eachDay(input.dateFrom, addDays(input.dateTo, 1));
    const wd = input.weekdays && input.weekdays.length ? new Set(input.weekdays) : null;
    const dates = wd ? allDays.filter((d) => wd.has(dayOfWeek(d))) : allDays;
    if (dates.length === 0) return fail("לא נמצאו תאריכים בטווח");

    // non-price fields are constant across cells (touched-only)
    const common: RateCellPatch = {};
    if (input.minStayThrough !== undefined) common.min_stay_through = input.minStayThrough;
    if (input.minStayArrival !== undefined) common.min_stay_arrival = input.minStayArrival;
    if (input.maxStay !== undefined) common.max_stay = input.maxStay;
    if (input.stopSell !== undefined) common.stop_sell = input.stopSell;
    if (input.closedToArrival !== undefined) common.closed_to_arrival = input.closedToArrival;
    if (input.closedToDeparture !== undefined) common.closed_to_departure = input.closedToDeparture;

    const result = await sql.begin(async (tx) => {
      const plans = await tx<
        { su_id: string; plan_id: string; base_price: number }[]
      >`
        SELECT su.id AS su_id, bp.id AS plan_id, COALESCE(rt.base_price, 0)::float8 AS base_price
        FROM guesthub.sellable_units su
        JOIN guesthub.pricing_plans bp
          ON bp.sellable_unit_id = su.id AND bp.is_base AND bp.is_active
        LEFT JOIN guesthub.room_types rt ON rt.id = su.room_type_id
        WHERE su.tenant_id = ${actor.tenantId} AND su.is_active
          AND su.id = ANY(${input.sellableUnitIds}::uuid[])`;
      if (plans.length === 0) throw new DomainError("לא נמצאו יחידות מכירה");
      const planIds = plans.map((p) => p.plan_id);

      // current prices are needed only for relative price modes
      const priceByKey = new Map<string, number | null>();
      if (input.price) {
        const cur = await tx<{ pricing_plan_id: string; date: string; price: number | null }[]>`
          SELECT pricing_plan_id, date::text AS date, price::float8 AS price
          FROM guesthub.pricing_plan_rates
          WHERE tenant_id = ${actor.tenantId}
            AND pricing_plan_id = ANY(${planIds}::uuid[])
            AND date = ANY(${dates}::date[])`;
        for (const r of cur) priceByKey.set(`${r.pricing_plan_id}|${r.date}`, r.price);
      }

      const cells: RateCell[] = [];
      for (const p of plans) {
        for (const d of dates) {
          const patch: RateCellPatch = { ...common };
          if (input.price) {
            const cur = priceByKey.get(`${p.plan_id}|${d}`) ?? null;
            patch.price = applyPriceMode(cur, input.price.mode, input.price.amount, p.base_price);
          }
          cells.push({ sellableUnitId: p.su_id, pricingPlanId: p.plan_id, date: d, patch });
        }
      }

      const changes = await writeRateCells(tx, actor.tenantId, cells);

      const [log] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.bulk_rate_update_logs
          (tenant_id, user_id, date_from, date_to, params, note)
        VALUES (${actor.tenantId}, ${actor.userId}, ${input.dateFrom}, ${input.dateTo},
                ${tx.json(input as never)}, 'group update')
        RETURNING id`;

      const items = changes.map((c) => ({
        tenant_id: actor.tenantId,
        log_id: log.id,
        room_id: null,
        room_type_id: c.roomTypeId,
        date: c.date,
        old_price: c.oldPrice,
        new_price: c.newPrice,
      }));
      if (items.length > 0) {
        await tx`
          INSERT INTO guesthub.bulk_rate_update_items ${tx(
            items,
            "tenant_id", "log_id", "room_id", "room_type_id", "date", "old_price", "new_price",
          )}`;
      }

      await writeAudit(
        actor,
        {
          entityType: "pricing_plan_rates",
          entityId: log.id,
          action: "bulk_update",
          after: { units: plans.length, dates: dates.length, cells: cells.length },
        },
        tx,
      );

      return { cells: cells.length, units: plans.length, dates: dates.length };
    });

    revalidatePath("/rates");
    revalidatePath("/calendar");
    return { success: true, data: result };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// Room administrative status (§0.5) — available | inactive | out_of_order.
// A physical eligibility toggle; dated maintenance/owner-stays use closures.
// ---------------------------------------------------------------
export async function setRoomStatusAction(raw: RoomStatusInput): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const parsed = roomStatusSchema.safeParse(raw);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "קלט לא תקין");
    const input = parsed.data;

    await sql.begin(async (tx) => {
      const [room] = await tx<{ id: string; status: string; is_active: boolean; room_type_id: string | null; timezone: string }[]>`
        SELECT r.id, r.status, r.is_active, r.room_type_id, t.timezone
        FROM guesthub.rooms r
        JOIN guesthub.tenants t ON t.id = r.tenant_id
        WHERE r.id = ${input.roomId} AND r.tenant_id = ${actor.tenantId}
        FOR UPDATE OF r`;
      if (!room) throw new DomainError("חדר לא נמצא");
      // Physical eligibility is status='available' AND is_active across every read
      // model, but these are two switches. Keep them coupled so the status control
      // is the SINGLE physical toggle — setting 'available' also clears a stale
      // is_active=false (the exact state that stranded G4 with no UI to reopen it).
      const nextActive = input.status === "available";
      if (room.status === input.status && room.is_active === nextActive) return;

      await tx`
        UPDATE guesthub.rooms SET status = ${input.status}, is_active = ${nextActive}
        WHERE id = ${input.roomId} AND tenant_id = ${actor.tenantId}`;

      await writeAudit(
        actor,
        {
          entityType: "room",
          entityId: input.roomId,
          action: "status",
          before: { status: room.status, is_active: room.is_active },
          after: { status: input.status, is_active: nextActive },
        },
        tx,
      );

      // physical inventory changed → mark availability dirty over a forward
      // horizon (no-op until a connection is active; horizon is a 4B decision).
      const today = todayInTz(room.timezone || "Asia/Jerusalem");
      await markAriDirty(tx, {
        tenantId: actor.tenantId,
        roomTypeIds: [room.room_type_id],
        dateFrom: today,
        dateTo: addDays(today, 365),
        kinds: ["availability"],
      });
    });

    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---------------------------------------------------------------
// Cell detail (§8) — read-only. Returns the PHYSICAL entities behind a cell's
// availability (member rooms + admin status, the reservations and closures that
// consume it on that date) so the cell action popover can LINK to the proper
// operational screens. The commercial projection already lives on the grid cell;
// this adds only the "why physically" entity references. No writes here — the
// grid never performs physical actions (§5).
// ---------------------------------------------------------------
export type CellDetailData = {
  rooms: { id: string; roomNumber: string; status: string; isActive: boolean }[];
  reservations: { id: string; reservationNumber: string; roomId: string; checkIn: string; checkOut: string; status: string }[];
  closures: { id: string; roomId: string; reason: string | null; startDate: string; endDate: string }[];
};

export async function getCellDetailAction(
  sellableUnitId: string,
  date: DateOnly,
): Promise<ActionResult<CellDetailData>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rates.view");

    const rooms = await sql<{ id: string; room_number: string; status: string; is_active: boolean }[]>`
      SELECT r.id, r.room_number, r.status, r.is_active
      FROM guesthub.sellable_unit_rooms sur
      JOIN guesthub.rooms r ON r.id = sur.room_id
      WHERE sur.tenant_id = ${actor.tenantId} AND sur.sellable_unit_id = ${sellableUnitId}
      ORDER BY r.room_number`;
    const roomIds = rooms.map((r) => r.id);
    if (roomIds.length === 0) {
      return { success: true, data: { rooms: [], reservations: [], closures: [] } };
    }

    const reservations = await sql<
      { id: string; reservation_number: string; room_id: string; check_in: string; check_out: string; status: string }[]
    >`
      SELECT res.id, res.reservation_number, rr.room_id,
             rr.check_in::text AS check_in, rr.check_out::text AS check_out, res.status
      FROM guesthub.reservation_rooms rr
      JOIN guesthub.reservations res ON res.id = rr.reservation_id
      WHERE rr.tenant_id = ${actor.tenantId} AND rr.room_id = ANY(${roomIds}::uuid[])
        AND rr.check_in <= ${date} AND rr.check_out > ${date}
        AND res.status = ANY (guesthub.inventory_blocking_statuses())
      ORDER BY res.reservation_number`;

    const closures = await sql<
      { id: string; room_id: string; reason: string | null; start_date: string; end_date: string }[]
    >`
      SELECT id, room_id, reason, start_date::text AS start_date, end_date::text AS end_date
      FROM guesthub.room_closures
      WHERE tenant_id = ${actor.tenantId} AND room_id = ANY(${roomIds}::uuid[])
        AND start_date <= ${date} AND end_date > ${date}`;

    return {
      success: true,
      data: {
        rooms: rooms.map((r) => ({ id: r.id, roomNumber: r.room_number, status: r.status, isActive: r.is_active })),
        reservations: reservations.map((r) => ({
          id: r.id, reservationNumber: r.reservation_number, roomId: r.room_id,
          checkIn: r.check_in, checkOut: r.check_out, status: r.status,
        })),
        closures: closures.map((c) => ({
          id: c.id, roomId: c.room_id, reason: c.reason, startDate: c.start_date, endDate: c.end_date,
        })),
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
