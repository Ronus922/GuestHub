import type { Sql, TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import type { Actor } from "@/lib/auth/actor";

// Records a mutation in guesthub.audit_logs. Every Server Action that changes data
// calls this after the change succeeds. Tenant-scoped via the actor. Pass a
// transaction handle as `db` to commit the audit atomically with the change.
export async function writeAudit(
  actor: Actor,
  entry: {
    entityType: string;
    entityId: string | null;
    action: string;
    before?: unknown;
    after?: unknown;
  },
  db: Sql | TransactionSql = sql,
): Promise<void> {
  await db`
    INSERT INTO guesthub.audit_logs
      (tenant_id, user_id, entity_type, entity_id, action, before_data, after_data)
    VALUES (
      ${actor.tenantId}, ${actor.userId}, ${entry.entityType}, ${entry.entityId ?? null},
      ${entry.action},
      ${entry.before === undefined ? null : sql.json(entry.before as never)},
      ${entry.after === undefined ? null : sql.json(entry.after as never)}
    )`;
}
