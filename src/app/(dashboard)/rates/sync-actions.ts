"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { getRatesSyncStatus, requestIncrementalSyncNow } from "@/lib/channel/rates-sync";
import type { RatesSyncStatus, SyncNowResult } from "@/lib/channel/sync-state";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// /rates sync actions (D75). Thin permission wrappers over the lib — the
// status read is rates.view (any grid viewer), the manual sync is rates.edit
// (whoever may change rates may push them). Channel ADMINISTRATION (Full Sync,
// credentials, mappings) stays super_admin-only on /channels; neither action
// here can reach it.
// ============================================================

const fail = (error: string): ActionResult<never> => ({ success: false, error });

function errorMessage(e: unknown): string {
  if (e instanceof AuthorizationError) return e.message;
  console.error("[rates-sync]", e);
  return "אירעה שגיאה בלתי צפויה";
}

export async function getRatesSyncStatusAction(): Promise<ActionResult<RatesSyncStatus>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rates.view");
    return { success: true, data: await getRatesSyncStatus(sql, actor.tenantId) };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

export type SyncNowSnapshot = SyncNowResult & { status: RatesSyncStatus };

export async function syncChannelsNowAction(): Promise<ActionResult<SyncNowSnapshot>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rates.edit");

    const result = await requestIncrementalSyncNow(sql, actor.tenantId);
    if ("error" in result) return fail(result.error);

    for (const connectionId of result.connectionIds) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: connectionId,
        action: "sync_channels_now",
        after: {
          retriedFailed: result.retriedFailed,
          pendingRanges: result.pendingRanges,
          nothingToSync: result.nothingToSync,
        },
      });
    }

    const status = await getRatesSyncStatus(sql, actor.tenantId);
    return {
      success: true,
      data: {
        retriedFailed: result.retriedFailed,
        pendingRanges: result.pendingRanges,
        nothingToSync: result.nothingToSync,
        status,
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
