import type { Sql, TransactionSql } from "postgres";
import {
  validateCheckInCheckOutSettings,
  type CheckInCheckOutSettings,
} from "./check-in-check-out";
import { requirePermission, type PermissionActor } from "./auth/permission-check";
import { writeAuditRecord } from "./audit-write";

export type CheckInCheckOutMutationActor = PermissionActor & {
  userId: string;
  tenantId: string;
};

export class CheckInCheckOutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckInCheckOutValidationError";
  }
}

type MutationDb = Sql | TransactionSql;

// The one authoritative mutation boundary. The Server Action and disposable-DB
// verification both call this exact function, so authorization, validation,
// locking, JSONB sibling preservation and audit atomicity cannot drift apart.
export async function saveCheckInCheckOutSettingsCore({
  actor,
  raw,
  db,
}: {
  actor: CheckInCheckOutMutationActor | null;
  raw: unknown;
  db: MutationDb;
}): Promise<CheckInCheckOutSettings> {
  requirePermission(actor, "settings.edit");
  const parsed = validateCheckInCheckOutSettings(raw);
  if ("error" in parsed) throw new CheckInCheckOutValidationError(parsed.error);

  await atomic(db, async (tx) => {
    const [before] = await tx<{ check_in_check_out: unknown }[]>`
      SELECT settings->'check_in_check_out' AS check_in_check_out
      FROM guesthub.tenants
      WHERE id = ${actor.tenantId}
      FOR UPDATE`;
    if (!before) throw new CheckInCheckOutValidationError("הגדרות הנכס לא נמצאו");

    await tx`
      UPDATE guesthub.tenants
      SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{check_in_check_out}',
            ${db.json(parsed.data as never)}::jsonb,
            true
          ),
          updated_at = now()
      WHERE id = ${actor.tenantId}`;
    await writeAuditRecord(
      actor,
      {
        entityType: "tenant_settings",
        entityId: actor.tenantId,
        action: "update_check_in_check_out_hours",
        before: { check_in_check_out: before.check_in_check_out ?? null },
        after: { check_in_check_out: parsed.data },
      },
      tx,
    );
  });

  return parsed.data;
}

async function atomic(
  db: MutationDb,
  mutation: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  if ("begin" in db) {
    await db.begin(mutation);
    return;
  }
  await db.savepoint("check_in_check_out_save", mutation);
}
