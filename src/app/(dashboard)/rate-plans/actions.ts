"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { AuthorizationError, getActor, requirePermission } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { isRateDateWritable, todayInTz } from "@/lib/dates";
import { calculateQuote } from "@/lib/pricing/engine";
import type { PricingQuoteResult } from "@/lib/pricing/types";
import { getRatePlanDetail, listPlanOverrides, type PlanOverrideRow, type RatePlanDetail } from "@/lib/rate-plans/service";
import {
  ratePlanArchiveSchema, ratePlanDeleteSchema, ratePlanDuplicateSchema,
  ratePlanOverridesSchema, ratePlanSaveSchema, simulateQuoteSchema,
} from "@/lib/validation/rate-plans";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

class DomainError extends Error {}
const fail = (msg: string): never => { throw new DomainError(msg); };

// Postgres → Hebrew for the constraints/triggers migration 016 added.
function pgMessage(e: unknown): string | null {
  const err = e as { code?: string; constraint_name?: string; message?: string };
  if (err?.code === "23505" && err.constraint_name === "uq_pricing_plans_tenant_code")
    return "קוד התוכנית כבר קיים בנכס — יש לבחור קוד אחר";
  const m = err?.message ?? "";
  if (m.includes("RATE_PLAN_CYCLE")) return "לא ניתן ליצור תלות מעגלית בין תוכניות תעריף";
  if (m.includes("RATE_PLAN_CHAIN_TOO_DEEP")) return "שרשרת הירושה בין תוכניות ארוכה מדי (עד 5 רמות)";
  if (m.includes("RATE_PLAN_PARENT_NOT_TENANT_LEVEL")) return "תוכנית האב חייבת להיות תוכנית תעריף כללית";
  if (m.includes("RATE_PLAN_PARENT_NOT_FOUND")) return "תוכנית האב לא נמצאה";
  if (m.includes("MIXED_TENANT_DATA")) return "תוכנית האב שייכת לנכס אחר";
  return null;
}

