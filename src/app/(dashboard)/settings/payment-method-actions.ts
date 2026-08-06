"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// Tenant payment-method definitions — CRUD over the EXISTING lookup_items
// list model, category 'payment_methods' (the same shape status-actions.ts
// manages for workflow statuses). Rules enforced SERVER-SIDE:
//   · key is immutable — payments.method and payment_policy_stages.methods
//     store it as TEXT with no FK, so renaming would orphan history
//   · a method referenced by payments or by a policy stage cannot be hard
//     deleted (no FK backstop exists — the in-tx counts ARE the guard); it
//     is deactivated instead and stays resolvable on historical rows
//   · 'credit_card' can never be deleted: the card-capture flow keys on it
//     (BookingPanel / EditReservationPanel / CardFields / card-actions).
//     Deactivating it is allowed — card charges keep writing the key to
//     payments regardless, they never pass through the method list.
// Every change is audited. Tenant-scoped by the actor — never by client input.
// ============================================================

const CATEGORY = "payment_methods";
const PROTECTED_KEY = "credit_card";

export type PaymentMethodDef = {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  /** payments rows carrying this key — drives the delete/deactivate affordance */
  paymentsCount: number;
  /** payment-policy stages whose methods array references this key */
  policyRefCount: number;
  /** key the card flow depends on — delete is always blocked */
  isProtected: boolean;
};

function fail(e: unknown, tag: string): ActionResult<never> {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error(`[payment-method:${tag}]`, e);
  if ((e as { code?: string })?.code === "23505")
    return { success: false, error: "מפתח אמצעי התשלום כבר קיים" };
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

async function listForTenant(tenantId: string): Promise<PaymentMethodDef[]> {
  return (
    await sql<
      {
        id: string; key: string; label: string; sort_order: number;
        is_active: boolean; payments_count: number; policy_ref_count: number;
      }[]
    >`
      SELECT li.id, li.key, li.label, li.sort_order, li.is_active,
             (SELECT COUNT(*)::int FROM guesthub.payments p
               WHERE p.tenant_id = li.tenant_id AND p.method = li.key) AS payments_count,
             (SELECT COUNT(*)::int FROM guesthub.payment_policy_stages s
               WHERE s.tenant_id = li.tenant_id AND s.methods ? li.key) AS policy_ref_count
      FROM guesthub.lookup_items li
      WHERE li.tenant_id = ${tenantId} AND li.category = ${CATEGORY}
      ORDER BY li.sort_order, li.created_at`
  ).map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    paymentsCount: r.payments_count,
    policyRefCount: r.policy_ref_count,
    isProtected: r.key === PROTECTED_KEY,
  }));
}

export async function listPaymentMethodsAction(): Promise<ActionResult<PaymentMethodDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "list");
  }
}

function validateLabel(label: string): string | null {
  if (!label.trim() || label.trim().length > 60) return "שם אמצעי התשלום חייב להיות באורך 1–60 תווים";
  return null;
}

// The reservation forms read this list with is_active + sort_order (dashboard
// layout/page queries) — every mutation refreshes those trees too.
function revalidateConsumers() {
  revalidatePath("/settings");
  revalidatePath("/reservations");
  revalidatePath("/calendar");
}

