"use server";

import { sql } from "@/lib/db";
import { getActor } from "@/lib/auth/actor";
import { requirePermission, AuthorizationError } from "@/lib/auth/permission-check";
import { writeAudit } from "@/lib/audit";
import { toCsv } from "./csv";

// ============================================================
// Data export (Stage 5 §1 completeness) — reservation + guest CSV exports. Serves
// accountant handoff and the privacy right-to-portability (§21). Read-only,
// tenant-scoped, injection-hardened via toCsv. The export itself is audited (the
// fact of an export, never the exported PII).
// ============================================================

type Result = { success: true; filename: string; csv: string } | { success: false; error: string };

export async function exportReservationsCsvAction(range?: { from?: string; to?: string }): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "reservations.view");
    const from = range?.from ?? null;
    const to = range?.to ?? null;
    const rows = await sql<Record<string, unknown>[]>`
      SELECT r.reservation_number, r.status, r.booking_origin,
             COALESCE(NULLIF(btrim(r.ota_name),''),'') AS ota_name,
             r.check_in::text AS check_in, r.check_out::text AS check_out,
             r.adults, r.children, r.infants,
             r.total_price::float8 AS total_price, r.paid_amount::float8 AS paid_amount,
             r.balance::float8 AS balance, r.currency,
             g.full_name AS guest_name
      FROM guesthub.reservations r
      LEFT JOIN guesthub.guests g ON g.id = r.primary_guest_id AND g.tenant_id = r.tenant_id
      WHERE r.tenant_id = ${actor.tenantId}
        ${from ? sql`AND r.check_out > ${from}` : sql``}
        ${to ? sql`AND r.check_in < ${to}` : sql``}
      ORDER BY r.check_in DESC, r.reservation_number`;
    const cols = ["reservation_number", "status", "booking_origin", "ota_name", "check_in", "check_out",
      "adults", "children", "infants", "total_price", "paid_amount", "balance", "currency", "guest_name"];
    const headers = ["מספר הזמנה", "סטטוס", "מקור", "ערוץ", "כניסה", "יציאה", "מבוגרים", "ילדים", "תינוקות",
      "סה\"כ", "שולם", "יתרה", "מטבע", "אורח"];
    await writeAudit(actor, { entityType: "reservations", entityId: null, action: "export_csv", after: { rows: rows.length, from, to } });
    return { success: true, filename: "reservations.csv", csv: toCsv(headers, rows, cols) };
  } catch (e) {
    return fail(e);
  }
}

export async function exportGuestsCsvAction(): Promise<Result> {
  try {
    const actor = await getActor();
    requirePermission(actor, "guests.view");
    const rows = await sql<Record<string, unknown>[]>`
      SELECT full_name, COALESCE(email,'') AS email, COALESCE(phone,'') AS phone,
             COALESCE(country,'') AS country, COALESCE(city,'') AS city,
             CASE WHEN anonymized_at IS NULL THEN '' ELSE 'כן' END AS anonymized
      FROM guesthub.guests
      WHERE tenant_id = ${actor.tenantId}
      ORDER BY full_name`;
    const cols = ["full_name", "email", "phone", "country", "city", "anonymized"];
    const headers = ["שם", "אימייל", "טלפון", "מדינה", "עיר", "עבר אנונימיזציה"];
    await writeAudit(actor, { entityType: "guests", entityId: null, action: "export_csv", after: { rows: rows.length } });
    return { success: true, filename: "guests.csv", csv: toCsv(headers, rows, cols) };
  } catch (e) {
    return fail(e);
  }
}

function fail(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[data-export]", e);
  return { success: false, error: "אירעה שגיאה בייצוא" };
}
