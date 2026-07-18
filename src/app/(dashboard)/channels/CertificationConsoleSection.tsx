"use client";

import { useState, useTransition } from "react";
import {
  getCertificationEvidenceAction,
  type CertificationEvidenceView,
} from "@/lib/channel/certification";

// Read-only Channex certification console (§13). Displays the evidence ledger
// and the production-activation status. It triggers NO scenario — the only
// action is "refresh", which re-reads evidence. All timestamps are rendered from
// the ISO string directly (UTC, deterministic) so there is no hydration drift.

const OUTCOME_LABEL: Record<string, string> = {
  success: "הצליח",
  partial: "חלקי",
  failed: "נכשל",
};
const OUTCOME_TONE: Record<string, string> = {
  success: "text-emerald-700",
  partial: "text-amber-700",
  failed: "text-rose-700",
};

const fmt = (iso: string) => iso.slice(0, 16).replace("T", " ") + "Z";

export function CertificationConsoleSection({ initial }: { initial: CertificationEvidenceView }) {
  const [data, setData] = useState<CertificationEvidenceView>(initial);
  const [pending, startTransition] = useTransition();

  const refresh = () =>
    startTransition(async () => {
      const res = await getCertificationEvidenceAction({ limit: 100 });
      if (res.success) setData(res.data);
    });

  const act = data.activation;

  return (
    <section className="card">
      <div className="card-bd flex flex-col gap-4">
        <div className="flex flex-row-reverse items-center justify-between gap-2">
          <h2 className="h2">קונסולת הסמכה (Channex) — קריאה בלבד</h2>
          <button
            type="button"
            onClick={refresh}
            disabled={pending}
            className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
          >
            {pending ? "מרענן…" : "רענון ראיות"}
          </button>
        </div>

        {/* production-activation status */}
        <div className="flex flex-row-reverse flex-wrap gap-2 text-sm">
          <span
            className={`rounded-lg px-3 py-2 ${act.activationEnabled ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}
          >
            סביבה פעילה: {act.effectiveEnvironment === "production" ? "production" : "staging"}
          </span>
          <span className="rounded-lg bg-slate-50 px-3 py-2 text-slate-600">
            production {act.activationEnabled ? "מופעל" : "כבוי (guard)"}
          </span>
        </div>

        {/* per-scenario roll-up */}
        {data.summary.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead>
                <tr className="border-b text-slate-500">
                  <th className="px-4 py-3">תרחיש</th>
                  <th className="px-4 py-3">סה״כ</th>
                  <th className="px-4 py-3">הצליח</th>
                  <th className="px-4 py-3">חלקי</th>
                  <th className="px-4 py-3">נכשל</th>
                  <th className="px-4 py-3">Task IDs</th>
                  <th className="px-4 py-3">אחרון</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.map((s) => (
                  <tr key={s.scenarioKey} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{s.scenarioKey}</td>
                    <td className="px-4 py-3">{s.total}</td>
                    <td className="px-4 py-3 text-emerald-700">{s.success}</td>
                    <td className="px-4 py-3 text-amber-700">{s.partial}</td>
                    <td className="px-4 py-3 text-rose-700">{s.failed}</td>
                    <td className="px-4 py-3">{s.taskIdCount}</td>
                    <td className="px-4 py-3 text-slate-500">{s.lastAt ? fmt(s.lastAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* evidence rows */}
        {data.rows.length === 0 ? (
          <p className="text-sm text-slate-500">אין עדיין ראיות מתועדות. הפעל תרחישים דרך ה-UI כדי לצבור ראיות.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead>
                <tr className="border-b text-slate-500">
                  <th className="px-4 py-3">מתי</th>
                  <th className="px-4 py-3">תרחיש</th>
                  <th className="px-4 py-3">בקשות</th>
                  <th className="px-4 py-3">Task IDs</th>
                  <th className="px-4 py-3">תוצאה</th>
                  <th className="px-4 py-3">מקור (file · function)</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{fmt(r.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.scenarioKey}</div>
                      {r.uiWorkflow && <div className="text-xs text-slate-500">{r.uiWorkflow}</div>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.requestCount}
                      {r.expectedRequests != null && (
                        <span className="text-xs text-slate-400"> / {r.expectedRequests}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {r.taskIds.length ? r.taskIds.join(", ") : "—"}
                    </td>
                    <td className={`px-4 py-3 whitespace-nowrap ${OUTCOME_TONE[r.outcome] ?? ""}`}>
                      {OUTCOME_LABEL[r.outcome] ?? r.outcome}
                      {r.errorMessage && <div className="text-xs text-slate-400">{r.errorMessage}</div>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {r.firingFile ?? "—"}
                      {r.firingFunction ? ` · ${r.firingFunction}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