export async function createPaymentMethodAction(input: {
  label: string;
}): Promise<ActionResult<PaymentMethodDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    const err = validateLabel(input.label);
    if (err) return { success: false, error: err };

    await sql.begin(async (tx) => {
      const [{ next }] = await tx<{ next: number }[]>`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
        FROM guesthub.lookup_items
        WHERE tenant_id = ${actor.tenantId} AND category = ${CATEGORY}`;
      const key = `pm-${randomBytes(4).toString("hex")}`; // stable slug, never renamed
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.lookup_items
          (tenant_id, category, key, label, sort_order, is_active, metadata)
        VALUES (${actor.tenantId}, ${CATEGORY}, ${key}, ${input.label.trim()},
                ${next}, true, '{}'::jsonb)
        RETURNING id`;
      await writeAudit(actor, {
        entityType: "payment_method",
        entityId: row.id,
        action: "create",
        after: { key, label: input.label.trim() },
      }, tx);
    });
    revalidateConsumers();
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "create");
  }
}

export async function updatePaymentMethodAction(input: {
  id: string;
  label: string;
  isActive: boolean;
}): Promise<ActionResult<PaymentMethodDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    const err = validateLabel(input.label);
    if (err) return { success: false, error: err };

    await sql.begin(async (tx) => {
      const [before] = await tx<{ id: string; label: string; is_active: boolean }[]>`
        SELECT id, label, is_active FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
        FOR UPDATE`;
      if (!before) throw new AuthorizationError("אמצעי התשלום לא נמצא");
      await tx`
        UPDATE guesthub.lookup_items
        SET label = ${input.label.trim()}, is_active = ${input.isActive}
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "payment_method",
        entityId: input.id,
        action: "update",
        before: { label: before.label, is_active: before.is_active },
        after: { label: input.label.trim(), is_active: input.isActive },
      }, tx);
    });
    revalidateConsumers();
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "update");
  }
}

// Reorder = the full ordered id list of the tenant's payment methods.
export async function reorderPaymentMethodsAction(input: {
  orderedIds: string[];
}): Promise<ActionResult<PaymentMethodDef[]>> {
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
        entityType: "payment_method",
        entityId: actor.tenantId,
        action: "reorder",
        after: { order: input.orderedIds },
      }, tx);
    });
    revalidateConsumers();
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "reorder");
  }
}

export async function setPaymentMethodActiveAction(input: {
  id: string;
  isActive: boolean;
}): Promise<ActionResult<PaymentMethodDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    await sql.begin(async (tx) => {
      const [target] = await tx<{ id: string }[]>`
        SELECT id FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
        FOR UPDATE`;
      if (!target) throw new AuthorizationError("אמצעי התשלום לא נמצא");
      await tx`
        UPDATE guesthub.lookup_items SET is_active = ${input.isActive}
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "payment_method",
        entityId: input.id,
        action: input.isActive ? "activate" : "deactivate",
      }, tx);
    });
    revalidateConsumers();
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "set-active");
  }
}

// Hard delete is allowed ONLY for an unused, unprotected method. payments.method
// and payment_policy_stages.methods carry the key as plain text (no FK), so the
// counts inside this transaction are the only backstop — FOR UPDATE on the
// lookup row keeps the check-then-delete window minimal.
export async function deletePaymentMethodAction(input: {
  id: string;
}): Promise<ActionResult<PaymentMethodDef[]>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    await sql.begin(async (tx) => {
      const [target] = await tx<{ id: string; key: string; label: string }[]>`
        SELECT id, key, label FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}
        FOR UPDATE`;
      if (!target) throw new AuthorizationError("אמצעי התשלום לא נמצא");
      if (target.key === PROTECTED_KEY)
        throw new AuthorizationError("אמצעי התשלום 'כרטיס אשראי' מובנה במערכת — ניתן להשבית בלבד");
      const [{ payments_count, policy_ref_count }] = await tx<
        { payments_count: number; policy_ref_count: number }[]
      >`
        SELECT
          (SELECT COUNT(*)::int FROM guesthub.payments p
            WHERE p.tenant_id = ${actor.tenantId} AND p.method = ${target.key}) AS payments_count,
          (SELECT COUNT(*)::int FROM guesthub.payment_policy_stages s
            WHERE s.tenant_id = ${actor.tenantId} AND s.methods ? ${target.key}) AS policy_ref_count`;
      if (payments_count + policy_ref_count > 0)
        throw new AuthorizationError("אמצעי התשלום בשימוש (תשלומים או מדיניות תשלום) — ניתן להשבית בלבד");
      await tx`
        DELETE FROM guesthub.lookup_items
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} AND category = ${CATEGORY}`;
      await writeAudit(actor, {
        entityType: "payment_method",
        entityId: input.id,
        action: "delete",
        before: { key: target.key, label: target.label },
      }, tx);
    });
    revalidateConsumers();
    return { success: true, data: await listForTenant(actor.tenantId) };
  } catch (e) {
    return fail(e, "delete");
  }
}