function errorResult(e: unknown, tag: string): { success: false; error: string } {
  if (e instanceof AuthorizationError || e instanceof DomainError)
    return { success: false, error: e.message };
  const mapped = pgMessage(e);
  if (mapped) return { success: false, error: mapped };
  console.error(`[rate-plans:${tag}]`, e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

// ---- create / update (one shared wizard payload) ----
export async function saveRatePlanAction(raw: unknown): Promise<ActionResult & { id?: string }> {
  try {
    const actor = await getActor();
    const parsed = ratePlanSaveSchema.safeParse(raw);
    if (!parsed.success)
      return { success: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    const p = parsed.data;
    requirePermission(actor, p.id ? "rate_plans.edit" : "rate_plans.create");

    const id = await sql.begin(async (tx) => {
      // parent must be a live tenant-level plan of THIS tenant (the DB trigger
      // re-guards tenant/scope/cycles; this gives the friendly Hebrew first).
      // Exception: an UPDATE that keeps its existing parent may keep an archived
      // one — otherwise archiving a parent would freeze every edit of its
      // children; only NEW parent selections require a live plan.
      if (p.parentPlanId) {
        const [parent] = await tx<{ id: string; is_archived: boolean }[]>`
          SELECT id, is_archived FROM guesthub.pricing_plans
          WHERE id = ${p.parentPlanId} AND tenant_id = ${actor!.tenantId}
            AND sellable_unit_id IS NULL`;
        if (!parent) fail("תוכנית האב לא נמצאה");
        if (parent!.is_archived) {
          const [cur] = p.id
            ? await tx<{ parent_plan_id: string | null }[]>`
                SELECT parent_plan_id FROM guesthub.pricing_plans
                WHERE id = ${p.id} AND tenant_id = ${actor!.tenantId}`
            : [];
          if (!cur || cur.parent_plan_id !== p.parentPlanId)
            fail("תוכנית האב הועברה לארכיון");
        }
        if (p.id && p.parentPlanId === p.id) fail("תוכנית אינה יכולה להיות אב של עצמה");
      }

      // assigned units must belong to this tenant
      const unitIds = p.assignments.map((a) => a.sellableUnitId);
      if (unitIds.length) {
        const units = await tx<{ id: string }[]>`
          SELECT id FROM guesthub.sellable_units
          WHERE tenant_id = ${actor!.tenantId} AND id = ANY(${unitIds}::uuid[])`;
        if (units.length !== new Set(unitIds).size) fail("יחידת מכירה לא נמצאה");
      }

      // policy references must belong to this tenant (the 012 FKs are not
      // tenant-paired — same-tenant pairing is the app layer's contract)
      if (p.cancellationPolicyId) {
        const [cp] = await tx<{ id: string }[]>`
          SELECT id FROM guesthub.cancellation_policies
          WHERE id = ${p.cancellationPolicyId} AND tenant_id = ${actor!.tenantId}`;
        if (!cp) fail("מדיניות הביטול לא נמצאה");
      }
      if (p.paymentPolicyId) {
        const [pp] = await tx<{ id: string }[]>`
          SELECT id FROM guesthub.payment_policies
          WHERE id = ${p.paymentPolicyId} AND tenant_id = ${actor!.tenantId}`;
        if (!pp) fail("מדיניות התשלום לא נמצאה");
      }

      let planId: string;
      let before: Record<string, unknown> | null = null;
      if (p.id) {
        const [pre] = await tx<Record<string, unknown>[]>`
          SELECT * FROM guesthub.pricing_plans
          WHERE id = ${p.id} AND tenant_id = ${actor!.tenantId} AND sellable_unit_id IS NULL
          FOR UPDATE`;
        if (!pre) fail("תוכנית התעריף לא נמצאה");
        before = pre;
        planId = p.id;
        await tx`
          UPDATE guesthub.pricing_plans SET
            name = ${p.name}, code = ${p.code}, public_name = ${p.publicName},
            description = ${p.description}, public_description = ${p.publicDescription},
            plan_kind = ${p.planKind}, parent_plan_id = ${p.parentPlanId},
            adjustment_value = ${p.adjustmentValue},
            is_active = ${p.isActive}, is_refundable = ${p.isRefundable},
            cancellation_policy_id = ${p.cancellationPolicyId},
            payment_policy_id = ${p.paymentPolicyId},
            meal_plan = ${p.mealPlan},
            valid_from = ${p.validFrom}, valid_until = ${p.validUntil},
            min_advance_days = ${p.minAdvanceDays}, max_advance_days = ${p.maxAdvanceDays},
            allowed_checkin_days = ${p.allowedCheckinDays}::smallint[],
            default_min_stay = ${p.defaultMinStay}, default_max_stay = ${p.defaultMaxStay},
            default_closed_to_arrival = ${p.defaultClosedToArrival},
            default_closed_to_departure = ${p.defaultClosedToDeparture},
            is_visible_website = ${p.isVisibleWebsite}, is_visible_channels = ${p.isVisibleChannels},
            sort_order = ${p.sortOrder}, updated_by = ${actor!.userId}
          WHERE id = ${planId} AND tenant_id = ${actor!.tenantId}`;
      } else {
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO guesthub.pricing_plans
            (tenant_id, sellable_unit_id, code, name, public_name, description,
             public_description, plan_kind, parent_plan_id, adjustment_value,
             is_base, is_active, is_refundable, cancellation_policy_id, payment_policy_id,
             meal_plan, valid_from, valid_until, min_advance_days, max_advance_days,
             allowed_checkin_days, default_min_stay, default_max_stay,
             default_closed_to_arrival, default_closed_to_departure,
             is_visible_website, is_visible_channels, sort_order, created_by, updated_by)
          VALUES
            (${actor!.tenantId}, NULL, ${p.code}, ${p.name}, ${p.publicName}, ${p.description},
             ${p.publicDescription}, ${p.planKind}, ${p.parentPlanId}, ${p.adjustmentValue},
             false, ${p.isActive}, ${p.isRefundable}, ${p.cancellationPolicyId}, ${p.paymentPolicyId},
             ${p.mealPlan}, ${p.validFrom}, ${p.validUntil}, ${p.minAdvanceDays}, ${p.maxAdvanceDays},
             ${p.allowedCheckinDays}::smallint[],
             ${p.defaultMinStay}, ${p.defaultMaxStay},
             ${p.defaultClosedToArrival}, ${p.defaultClosedToDeparture},
             ${p.isVisibleWebsite}, ${p.isVisibleChannels}, ${p.sortOrder},
             ${actor!.userId}, ${actor!.userId})
          RETURNING id`;
        planId = created.id;
      }

      // assignments: upsert the desired set; deactivate (never delete) the rest
      for (const a of p.assignments) {
        await tx`
          INSERT INTO guesthub.pricing_plan_units
            (tenant_id, pricing_plan_id, sellable_unit_id, is_active,
             adjustment_value, valid_from, valid_until, created_by, updated_by)
          VALUES
            (${actor!.tenantId}, ${planId}, ${a.sellableUnitId}, ${a.isActive},
             ${a.adjustmentValue}, ${a.validFrom}, ${a.validUntil},
             ${actor!.userId}, ${actor!.userId})
          ON CONFLICT (pricing_plan_id, sellable_unit_id) DO UPDATE SET
            is_active = EXCLUDED.is_active,
            adjustment_value = EXCLUDED.adjustment_value,
            valid_from = EXCLUDED.valid_from,
            valid_until = EXCLUDED.valid_until,
            updated_by = EXCLUDED.updated_by`;
      }
      await tx`
        UPDATE guesthub.pricing_plan_units
        SET is_active = false, updated_by = ${actor!.userId}
        WHERE pricing_plan_id = ${planId} AND tenant_id = ${actor!.tenantId}
          AND is_active
          AND sellable_unit_id <> ALL(${unitIds.length ? unitIds : ["00000000-0000-0000-0000-000000000000"]}::uuid[])`;

      await writeAudit(actor!, {
        entityType: "rate_plan",
        entityId: planId,
        action: p.id ? "update" : "create",
        before,
        after: {
          code: p.code, name: p.name, plan_kind: p.planKind,
          parent_plan_id: p.parentPlanId, adjustment_value: p.adjustmentValue,
          is_active: p.isActive, assignments: p.assignments.length,
        },
      }, tx);
      return planId;
    });

    revalidatePath("/rate-plans");
    return { success: true, id };
  } catch (e) {
    return errorResult(e, "save");
  }
}

// ---- duplicate (§20): new code, inactive, hidden — user activates explicitly ----
export async function duplicateRatePlanAction(raw: unknown): Promise<ActionResult & { id?: string }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rate_plans.create");
    const parsed = ratePlanDuplicateSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: "קלט לא תקין" };
    const { id, withAssignments } = parsed.data;

    const newId = await sql.begin(async (tx) => {
      const [src] = await tx<{ id: string; code: string }[]>`
        SELECT id, code FROM guesthub.pricing_plans
        WHERE id = ${id} AND tenant_id = ${actor!.tenantId} AND sellable_unit_id IS NULL`;
      if (!src) fail("תוכנית התעריף לא נמצאה");

      const taken = await tx<{ code: string }[]>`
        SELECT code FROM guesthub.pricing_plans
        WHERE tenant_id = ${actor!.tenantId} AND sellable_unit_id IS NULL AND NOT is_archived`;
      const codes = new Set(taken.map((t) => t.code.toLowerCase()));
      // keep the generated code within the 40-char schema limit so the copy
      // stays editable through the wizard
      const stem = src.code.slice(0, 32);
      let code = `${stem}-copy`;
      for (let n = 2; codes.has(code.toLowerCase()); n++) code = `${stem}-copy${n}`;

      const [created] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.pricing_plans
          (tenant_id, sellable_unit_id, code, name, public_name, description,
           public_description, plan_kind, parent_plan_id, adjustment_value,
           is_base, is_active, is_refundable, cancellation_policy_id, payment_policy_id,
           meal_plan, valid_from, valid_until, min_advance_days, max_advance_days,
           allowed_checkin_days, default_min_stay, default_max_stay,
           default_closed_to_arrival, default_closed_to_departure,
           is_visible_website, is_visible_channels, sort_order, created_by, updated_by)
        SELECT tenant_id, NULL, ${code}, name || ' (עותק)', public_name, description,
               public_description, plan_kind, parent_plan_id, adjustment_value,
               false, false, is_refundable, cancellation_policy_id, payment_policy_id,
               meal_plan, valid_from, valid_until, min_advance_days, max_advance_days,
               allowed_checkin_days, default_min_stay, default_max_stay,
               default_closed_to_arrival, default_closed_to_departure,
               false, false, sort_order, ${actor!.userId}, ${actor!.userId}
        FROM guesthub.pricing_plans WHERE id = ${id}
        RETURNING id`;

      if (withAssignments) {
        await tx`
          INSERT INTO guesthub.pricing_plan_units
            (tenant_id, pricing_plan_id, sellable_unit_id, is_active,
             adjustment_value, valid_from, valid_until, created_by, updated_by)
          SELECT tenant_id, ${created.id}, sellable_unit_id, is_active,
                 adjustment_value, valid_from, valid_until, ${actor!.userId}, ${actor!.userId}
          FROM guesthub.pricing_plan_units WHERE pricing_plan_id = ${id}`;
        // an independent plan's nightly prices ARE its pricing configuration
        await tx`
          INSERT INTO guesthub.pricing_plan_unit_rates
            (tenant_id, pricing_plan_id, sellable_unit_id, date, price,
             min_stay_through, min_stay_arrival, max_stay,
             closed_to_arrival, closed_to_departure, stop_sell, note, created_by, updated_by)
          SELECT tenant_id, ${created.id}, sellable_unit_id, date, price,
                 min_stay_through, min_stay_arrival, max_stay,
                 closed_to_arrival, closed_to_departure, stop_sell, note,
                 ${actor!.userId}, ${actor!.userId}
          FROM guesthub.pricing_plan_unit_rates WHERE pricing_plan_id = ${id}`;
      }

      await writeAudit(actor!, {
        entityType: "rate_plan", entityId: created.id, action: "duplicate",
        before: null, after: { source_id: id, code, with_assignments: withAssignments },
      }, tx);
      return created.id;
    });

    revalidatePath("/rate-plans");
    return { success: true, id: newId };
  } catch (e) {
    return errorResult(e, "duplicate");
  }
}

// ---- archive / restore ----
export async function archiveRatePlanAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rate_plans.delete");
    const parsed = ratePlanArchiveSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: "קלט לא תקין" };
    const { id, archived } = parsed.data;

    await sql.begin(async (tx) => {
      const [before] = await tx<{ id: string; is_archived: boolean; is_active: boolean; code: string }[]>`
        SELECT id, is_archived, is_active, code FROM guesthub.pricing_plans
        WHERE id = ${id} AND tenant_id = ${actor!.tenantId} AND sellable_unit_id IS NULL
        FOR UPDATE`;
      if (!before) fail("תוכנית התעריף לא נמצאה");
      // a restored plan stays inactive + hidden until explicitly activated
      await tx`
        UPDATE guesthub.pricing_plans
        SET is_archived = ${archived}, is_active = false,
            is_visible_website = false, is_visible_channels = false,
            updated_by = ${actor!.userId}
        WHERE id = ${id} AND tenant_id = ${actor!.tenantId}`;
      await writeAudit(actor!, {
        entityType: "rate_plan", entityId: id, action: archived ? "archive" : "restore",
        before, after: { is_archived: archived },
      }, tx);
    });

    revalidatePath("/rate-plans");
    return { success: true };
  } catch (e) {
    return errorResult(e, "archive");
  }
}

// ---- hard delete — only when nothing depends on the plan (§20) ----
export async function deleteRatePlanAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rate_plans.delete");
    const parsed = ratePlanDeleteSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: "קלט לא תקין" };
    const { id } = parsed.data;

    await sql.begin(async (tx) => {
      const [plan] = await tx<{ id: string; code: string; name: string }[]>`
        SELECT id, code, name FROM guesthub.pricing_plans
        WHERE id = ${id} AND tenant_id = ${actor!.tenantId} AND sellable_unit_id IS NULL
        FOR UPDATE`;
      if (!plan) fail("תוכנית התעריף לא נמצאה");

      const [{ children }] = await tx<{ children: number }[]>`
        SELECT count(*)::int AS children FROM guesthub.pricing_plans
        WHERE parent_plan_id = ${id}`;
      if (children > 0) fail("לא ניתן למחוק: קיימות תוכניות הנגזרות מתוכנית זו — יש להעביר לארכיון");

      const [{ mappings }] = await tx<{ mappings: number }[]>`
        SELECT count(*)::int AS mappings FROM guesthub.channel_rate_plan_mappings
        WHERE tenant_id = ${actor!.tenantId} AND local_plan_code = ${plan!.code}`;
      if (mappings > 0) fail("לא ניתן למחוק: לתוכנית קיים מיפוי ערוץ היסטורי — יש להעביר לארכיון");

      // reservations do not reference tenant-level plans in this phase (the
      // reservation price snapshot lives on reservation_rooms) — nothing to gate.
      await tx`DELETE FROM guesthub.pricing_plan_units WHERE pricing_plan_id = ${id}`;
      await tx`DELETE FROM guesthub.pricing_plan_unit_rates WHERE pricing_plan_id = ${id}`;
      await tx`DELETE FROM guesthub.pricing_plans WHERE id = ${id} AND tenant_id = ${actor!.tenantId}`;
      await writeAudit(actor!, {
        entityType: "rate_plan", entityId: id, action: "delete",
        before: plan, after: null,
      }, tx);
    });

    revalidatePath("/rate-plans");
    return { success: true };
  } catch (e) {
    return errorResult(e, "delete");
  }
}

