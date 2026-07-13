import type { Sql, TransactionSql } from "postgres";

export type AuditActorRef = { tenantId: string; userId: string };

export type AuditEntry = {
  entityType: string;
  entityId: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  session?: string | null;
};

// Pure SQL audit primitive shared by the request-aware adapter and mutation
// cores. Passing the transaction keeps the domain write and audit indivisible.
export async function writeAuditRecord(
  actor: AuditActorRef,
  entry: AuditEntry,
  db: Sql | TransactionSql,
): Promise<void> {
  await db`
    INSERT INTO guesthub.audit_logs
      (tenant_id, user_id, entity_type, entity_id, action, before_data, after_data, ip_address, session_info)
    VALUES (
      ${actor.tenantId}, ${actor.userId}, ${entry.entityType}, ${entry.entityId ?? null},
      ${entry.action},
      ${entry.before === undefined ? null : db.json(entry.before as never)},
      ${entry.after === undefined ? null : db.json(entry.after as never)},
      ${entry.ip ?? null}, ${entry.session ?? null}
    )`;
}
