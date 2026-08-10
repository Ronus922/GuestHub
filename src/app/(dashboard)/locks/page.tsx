import { after } from "next/server";
import { redirect } from "next/navigation";
import { getActor, hasPermission } from "@/lib/auth/actor";
import { Icon } from "@/components/shared/Icon";
import { sql } from "@/lib/db";
import { syncLocks } from "@/lib/ttlock/locks";
import { syncPasscodes, recordTTLockCircuitOutcome } from "@/lib/ttlock/passcodes";
import { ttlockSecretsConfigured } from "@/lib/ttlock/crypto";
import { listLocksAction } from "./actions";
import { LocksBoard } from "./LocksBoard";

export const dynamic = "force-dynamic";

/** Screen-entry data older than this fires the background stale-sync. */
const STALE_AFTER_MS = 30 * 60 * 1000;

// /locks — the smart-lock board (D123): which doors this account can reach, and
// which room each one opens. Page load renders straight from the DB; the ONE
// automatic TTLock touch left is the STALE-GUARD below — a background full sync
// fired on entry when the snapshot is over 30 minutes old AND the circuit
// breaker is closed. The response never waits for it (after() runs once the
// page is sent); the fresh rows land in the DB for the next read, and
// "סונכרן לאחרונה" tells the operator which snapshot they are looking at.
// With the breaker open the sync is SKIPPED and the amber banner is the
// answer — rule 18 in check-ttlock-secrets pins that gate.
//
// The permission gate here mirrors the one listLocksAction enforces. Hiding the
// sidebar entry is not security — the Server Action is the real boundary, and
// it checks again on every call.

function isStale(lastSyncedAt: string | null): boolean {
  // Never-synced is NOT stale: that state renders its own empty screen whose
  // next step is the operator's explicit first sync, not a silent background one.
  if (!lastSyncedAt) return false;
  const at = new Date(lastSyncedAt).getTime();
  return Number.isFinite(at) && Date.now() - at > STALE_AFTER_MS;
}

export default async function LocksPage() {
  const actor = await getActor();
  if (!actor) redirect("/auth/signout");
  if (!hasPermission(actor, "locks.view")) redirect("/dashboard");

  const res = await listLocksAction();

  if (!res.success) {
    return (
      <div className="flex flex-col gap-5 p-[26px]" dir="rtl">
        <h1 className="h1">מנעולים</h1>
        <div className="flex items-start gap-3 rounded-2xl border border-status-danger bg-status-danger-050 p-4">
          <Icon name="warning" size={20} className="mt-0.5 shrink-0 text-status-danger" />
          <p className="t-secondary text-status-danger">{res.error}</p>
        </div>
      </div>
    );
  }

  const view = res.data!;
  const stale = isStale(view.lastSyncedAt);
  const secretsReady = ttlockSecretsConfigured();
  const tenantId = actor.tenantId;

  // The gate is one parenthesis-free condition ON PURPOSE — rule 18 parses it
  // and fails the build if the ttlockAlert (breaker-open) term ever drops out.
  if (view.connectionConfigured && view.ttlockAlert === null && stale && secretsReady) {
    after(async () => {
      try {
        await syncLocks(tenantId, sql);
        await syncPasscodes(tenantId, sql);
        await recordTTLockCircuitOutcome(tenantId, sql, null);
      } catch (e) {
        // Silent by design — there is no toast target after the response. The
        // breaker records the failure, so the next entry inside the cooldown
        // skips the sync and shows the banner instead of hammering the quota.
        await recordTTLockCircuitOutcome(tenantId, sql, e);
      }
    });
  }

  return <LocksBoard initial={view} />;
}
