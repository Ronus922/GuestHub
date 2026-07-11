"use server";

import { revalidatePath } from "next/cache";
import type { TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";
import {
  extraGuestSchema,
  cancellationPolicySchema,
  paymentPolicySchema,
} from "@/lib/validation/commercial";
import { validateExtraGuestDefaults } from "@/lib/commercial/extra-guest";
import { validateCancellationTiers } from "@/lib/commercial/cancellation";
import { validatePaymentStages } from "@/lib/commercial/payment";

// Commercial-settings mutations (§C/§D/§E). Every action: resolve the actor →
// requirePermission("settings.edit") (the same server gate the VAT setting and
// the /settings page enforce — hiding a button is not authorization) → zod-parse
// → run the pure cross-row validator → write in ONE transaction with an audit
// row. Tenant-scoped by actor.tenantId; a client tenantId is never trusted.
// SQL is spelled out explicitly (no dynamic identifiers) by deliberate choice.

const zodError = (e: unknown): string =>
  (e as { issues?: { message: string }[] })?.issues?.[0]?.message ?? "קלט לא תקין";

function fail(e: unknown, tag: string): ActionResult {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error(`[commercial:${tag}]`, e);
  if ((e as { code?: string })?.code === "23505")
    return { success: false, error: "קוד כפול או כבר קיימת ברירת מחדל" };
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

// ============================================================
// §A — extra-guest pricing defaults (jsonb on tenants.settings)
// ============================================================
export async function saveExtraGuestDefaultsAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");

    const parsed = extraGuestSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodError(parsed.error) };
    const value = parsed.data;
    const errors = validateExtraGuestDefaults(value);
    if (errors.length) return { success: false, error: errors[0] };

    await sql.begin(async (tx) => {
      const [before] = await tx<{ extra_guest: unknown }[]>`
        SELECT settings->'extra_guest' AS extra_guest
        FROM guesthub.tenants WHERE id = ${actor.tenantId} FOR UPDATE`;
      await tx`
        UPDATE guesthub.tenants
        SET settings = jsonb_set(settings, '{extra_guest}', ${sql.json(value)}::jsonb)
        WHERE id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "commercial_settings",
        entityId: actor.tenantId,
        action: "update_extra_guest",
        before: { extra_guest: before?.extra_guest ?? null },
        after: value,
      }, tx);
    });

    revalidatePath("/settings");
    return { success: true };
  } catch (e) {
    return fail(e, "extra_guest");
  }
}

// ============================================================
// §B — cancellation policy (upsert policy + replace ordered tiers)
// ============================================================
export async function saveCancellationPolicyAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");

    const parsed = cancellationPolicySchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodError(parsed.error) };
    const p = parsed.data;
    const { errors } = validateCancellationTiers(p.tiers);
    if (errors.length) return { success: false, error: errors[0] };

    const id = await sql.begin(async (tx) => {
      if (p.is_default) await demoteDefaults(tx, "cancellation_policies", actor.tenantId);
      let policyId: string;
      if (p.id) {
        const [row] = await tx<{ id: string }[]>`
          UPDATE guesthub.cancellation_policies SET
            name = ${p.name}, public_title = ${p.public_title}, code = ${p.code},
            is_active = ${p.is_active}, is_default = ${p.is_default},
            internal_notes = ${p.internal_notes ?? null}, guest_description = ${p.guest_description ?? null},
            translations = ${sql.json(p.translations)}::jsonb, distribution_scope = ${p.distribution_scope},
            timezone = ${p.timezone ?? null}, checkin_time_basis = ${p.checkin_time_basis ?? null},
            updated_by = ${actor.userId}
          WHERE id = ${p.id} AND tenant_id = ${actor.tenantId} AND NOT is_archived
          RETURNING id`;
        if (!row) throw new AuthorizationError("המדיניות לא נמצאה");
        policyId = row.id;
      } else {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO guesthub.cancellation_policies
            (tenant_id, name, public_title, code, is_active, is_default, internal_notes,
             guest_description, translations, distribution_scope, timezone, checkin_time_basis,
             created_by, updated_by)
          VALUES (${actor.tenantId}, ${p.name}, ${p.public_title}, ${p.code}, ${p.is_active},
            ${p.is_default}, ${p.internal_notes ?? null}, ${p.guest_description ?? null},
            ${sql.json(p.translations)}::jsonb, ${p.distribution_scope}, ${p.timezone ?? null},
            ${p.checkin_time_basis ?? null}, ${actor.userId}, ${actor.userId})
          RETURNING id`;
        policyId = row.id;
      }

      await tx`DELETE FROM guesthub.cancellation_policy_tiers WHERE tenant_id = ${actor.tenantId} AND policy_id = ${policyId}`;
      for (const [i, t] of p.tiers.entries()) {
        await tx`
          INSERT INTO guesthub.cancellation_policy_tiers
            (tenant_id, policy_id, sort_order, trigger_type, time_unit, time_from, time_to,
             fee_type, fee_amount, fee_percent, fee_nights, calc_base)
          VALUES (${actor.tenantId}, ${policyId}, ${i}, ${t.trigger_type}, ${t.time_unit},
                  ${t.time_from}, ${t.time_to}, ${t.fee_type}, ${t.fee_amount}, ${t.fee_percent},
                  ${t.fee_nights}, ${t.calc_base})`;
      }
      await writeAudit(actor, {
        entityType: "cancellation_policy",
        entityId: policyId,
        action: p.id ? "update" : "create",
        after: { name: p.name, code: p.code, tiers: p.tiers.length, is_default: p.is_default },
      }, tx);
      return policyId;
    });

    revalidatePath("/settings");
    return { success: true, data: { id } };
  } catch (e) {
    return fail(e, "cancellation_save");
  }
}

