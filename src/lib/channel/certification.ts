"use server";

import { getActor, AuthorizationError } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { loadEvidenceLedger, type EvidenceRow } from "./evidence";
import { channexActivationStatus, type ProductionActivationStatus } from "./production-guard";

// ============================================================
// Read-only certification console (Stage 4 §13).
//
// STRICTLY read-only: this module exposes evidence, monitoring and the
// production-activation status ONLY. It contains NO action that triggers a
// Channex scenario (no sync, no send, no booking, no property/room/rate
// mutation). Scenario triggering lives with the real product workflows; the
// console just displays what those produced. `check:channex-certification-evidence`
// enforces this boundary statically.
// ============================================================

type Result<T> = { success: true; data: T } | { success: false; error: string };

export type CertificationEvidenceView = {
  activation: ProductionActivationStatus;
  rows: EvidenceRow[];
  summary: {
    scenarioKey: string;
    total: number;
    success: number;
    partial: number;
    failed: number;
    taskIdCount: number;
    lastAt: string | null;
  }[];
};

export async function getCertificationEvidenceAction(
  opts?: { limit?: number; scenarioKey?: string },
): Promise<Result<CertificationEvidenceView>> {
  try {
    const actor = await getActor();
    if (!actor) throw new AuthorizationError("לא מחובר למערכת");
    const guard = canManageChannels({ userId: actor.userId, roleKey: actor.roleKey });
    if (!guard.ok) throw new AuthorizationError(guard.error);

    const rows = await loadEvidenceLedger(actor.tenantId, opts);

    // per-scenario roll-up for the console header.
    const byScenario = new Map<string, CertificationEvidenceView["summary"][number]>();
    for (const r of rows) {
      const s = byScenario.get(r.scenarioKey) ?? {
        scenarioKey: r.scenarioKey, total: 0, success: 0, partial: 0, failed: 0, taskIdCount: 0, lastAt: null,
      };
      s.total += 1;
      if (r.outcome === "success") s.success += 1;
      else if (r.outcome === "partial") s.partial += 1;
      else s.failed += 1;
      s.taskIdCount += r.taskIds.length;
      if (!s.lastAt || r.createdAt > s.lastAt) s.lastAt = r.createdAt;
      byScenario.set(r.scenarioKey, s);
    }

    return {
      success: true,
      data: {
        activation: channexActivationStatus(),
        rows,
        summary: [...byScenario.values()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "")),
      },
    };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[certification-console]", e);
    return { success: false, error: "אירעה שגיאה בטעינת ראיות ההסמכה" };
  }
}