// ---- exact-date overlay rows (spec §9): sparse upserts + removals ----
export async function savePlanOverridesAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rate_plans.edit");
    const parsed = ratePlanOverridesSchema.safeParse(raw);
    if (!parsed.success)
      return { success: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    const o = parsed.data;

    await sql.begin(async (tx) => {
      const [plan] = await tx<{ id: string }[]>`
        SELECT p.id FROM guesthub.pricing_plans p
        WHERE p.id = ${o.planId} AND p.tenant_id = ${actor!.tenantId}
          AND p.sellable_unit_id IS NULL
        FOR UPDATE`;
      if (!plan) fail("תוכנית התעריף לא נמצאה");

      const [tenant] = await tx<{ timezone: string | null }[]>`
        SELECT timezone FROM guesthub.tenants WHERE id = ${actor!.tenantId}`;
      const today = todayInTz(tenant?.timezone || "Asia/Jerusalem");
      // only NEW commercial data is window-gated; deleting a stale (past-dated)
      // override row is cleanup, not writing past pricing — always allowed.
      for (const t of o.upserts) {
        if (!isRateDateWritable(t.date, today))
          fail(`התאריך ${t.date} מחוץ לחלון העריכה המותר`);
      }

      const touched = [...o.upserts, ...o.removals];
      const unitIds = [...new Set(touched.map((t) => t.sellableUnitId))];
      const units = await tx<{ id: string }[]>`
        SELECT id FROM guesthub.sellable_units
        WHERE tenant_id = ${actor!.tenantId} AND id = ANY(${unitIds}::uuid[])`;
      if (units.length !== unitIds.length) fail("יחידת מכירה לא נמצאה");

      for (const u of o.upserts) {
        await tx`
          INSERT INTO guesthub.pricing_plan_unit_rates
            (tenant_id, pricing_plan_id, sellable_unit_id, date, price,
             min_stay_through, min_stay_arrival, max_stay,
             closed_to_arrival, closed_to_departure, stop_sell, note,
             created_by, updated_by)
          VALUES
            (${actor!.tenantId}, ${o.planId}, ${u.sellableUnitId}, ${u.date}, ${u.price},
             ${u.minStayThrough}, ${u.minStayArrival}, ${u.maxStay},
             ${u.closedToArrival}, ${u.closedToDeparture}, ${u.stopSell}, ${u.note},
             ${actor!.userId}, ${actor!.userId})
          ON CONFLICT (pricing_plan_id, sellable_unit_id, date) DO UPDATE SET
            price = EXCLUDED.price,
            min_stay_through = EXCLUDED.min_stay_through,
            min_stay_arrival = EXCLUDED.min_stay_arrival,
            max_stay = EXCLUDED.max_stay,
            closed_to_arrival = EXCLUDED.closed_to_arrival,
            closed_to_departure = EXCLUDED.closed_to_departure,
            stop_sell = EXCLUDED.stop_sell,
            note = EXCLUDED.note,
            updated_by = EXCLUDED.updated_by`;
      }
      for (const r of o.removals) {
        await tx`
          DELETE FROM guesthub.pricing_plan_unit_rates
          WHERE tenant_id = ${actor!.tenantId} AND pricing_plan_id = ${o.planId}
            AND sellable_unit_id = ${r.sellableUnitId} AND date = ${r.date}`;
      }

      // plan-overlay rows are not part of the base ARI the channel outbox syncs
      // (Phase 4B maps plans separately) — no markAriDirty here on purpose.
      await writeAudit(actor!, {
        entityType: "rate_plan", entityId: o.planId, action: "daily_override",
        before: null,
        after: { upserts: o.upserts, removals: o.removals },
      }, tx);
    });

    revalidatePath("/rate-plans");
    return { success: true };
  } catch (e) {
    return errorResult(e, "overrides");
  }
}

