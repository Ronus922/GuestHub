"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { parseVatRate, VAT_MAX, VAT_MIN } from "@/lib/vat";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// שיעור מע״מ (%) — tenant business setting (D41). Display-only for pricing:
// totals remain VAT-inclusive and are NEVER recalculated by a rate change.
export async function updateVatRateAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");

    const rate = parseVatRate(raw);
    if (rate === null) {
      return {
        success: false,
        error: `שיעור מע״מ חייב להיות מספר בין ${VAT_MIN} ל־${VAT_MAX} (עד שתי ספרות אחרי הנקודה)`,
      };
    }

    await sql.begin(async (tx) => {
      const [before] = await tx<{ vat_rate: string | null }[]>`
        SELECT settings->>'vat_rate' AS vat_rate
        FROM guesthub.tenants WHERE id = ${actor.tenantId} FOR UPDATE`;
      await tx`
        UPDATE guesthub.tenants
        SET settings = jsonb_set(settings, '{vat_rate}', to_jsonb(${rate}::numeric)),
            updated_at = now()
        WHERE id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "tenant_settings",
        entityId: actor.tenantId,
        action: "update_vat_rate",
        before: { vat_rate: before?.vat_rate ?? null },
        after: { vat_rate: rate },
      }, tx);
    });

    revalidatePath("/settings");
    revalidatePath("/calendar");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[settings]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// המטבעות המופעלים להזמנות (D107) — settings.enabled_currencies. The tenant
// base currency is always a member (rate tables + Beds24 publishing live in
// it); a reservation priced in any OTHER enabled currency requires a manual
// price mode on every room — enforced by the reservation actions, not here.
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

export async function updateEnabledCurrenciesAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");

    const list = Array.isArray(raw) ? raw : null;
    if (!list || list.length > 10) return { success: false, error: "רשימת מטבעות לא תקינה" };
    const cleaned = [...new Set(list.map((c) => String(c).trim().toUpperCase()))];
    if (cleaned.some((c) => !CURRENCY_CODE_RE.test(c))) {
      return { success: false, error: "קוד מטבע חייב להיות שלוש אותיות (ISO-4217), למשל USD" };
    }

    await sql.begin(async (tx) => {
      const [t] = await tx<{ currency: string; enabled: unknown }[]>`
        SELECT currency, settings->'enabled_currencies' AS enabled
        FROM guesthub.tenants WHERE id = ${actor.tenantId} FOR UPDATE`;
      const base = (t?.currency ?? "ILS").toUpperCase();
      const next = [...new Set([base, ...cleaned])];
      await tx`
        UPDATE guesthub.tenants
        SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{enabled_currencies}', ${tx.json(next as never)}),
            updated_at = now()
        WHERE id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "tenant_settings",
        entityId: actor.tenantId,
        action: "update_enabled_currencies",
        before: { enabled_currencies: t?.enabled ?? null },
        after: { enabled_currencies: next },
      }, tx);
    });

    revalidatePath("/settings");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[settings]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}
