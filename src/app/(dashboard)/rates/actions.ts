"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { addDays, eachDay, dayOfWeek, todayInTz } from "@/lib/dates";
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
      const [room] = await tx<{ id: string; status: string; room_type_id: string | null; timezone: string }[]>`
        SELECT r.id, r.status, r.room_type_id, t.timezone
        FROM guesthub.rooms r
        JOIN guesthub.tenants t ON t.id = r.tenant_id
        WHERE r.id = ${input.roomId} AND r.tenant_id = ${actor.tenantId}
        FOR UPDATE OF r`;
      if (!room) throw new DomainError("חדר לא נמצא");
      if (room.status === input.status) return;

      await tx`
        UPDATE guesthub.rooms SET status = ${input.status}
        WHERE id = ${input.roomId} AND tenant_id = ${actor.tenantId}`;

      await writeAudit(
        actor,
        {
          entityType: "room",
          entityId: input.roomId,
          action: "status",
          before: { status: room.status },
          after: { status: input.status },
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
