"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { HEX_COLOR_RE, STATUS_PALETTE } from "@/lib/colors";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// Tenant workflow-status definitions (D77 §B2) — CRUD over the EXISTING
// lookup_items list model, category 'workflow_statuses'. Rules enforced
// SERVER-SIDE (hiding a button is not authorization):
//   · exactly one ACTIVE default per tenant (uq_lookup_workflow_default is
//     the at-most-one backstop; refusing to orphan the default keeps it one)
//   · a used status cannot be hard-deleted (FK RESTRICT backstop) — it is
//     deactivated instead and stays visible on historical reservations
//   · color is a validated full hex; text color is DERIVED (WCAG), not stored
// Every change is audited. Tenant-scoped by the actor — never by client input.
// ============================================================

const CATEGORY = "workflow_statuses";

// the fallback tint for a status row saved without a colour: the approved
// --muted token, taken from the palette the picker itself offers (lib/colors.ts
// is the token source — no screen re-types a hex).
const DEFAULT_STATUS_COLOR: string = STATUS_PALETTE[6];

export type WorkflowStatusDef = {
  id: string;
  key: string;
  label: string;
  color: string;
  sortOrder: number;
  isDefault: boolean;
  isActive: boolean;
  /** reservations currently linked — drives the delete/deactivate affordance */
  usedCount: number;
};

function fail(e: unknown, tag: string): ActionResult<never> {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error(`[workflow-status:${tag}]`, e);
  if ((e as { code?: string })?.code === "23505")
    return { success: false, error: "כבר קיימת ברירת מחדל פעילה" };
  if ((e as { code?: string })?.code === "23503")
    return { success: false, error: "הסטטוס משויך להזמנות — ניתן להשבית אותו בלבד" };
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

async function listForTenant(tenantId: string): Promise<WorkflowStatusDef[]> {
  return (
    await sql<
      {
        id: string; key: string; label: string; color: string | null;
        sort_order: number; is_default: boolean; is_active: boolean; used_count: number;
      }[]
    >`
      SELECT li.id, li.key, li.label, li.color, li.sort_order,
             COALESCE((li.metadata->>'is_default')::boolean, false) AS is_default,
             li.is_active,
             (SELECT COUNT(*)::int FROM guesthub.reservations r
               WHERE r.workflow_status_id = li.id) AS used_count
      FROM guesthub.lookup_items li
      WHERE li.tenant_id = ${tenantId} AND li.category = ${CATEGORY}
      ORDER BY li.sort_order, li.created_at`
  ).map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    color: r.color ?? DEFAULT_STATUS_COLOR,
    sortOrder: r.sort_order,
    isDefault: r.is_default,
    isActive: r.is_active,
    usedCount: r.used_count,
  }));
}

export async function listWorkflowStatusesAction(): Promise<ActionResult<WorkflowStatusDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "list");
  }
}

function validateLabelColor(label: string, color: string): string | null {
  if (!label.trim() || label.trim().length > 60) return "שם הסטטוס חייב להיות באורך 1–60 תווים";
  if (!HEX_COLOR_RE.test(color)) return "צבע לא תקין — נדרש hex מלא (#RRGGBB)";
  return null;
}

export async function createWorkflowStatusAction(input: {
  label: string;
  color: string;
}): Promise<ActionResult<WorkflowStatusDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    const err = validateLabelColor(input.label, input.color);
    if (err) return { success: false, error: err };

    await sql.begin(async (tx) => {
      const [{ next }] = await tx<{ next: number }[]>`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
        FROM guesthub.lookup_items
        WHERE tenant_id = ${actor.tenantId} AND category = ${CATEGORY}`;
      const key = `ws-${randomBytes(4).toString("hex")}`; // stable slug, never renamed
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.lookup_items
          (tenant_id, category, key, label, color, sort_order, is_active, metadata)
        VALUES (${actor.tenantId}, ${CATEGORY}, ${key}, ${input.label.trim()},
                ${input.color}, ${next}, true, '{}'::jsonb)
        RETURNING id`;
      await writeAudit(actor, {
        entityType: "workflow_status",
        entityId: row.id,
        action: "create",
        after: { label: input.label.trim(), color: input.color },
      }, tx);
    });
    revalidatePath("/settings");
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "create");
  }
}

export async function updateWorkflowStatusAction(input: {
  id: string;
  label: string;
  color: string;
}): Promise<ActionResult<WorkflowStatusDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    const err = validateLabelColor(input.label, input.color);
    if (err) return { success: false, error: err };

    await sql.begin(async (tx) => {
      const [before] = await tx<{ id: string; label: string; color: string | null }[]>`
        SELECT id, label, color FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
        FOR UPDATE`;
      if (!before) throw new AuthorizationError("סטטוס לא נמצא");
      await tx`
        UPDATE guesthub.lookup_items
        SET label = ${input.label.trim()}, color = ${input.color}
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "workflow_status",
        entityId: input.id,
        action: "update",
        before: { label: before.label, color: before.color },
        after: { label: input.label.trim(), color: input.color },
      }, tx);
    });
    revalidatePath("/settings");
    revalidatePath("/calendar"); // tags derive their color from the definition
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "update");
  }
}

