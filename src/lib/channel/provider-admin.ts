"use server";
import "server-only";
import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";

// ============================================================
// Active-provider selector (D79) — ONE channel provider works at a time per
// tenant; the rest stay configured as dormant backups. The DB guarantees the
// invariant (partial unique index uq_one_active_provider_per_tenant, mig 046);
// worker loaders, the worker job guard, and the webhook route all filter on
// is_active_provider, so switching here really stops the dormant provider.
// ============================================================

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

const SELECTABLE = ["beds24", "hospitable", "channex"] as const;
export type SelectableProvider = (typeof SELECTABLE)[number];

export type ProviderChoice = {
  provider: SelectableProvider;
  state: string;
  isActive: boolean;
};

async function requireChannelAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("נדרשת התחברות");
  const gate = canManageChannels({ userId: actor.userId, roleKey: actor.roleKey });
  if (!gate.ok) throw new AuthorizationError("אין הרשאה לניהול ערוצים");
  return actor;
}

export async function getActiveProviderAction(): Promise<Result<{ choices: ProviderChoice[] }>> {
  try {
    const actor = await requireChannelAdmin();
    const rows = await sql<{ provider: SelectableProvider; state: string; is_active_provider: boolean }[]>`
      SELECT provider, state, is_active_provider
      FROM guesthub.channel_connections
      WHERE tenant_id = ${actor.tenantId} AND provider IN ('beds24','hospitable','channex')`;
    // display order: beds24 first (the default working provider), then the rest
    const order: Record<string, number> = { beds24: 0, hospitable: 1, channex: 2 };
    const choices = rows
      .map((r) => ({ provider: r.provider, state: r.state, isActive: r.is_active_provider }))
      .sort((a, b) => (order[a.provider] ?? 9) - (order[b.provider] ?? 9));
    return { success: true, data: { choices } };
  } catch (e) {
    return { success: false, error: e instanceof AuthorizationError ? e.message : "שגיאה בטעינת הספק הפעיל" };
  }
}

export async function setActiveProviderAction(input: {
  provider: SelectableProvider;
}): Promise<Result> {
  try {
    const actor = await requireChannelAdmin();
    if (!SELECTABLE.includes(input.provider)) {
      return { success: false, error: "ספק לא מוכר" };
    }
    const changed = await sql.begin(async (tx) => {
      const [target] = await tx<{ id: string; state: string }[]>`
        SELECT id, state FROM guesthub.channel_connections
        WHERE tenant_id = ${actor.tenantId} AND provider = ${input.provider}
        FOR UPDATE`;
      if (!target) return { ok: false as const, error: "אין חיבור מוגדר לספק זה" };
      // clear-then-set inside one tx — the partial unique index makes any
      // concurrent second writer fail loudly instead of leaving two actives
      await tx`
        UPDATE guesthub.channel_connections
        SET is_active_provider = false, updated_at = now()
        WHERE tenant_id = ${actor.tenantId} AND is_active_provider = true`;
      await tx`
        UPDATE guesthub.channel_connections
        SET is_active_provider = true, updated_at = now()
        WHERE id = ${target.id}`;
      return { ok: true as const, targetId: target.id };
    });
    if (!changed.ok) return { success: false, error: changed.error };
    const ctx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: changed.targetId,
      action: "set_active_provider",
      after: { provider: input.provider },
      ...ctx,
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof AuthorizationError ? e.message : "החלפת הספק הפעיל נכשלה" };
  }
}
