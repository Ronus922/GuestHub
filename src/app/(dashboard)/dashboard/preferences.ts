import "server-only";
import { sql } from "@/lib/db";
import { normalizeDashboardLayout, type DashboardPreferences } from "./windows";

// ============================================================
// Reading the one key this screen owns out of users.ui_preferences (072).
//
// The column is per-USER, so the read is keyed by (id, tenant_id) — the tenant
// predicate is not decoration: every table in this schema is read through it
// (there is no RLS), and a user id alone would be a cross-tenant read waiting
// for a bug elsewhere to hand it the wrong id.
//
// Whatever comes back is passed through normalizeDashboardLayout() before it
// reaches the screen, so a row written by an older build — or by hand — cannot
// hide a window that exists today or resurrect one that does not.
// ============================================================

export async function getDashboardPreferences(
  userId: string,
  tenantId: string,
): Promise<DashboardPreferences> {
  const [row] = await sql<{ dashboard: unknown }[]>`
    SELECT ui_preferences -> 'dashboard' AS dashboard
    FROM guesthub.users
    WHERE id = ${userId} AND tenant_id = ${tenantId}`;
  return normalizeDashboardLayout(row?.dashboard ?? null);
}
