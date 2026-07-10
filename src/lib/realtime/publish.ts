import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { encodeDomainEvent, EVENTS_CHANNEL, type DomainEventInput } from "./events";

// ============================================================
// publishDomainEvent (D77 §6) — called INSIDE the business transaction with
// the SAME handle as the write. PostgreSQL delivers NOTIFY only on COMMIT
// (verified through the Supavisor session pooler), so a rolled-back write can
// never emit its event and "published" always means "durably committed".
//
// Runs in BOTH processes: Next.js server actions and the PM2 channel worker
// (OTA imports) — pg NOTIFY is the cross-process bus; the web-process hub
// (./hub) fans events out to the browsers of the right tenant.
//
// A publish failure must never fail the business write it rides on — the
// event is a freshness hint, the row is the truth. Hence the swallow.
// ============================================================

export async function publishDomainEvent(
  db: Sql | TransactionSql,
  tenantId: string,
  event: DomainEventInput,
): Promise<void> {
  try {
    const payload = encodeDomainEvent(tenantId, event, new Date().toISOString());
    await db`SELECT pg_notify(${EVENTS_CHANNEL}, ${payload})`;
  } catch (e) {
    console.error("[realtime] publish failed", e instanceof Error ? e.message : e);
  }
}
