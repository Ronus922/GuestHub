"use client";

import { useState } from "react";
import { Donut } from "@/components/shared/Donut";
import type { SourcesBreakdown } from "@/lib/reports/sources-breakdown";
import { SourcesDrawer } from "./SourcesDrawer";

// ============================================================
// src — פילוח מקורות הזמנה (DeshbordMain.md §5.6).
//
// The slices are the CURRENT month from sourcesBreakdown — the same call the
// drawer makes, so the window and the drawer can never show two different
// totals for the same period.
//
// It must look right at TWO slices, not only at eight. The live tenant has
// three or four sources with bookings in a month; a layout tuned to a full
// legend leaves a two-slice donut looking broken. The Phase 1 Donut's smoke
// check pins 1, 2 and 8 for exactly this reason.
//
// "הפילוח המלא" opens a DRAWER, not a route — decided. The breakdown is a lens
// on the dashboard's own period, not a place you navigate to and come back from.
// ============================================================

const TOP_N = 5;

export function SourcesWindow({ breakdown }: { breakdown: SourcesBreakdown }) {
  const [open, setOpen] = useState(false);

  if (breakdown.rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין הזמנות בחודש הנוכחי</span>
      </div>
    );
  }

  const slices = breakdown.rows.map((r) => ({
    id: r.sourceId,
    value: r.guests,
    color: r.color,
    label: r.label,
  }));
  const top = breakdown.rows.slice(0, TOP_N);

  return (
    <>
      <div className="src">
        <Donut
          slices={slices}
          size={150}
          centerValue={String(breakdown.totals.guests)}
          centerUnit="אורחים"
          label="פילוח מקורות הזמנה"
        />
        <ul className="src-legend">
          {top.map((r) => (
            <li key={r.sourceId} className="src-legend-row">
              <span className="src-dot" style={{ background: r.color }} aria-hidden />
              <span className="src-label">{r.label}</span>
              <span className="src-n ltr-num">{r.guests}</span>
              <span className="src-pct ltr-num">{r.sharePct}%</span>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="btn btn-sm btn-secondary src-more" onClick={() => setOpen(true)}>
        הפילוח המלא
      </button>
      {open && <SourcesDrawer initial={breakdown} onClose={() => setOpen(false)} />}
    </>
  );
}