export async function deleteCancellationPolicyAction(rawId: unknown): Promise<ActionResult> {
  return archivePolicy("cancellation", rawId);
}

// ============================================================
// §C — payment policy (upsert policy + replace ordered stages)
// ============================================================
export async function savePaymentPolicyAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");

    const parsed = paymentPolicySchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodError(parsed.error) };
    const p = parsed.data;

    // canonical payment-method reference check (§C) — methods must exist for the tenant
    const allowed = (await sql<{ key: string }[]>`
      SELECT key FROM guesthub.lookup_items
      WHERE tenant_id = ${actor.tenantId} AND category = 'payment_methods' AND is_active`).map((r) => r.key);
    const { errors } = validatePaymentStages(p.stages, allowed);
    if (errors.length) return { success: false, error: errors[0] };

    const id = await sql.begin(async (tx) => {
      if (p.is_default) await demoteDefaults(tx, "payment_policies", actor.tenantId);
      let policyId: string;
      if (p.id) {
        const [row] = await tx<{ id: string }[]>`
          UPDATE guesthub.payment_policies SET
            name = ${p.name}, public_title = ${p.public_title}, code = ${p.code},
            is_active = ${p.is_active}, is_default = ${p.is_default},
            internal_notes = ${p.internal_notes ?? null}, guest_description = ${p.guest_description ?? null},
            translations = ${sql.json(p.translations)}::jsonb, updated_by = ${actor.userId}
          WHERE id = ${p.id} AND tenant_id = ${actor.tenantId} AND NOT is_archived
          RETURNING id`;
        if (!row) throw new AuthorizationError("המדיניות לא נמצאה");
        policyId = row.id;
      } else {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO guesthub.payment_policies
            (tenant_id, name, public_title, code, is_active, is_default, internal_notes,
             guest_description, translations, created_by, updated_by)
          VALUES (${actor.tenantId}, ${p.name}, ${p.public_title}, ${p.code}, ${p.is_active},
            ${p.is_default}, ${p.internal_notes ?? null}, ${p.guest_description ?? null},
            ${sql.json(p.translations)}::jsonb, ${actor.userId}, ${actor.userId})
          RETURNING id`;
        policyId = row.id;
      }

      await tx`DELETE FROM guesthub.payment_policy_stages WHERE tenant_id = ${actor.tenantId} AND policy_id = ${policyId}`;
      for (const [i, s] of p.stages.entries()) {
        await tx`
          INSERT INTO guesthub.payment_policy_stages
            (tenant_id, policy_id, sort_order, trigger_type, trigger_offset_unit, trigger_offset_value,
             amount_type, amount_value, amount_percent, methods, require_card_guarantee, retry_behavior,
             staff_instructions, guest_text)
          VALUES (${actor.tenantId}, ${policyId}, ${i}, ${s.trigger_type}, ${s.trigger_offset_unit},
                  ${s.trigger_offset_value}, ${s.amount_type}, ${s.amount_value}, ${s.amount_percent},
                  ${sql.json(s.methods)}::jsonb, ${s.require_card_guarantee}, ${s.retry_behavior},
                  ${s.staff_instructions ?? null}, ${s.guest_text ?? null})`;
      }
      await writeAudit(actor, {
        entityType: "payment_policy",
        entityId: policyId,
        action: p.id ? "update" : "create",
        after: { name: p.name, code: p.code, stages: p.stages.length, is_default: p.is_default },
      }, tx);
      return policyId;
    });

    revalidatePath("/settings");
    return { success: true, data: { id } };
  } catch (e) {
    return fail(e, "payment_save");
  }
}

export async function deletePaymentPolicyAction(rawId: unknown): Promise<ActionResult> {
  return archivePolicy("payment", rawId);
}

// ---- shared helpers ----

// Demote every live default of a tenant so the partial unique index (one default
// per tenant) is never violated when the caller sets a new default in the same tx.
async function demoteDefaults(
  tx: TransactionSql,
  table: "cancellation_policies" | "payment_policies",
  tenantId: string,
): Promise<void> {
  if (table === "cancellation_policies") {
    await tx`UPDATE guesthub.cancellation_policies SET is_default = false
             WHERE tenant_id = ${tenantId} AND is_default AND NOT is_archived`;
  } else {
    await tx`UPDATE guesthub.payment_policies SET is_default = false
             WHERE tenant_id = ${tenantId} AND is_default AND NOT is_archived`;
  }
}

// Soft-archive a policy (§F "prevent deletion when referenced, or archive it
// safely"). The default policy cannot be archived while default — a tenant must
// always keep a default; reassign first. A policy referenced by a live rate
// plan cannot be archived either — the rate plan must be re-assigned first, so
// the template→assignment link is never silently broken (reservations are
// unaffected either way: they hold their own at-booking snapshot, 034).
async function archivePolicy(kind: "cancellation" | "payment", rawId: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    if (typeof rawId !== "string") return { success: false, error: "מזהה לא תקין" };

    const res = await sql.begin(async (tx) => {
      const found = kind === "cancellation"
        ? await tx<{ id: string; is_default: boolean; name: string }[]>`
            SELECT id, is_default, name FROM guesthub.cancellation_policies
            WHERE id = ${rawId} AND tenant_id = ${actor.tenantId} AND NOT is_archived FOR UPDATE`
        : await tx<{ id: string; is_default: boolean; name: string }[]>`
            SELECT id, is_default, name FROM guesthub.payment_policies
            WHERE id = ${rawId} AND tenant_id = ${actor.tenantId} AND NOT is_archived FOR UPDATE`;
      const row = found[0];
      if (!row) return { success: false as const, error: "המדיניות לא נמצאה" };
      if (row.is_default)
        return { success: false as const, error: "לא ניתן למחוק מדיניות ברירת מחדל — קבע ברירת מחדל אחרת תחילה" };
      const [ref] = kind === "cancellation"
        ? await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM guesthub.pricing_plans
            WHERE tenant_id = ${actor.tenantId} AND cancellation_policy_id = ${rawId}
              AND NOT is_archived`
        : await tx<{ n: number }[]>`
            SELECT count(*)::int AS n FROM guesthub.pricing_plans
            WHERE tenant_id = ${actor.tenantId} AND payment_policy_id = ${rawId}
              AND NOT is_archived`;
      if (ref && ref.n > 0)
        return {
          success: false as const,
          error: `המדיניות משויכת ל-${ref.n} תוכניות מחיר — הסר את השיוך בתוכניות תחילה`,
        };
      if (kind === "cancellation") {
        await tx`UPDATE guesthub.cancellation_policies SET is_archived = true, is_active = false, updated_by = ${actor.userId} WHERE id = ${rawId}`;
      } else {
        await tx`UPDATE guesthub.payment_policies SET is_archived = true, is_active = false, updated_by = ${actor.userId} WHERE id = ${rawId}`;
      }
      await writeAudit(actor, {
        entityType: kind === "cancellation" ? "cancellation_policy" : "payment_policy",
        entityId: rawId,
        action: "archive",
        before: { name: row.name },
      }, tx);
      return { success: true as const };
    });

    if (res.success) revalidatePath("/settings");
    return res;
  } catch (e) {
    return fail(e, "archive");
  }
}