// Reorder = the full ordered id list of the tenant's statuses.
export async function reorderWorkflowStatusesAction(input: {
  orderedIds: string[];
}): Promise<ActionResult<WorkflowStatusDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    await sql.begin(async (tx) => {
      for (let i = 0; i < input.orderedIds.length; i++) {
        await tx`
          UPDATE guesthub.lookup_items SET sort_order = ${i}
          WHERE id = ${input.orderedIds[i]} AND tenant_id = ${actor.tenantId}
            AND category = ${CATEGORY}`;
      }
      await writeAudit(actor, {
        entityType: "workflow_status",
        entityId: actor.tenantId,
        action: "reorder",
        after: { order: input.orderedIds },
      }, tx);
    });
    revalidatePath("/settings");
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "reorder");
  }
}

export async function setDefaultWorkflowStatusAction(input: {
  id: string;
}): Promise<ActionResult<WorkflowStatusDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    await sql.begin(async (tx) => {
      const [target] = await tx<{ id: string; is_active: boolean }[]>`
        SELECT id, is_active FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
        FOR UPDATE`;
      if (!target) throw new AuthorizationError("סטטוס לא נמצא");
      if (!target.is_active)
        throw new AuthorizationError("לא ניתן לקבוע סטטוס מושבת כברירת מחדל");
      // clear-then-set inside one transaction keeps exactly one default
      await tx`
        UPDATE guesthub.lookup_items
        SET metadata = metadata - 'is_default'
        WHERE tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
          AND (metadata->>'is_default') = 'true'`;
      await tx`
        UPDATE guesthub.lookup_items
        SET metadata = jsonb_set(metadata, '{is_default}', 'true'::jsonb)
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "workflow_status",
        entityId: input.id,
        action: "set_default",
      }, tx);
    });
    revalidatePath("/settings");
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "set-default");
  }
}

export async function setWorkflowStatusActiveAction(input: {
  id: string;
  isActive: boolean;
}): Promise<ActionResult<WorkflowStatusDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    await sql.begin(async (tx) => {
      const [target] = await tx<{ id: string; is_default: boolean }[]>`
        SELECT id, COALESCE((metadata->>'is_default')::boolean, false) AS is_default
        FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
        FOR UPDATE`;
      if (!target) throw new AuthorizationError("סטטוס לא נמצא");
      if (!input.isActive && target.is_default)
        throw new AuthorizationError("זוהי ברירת המחדל — קבע ברירת מחדל אחרת לפני השבתה");
      await tx`
        UPDATE guesthub.lookup_items SET is_active = ${input.isActive}
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "workflow_status",
        entityId: input.id,
        action: input.isActive ? "activate" : "deactivate",
      }, tx);
    });
    revalidatePath("/settings");
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "set-active");
  }
}

// Hard delete is allowed ONLY for an unused, non-default status; the FK
// (ON DELETE RESTRICT) is the database backstop for the "used" rule.
export async function deleteWorkflowStatusAction(input: {
  id: string;
}): Promise<ActionResult<WorkflowStatusDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    await sql.begin(async (tx) => {
      const [target] = await tx<{ id: string; label: string; is_default: boolean }[]>`
        SELECT id, label, COALESCE((metadata->>'is_default')::boolean, false) AS is_default
        FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
        FOR UPDATE`;
      if (!target) throw new AuthorizationError("סטטוס לא נמצא");
      if (target.is_default)
        throw new AuthorizationError("לא ניתן למחוק את ברירת המחדל");
      await tx`
        DELETE FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}`;
      await writeAudit(actor, {
        entityType: "workflow_status",
        entityId: input.id,
        action: "delete",
        before: { label: target.label },
      }, tx);
    });
    revalidatePath("/settings");
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "delete");
  }
}