// ---- full plan detail for the edit wizard ----
export async function getRatePlanDetailAction(
  raw: unknown,
): Promise<ActionResult & { detail?: RatePlanDetail }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rate_plans.view");
    const parsed = ratePlanDeleteSchema.safeParse(raw); // { id }
    if (!parsed.success) return { success: false, error: "קלט לא תקין" };
    const detail = await getRatePlanDetail(actor!.tenantId, parsed.data.id);
    if (!detail) return { success: false, error: "תוכנית התעריף לא נמצאה" };
    return { success: true, detail };
  } catch (e) {
    return errorResult(e, "detail");
  }
}

// ---- read the sparse overlay rows of one plan (overlay editor) ----
export async function getPlanOverridesAction(
  raw: unknown,
): Promise<ActionResult & { overrides?: PlanOverrideRow[] }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rate_plans.view");
    const parsed = ratePlanDeleteSchema.safeParse(raw); // { id }
    if (!parsed.success) return { success: false, error: "קלט לא תקין" };
    const overrides = await listPlanOverrides(actor!.tenantId, parsed.data.id);
    return { success: true, overrides };
  } catch (e) {
    return errorResult(e, "overrides-read");
  }
}

// ---- the simulator (§21) — calls THE central engine, read-only ----
export async function simulateQuoteAction(
  raw: unknown,
): Promise<ActionResult & { quote?: PricingQuoteResult }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "pricing.simulate");
    const parsed = simulateQuoteSchema.safeParse(raw);
    if (!parsed.success)
      return { success: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    const s = parsed.data;

    const quote = await calculateQuote(sql, {
      tenantId: actor!.tenantId, // trusted server context — never from the client
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      rooms: s.rooms,
      source: "pricing_simulator",
    });
    return { success: true, quote };
  } catch (e) {
    return errorResult(e, "simulate");
  }
}
