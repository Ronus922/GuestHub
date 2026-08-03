"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { SidePanel } from "@/components/ui/SidePanel";
import { Donut } from "@/components/shared/Donut";
import { SegmentedControl } from "@/components/shared/SegmentedControl";
import { exportReservationsCsvAction } from "@/lib/reports/export";
import type { SourceMetric, SourcesBreakdown } from "@/lib/reports/sources-breakdown";
import { sourcesBreakdownAction } from "../actions";
import { PERIOD_LABEL, type SourcesPeriod } from "../period";

// ============================================================
// The full sources breakdown — a DRAWER on the dashboard, not a route.
//
// It is the canonical SidePanel (GUIDELINES §7), not a second drawer shell:
// Esc, backdrop click, the brand header bar and the close button all come from
// there. D125 is the precedent — the /locks drawer was moved onto this same
// panel for exactly this reason.
//
// Every number comes from sourcesBreakdownAction → sourcesBreakdown(), the SAME
// function that produced the window behind it. Changing the period re-queries
// that function over a different span; it never becomes a second definition.
//
// TWO summary cards, not the reference's three. Its third is "סוכנים וחברות"
// and the schema has no agent or company concept at all (audit contradiction
// 30), so the card could only ever read zero.
// ============================================================

const PERIODS: readonly { value: SourcesPeriod; label: string }[] = [
  { value: "month", label: PERIOD_LABEL.month },
  { value: "quarter", label: PERIOD_LABEL.quarter },
  { value: "year", label: PERIOD_LABEL.year },
];
const METRICS: readonly { value: SourceMetric; label: string }[] = [
  { value: "guests", label: "אורחים" },
  { value: "reservations", label: "הזמנות" },
];

const ils = (n: number) => `₪${Math.round(n).toLocaleString("he-IL")}`;

export function SourcesDrawer({
  initial,
  onClose,
}: {
  initial: SourcesBreakdown;
  onClose: () => void;
}) {
  const [period, setPeriod] = useState<SourcesPeriod>("month");
  const [metric, setMetric] = useState<SourceMetric>("guests");
  const [data, setData] = useState<SourcesBreakdown>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [exporting, startExport] = useTransition();

  const requery = (p: SourcesPeriod, m: SourceMetric) => {
    setPeriod(p);
    setMetric(m);
    start(async () => {
      const res = await sourcesBreakdownAction(p, m);
      if (res.success && res.data) setData(res.data);
      else if (!res.success) toast.error(res.error);
    });
  };

  const exportCsv = () => {
    startExport(async () => {
      // the EXISTING export path — the drawer adds no second CSV writer
      const res = await exportReservationsCsvAction({ from: data.from, to: data.to });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      const blob = new Blob([`﻿${res.csv}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("הקובץ הורד");
    });
  };

  const metricOf = (r: SourcesBreakdown["rows"][number]) =>
    metric === "guests" ? r.guests : r.reservations;
  const totalMetric = metric === "guests" ? data.totals.guests : data.totals.reservations;
  const unit = metric === "guests" ? "אורחים" : "הזמנות";

  const active = selected ? data.rows.find((r) => r.sourceId === selected) : undefined;
  const direct = data.rows.filter((r) => r.channel === "direct");
  const ota = data.rows.filter((r) => r.channel === "ota");
  const sum = (rows: typeof data.rows) => ({
    metric: rows.reduce((a, r) => a + metricOf(r), 0),
    revenue: Math.round(rows.reduce((a, r) => a + Math.round(r.revenue * 100), 0)) / 100,
  });
  const directSum = sum(direct);
  const otaSum = sum(ota);

  return (
    <SidePanel
      open
      onClose={onClose}
      title="פילוח מקורות הזמנה"
      subtitle={`${data.from} — ${data.to}`}
      icon="donut"
      footer={
        <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={exporting}>
          ייצוא CSV
        </button>
      }
    >
      <div className="card sd-controls">
        <SegmentedControl
          segments={PERIODS}
          value={period}
          onChange={(p) => requery(p, metric)}
          label="תקופה"
          grow
        />
        <SegmentedControl
          segments={METRICS}
          value={metric}
          onChange={(m) => requery(period, m)}
          label="מדד"
          grow
        />
      </div>

      {data.rows.length === 0 ? (
        <div className="card empty-state">
          <span className="empty-t">אין הזמנות בתקופה שנבחרה</span>
        </div>
      ) : (
        <>
          <div className={`card sd-main${pending ? " loading" : ""}`}>
            <Donut
              slices={data.rows.map((r) => ({
                id: r.sourceId,
                value: metricOf(r),
                color: r.color,
                label: r.label,
              }))}
              size={280}
              selectedId={selected}
              onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
              centerValue={String(active ? metricOf(active) : totalMetric)}
              centerUnit={unit}
              centerLabel={active?.label}
              label="פילוח מקורות הזמנה"
            />
            <ul className="sd-legend">
              {data.rows.map((r) => {
                const v = metricOf(r);
                const pct = totalMetric > 0 ? Math.round((v / totalMetric) * 1000) / 10 : 0;
                return (
                  <li key={r.sourceId}>
                    <button
                      type="button"
                      className={`sd-legend-row${selected === r.sourceId ? " on" : ""}`}
                      onClick={() => setSelected((cur) => (cur === r.sourceId ? null : r.sourceId))}
                    >
                      <span className="src-dot" style={{ background: r.color }} aria-hidden />
                      <span className="sd-legend-label">{r.label}</span>
                      <span className="sd-legend-n ltr-num">{v}</span>
                      <span className="sd-legend-pct ltr-num">{pct}%</span>
                      <span className="sd-meter" aria-hidden>
                        <span className="sd-meter-fill" style={{ width: `${pct}%`, background: r.color }} />
                      </span>
                      <span className="sd-legend-rev ltr-num">{ils(r.revenue)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="sd-cards">
            <SummaryCard
              title="ישיר"
              value={directSum.metric}
              unit={unit}
              revenue={directSum.revenue}
              share={totalMetric > 0 ? Math.round((directSum.metric / totalMetric) * 1000) / 10 : 0}
            />
            <SummaryCard
              title="OTA"
              value={otaSum.metric}
              unit={unit}
              revenue={otaSum.revenue}
              share={totalMetric > 0 ? Math.round((otaSum.metric / totalMetric) * 1000) / 10 : 0}
            />
          </div>
        </>
      )}
    </SidePanel>
  );
}

function SummaryCard({
  title,
  value,
  unit,
  revenue,
  share,
}: {
  title: string;
  value: number;
  unit: string;
  revenue: number;
  share: number;
}) {
  return (
    <div className="card sd-card">
      <span className="sd-card-t">{title}</span>
      <span className="sd-card-v">
        <span className="ltr-num">{value}</span>
      </span>
      <span className="sd-card-u">
        {unit} · <span className="ltr-num">{share}%</span>
      </span>
      <span className="sd-card-r">
        <span className="ltr-num">{ils(revenue)}</span>
      </span>
    </div>
  );
}
