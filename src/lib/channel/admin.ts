"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";

// ============================================================
// Channel-management server actions (§O) — super_admin ONLY, enforced
// server-side on every action (UI hiding is not security). The channel provider
// is Beds24 (D91); this file holds only the provider-neutral observability
// snapshot the /channels diagnostics screen reads. Beds24 connect/map/full-sync
// live in beds24-admin.ts; ARI status is rendered by Beds24Section.
// ============================================================

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

async function requireChannelAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  const guard = canManageChannels({ userId: actor.userId, roleKey: actor.roleKey });
  if (!guard.ok) throw new AuthorizationError(guard.error);
  return actor;
}

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError || (e instanceof Error && e.message.startsWith("ניהול")))
    return { success: false, error: (e as Error).message };
  console.error("[channel-admin]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

// Observability snapshot (§AA): connection state, queue health, dirty backlog,
// latest errors — masked metadata only, never secrets.
export async function getChannelStatusAction(): Promise<Result<unknown>> {
  try {
    const actor = await requireChannelAdmin();
    const connections = await sql`
      SELECT id, provider, environment, state,
             outbound_sync_enabled, inbound_sync_enabled, full_sync_required,
             api_key_hint, last_outbound_sync_at, last_inbound_import_at,
             last_reconciliation_at, last_error, created_at, updated_at
      FROM guesthub.channel_connections
      WHERE tenant_id = ${actor.tenantId}
      ORDER BY created_at`;
    const [counts] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM guesthub.channel_sync_jobs
          WHERE tenant_id = ${actor.tenantId} AND status IN ('queued','retry_wait')) AS pending_jobs,
        (SELECT COUNT(*)::int FROM guesthub.channel_sync_jobs
          WHERE tenant_id = ${actor.tenantId} AND status = 'failed') AS failed_jobs,
        (SELECT COUNT(*)::int FROM guesthub.channel_sync_jobs
          WHERE tenant_id = ${actor.tenantId} AND status = 'dead_letter') AS dead_letter_jobs,
        (SELECT COUNT(*)::int FROM guesthub.channel_dirty_ranges
          WHERE tenant_id = ${actor.tenantId} AND status = 'pending') AS dirty_ranges,
        (SELECT COUNT(*)::int FROM guesthub.channel_booking_revisions
          WHERE tenant_id = ${actor.tenantId} AND import_status = 'quarantined') AS quarantined_revisions`;
    const errors = await sql`
      SELECT id, connection_id, room_type_id, date_from, date_to,
             error_code, error_message, created_at
      FROM guesthub.channel_sync_errors
      WHERE tenant_id = ${actor.tenantId} AND resolved_at IS NULL
      ORDER BY created_at DESC LIMIT 10`;
    return { success: true, data: { connections, counts, errors } };
  } catch (e) {
    return failFrom(e);
  }
}

