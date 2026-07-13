import type { Sql, TransactionSql } from "postgres";
import { headers } from "next/headers";
import { sql } from "@/lib/db";
import type { Actor } from "@/lib/auth/actor";
import { writeAuditRecord, type AuditEntry } from "@/lib/audit-write";

export type { AuditEntry } from "@/lib/audit-write";

// Records a mutation in guesthub.audit_logs. Every Server Action that changes data
// calls this after the change succeeds. Tenant-scoped via the actor. Pass a
// transaction handle as `db` to commit the audit atomically with the change.
export async function writeAudit(
  actor: Actor,
  entry: AuditEntry,
  db: Sql | TransactionSql = sql,
): Promise<void> {
  await writeAuditRecord(actor, entry, db);
}

// System-initiated audit (no human actor) — used by the channel card ingest,
// which runs without a session. user_id is NULL; session_info carries the
// originating channel. NEVER pass card digits or a CVV in the payload.
export async function writeSystemAudit(
  tenantId: string,
  entry: AuditEntry,
  db: Sql | TransactionSql = sql,
): Promise<void> {
  await db`
    INSERT INTO guesthub.audit_logs
      (tenant_id, user_id, entity_type, entity_id, action, before_data, after_data, ip_address, session_info)
    VALUES (
      ${tenantId}, NULL, ${entry.entityType}, ${entry.entityId ?? null},
      ${entry.action},
      ${entry.before === undefined ? null : sql.json(entry.before as never)},
      ${entry.after === undefined ? null : sql.json(entry.after as never)},
      ${entry.ip ?? null}, ${entry.session ?? null}
    )`;
}

// Best-effort request identity for the audit trail (IP + session hint). Reads
// the proxy headers; degrades to nulls off the request path. The user-agent is
// truncated — it is a session hint, not a place for large blobs.
export async function auditRequestContext(): Promise<{ ip: string | null; session: string | null }> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    const ip = (fwd ? fwd.split(",")[0] : h.get("x-real-ip") ?? "").trim() || null;
    const ua = h.get("user-agent");
    return { ip, session: ua ? ua.slice(0, 300) : null };
  } catch {
    return { ip: null, session: null };
  }
}
