import type { ReactNode } from "react";
import { HEBREW_DAY_LETTERS, type DateOnly } from "@/lib/dates";
import type { DayCell, MonthModel } from "@/lib/date-range-picker";

// One month, shared by the popover and the sheet. The range band is painted on
// the CELL (.drp-cell), not on the day button — 44px cells, 7 × 1fr, no
// horizontal gap, or the band breaks.

export function WeekdayRow({ className }: { className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {HEBREW_DAY_LETTERS.map((l) => (
        <span key={l}>{l.slice(0, 1)}</span>
      ))}
    </div>
  );
}

const cellClass = (c: DayCell) =>
  `drp-cell${c.band ? ` ${c.band.split(" ").map((b) => `drp-${b}`).join(" ")}` : ""}${c.occupied ? " drp-occ" : ""}`;

export function MonthGrid({
  month,
  className,
  header,
  showWeekdays = false,
  tabDate,
  titleId,
  onPick,
  onHover,
  onFocusDay,
}: {
  month: MonthModel;
  className: string;
  header?: ReactNode;
  /** desktop: the weekday row sits in each month; the sheet pins one above the scroller */
  showWeekdays?: boolean;
  /** the day with tabIndex=0 (roving tabindex) */
  tabDate: DateOnly | null;
  titleId: string;
  onPick: (d: DateOnly) => void;
  /** desktop only: hovering previews the check-out */
  onHover?: (d: DateOnly) => void;
  onFocusDay?: (d: DateOnly) => void;
}) {
  const rows: DayCell[][] = [];
  for (let r = 0; r < month.rows; r++) rows.push(month.cells.slice(r * 7, r * 7 + 7));
  return (
    <div className={className}>
      {header}
      {showWeekdays && <WeekdayRow className="drp-wd" />}
      <div className="drp-grid" role="grid" aria-labelledby={titleId}>
        {rows.map((row, ri) => (
          <div className="drp-row" role="row" key={ri}>
            {row.map((c, ci) => (
              <div
                key={ci}
                className={cellClass(c)}
                role="gridcell"
                aria-selected={c.date ? c.state === "sel" : undefined}
              >
                {c.date && (
                  <button
                    type="button"
                    className={`drp-d${c.state ? ` drp-${c.state}` : ""}${c.occupied ? " drp-occ" : ""}`}
                    data-date={c.date}
                    tabIndex={c.date === tabDate ? 0 : -1}
                    aria-label={c.label}
                    aria-disabled={c.disabled || undefined}
                    aria-current={c.state === "today" ? "date" : undefined}
                    onClick={() => !c.disabled && onPick(c.date as DateOnly)}
                    onMouseEnter={onHover ? () => onHover(c.date as DateOnly) : undefined}
                    onFocus={onFocusDay ? () => onFocusDay(c.date as DateOnly) : undefined}
                  >
                    <span className="ltr-num">{c.day}</span>
                    {/* the closure calendar's own dot (.cp-dot) — the taken
                        night stays readable under a picked edge */}
                    {c.occupied && <span className="cp-dot" />}
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** the day button for a date inside a container */
export function dayButton(root: HTMLElement | null, d: DateOnly | null): HTMLButtonElement | null {
  if (!root || !d) return null;
  return root.querySelector<HTMLButtonElement>(`.drp-d[data-date="${d}"]`);
}

/** the roving-tabindex day: the first candidate on screen, else the first day shown */
export function pickTabDate(months: MonthModel[], candidates: (DateOnly | null)[]): DateOnly | null {
  const shown = new Set<string>();
  for (const m of months) for (const c of m.cells) if (c.date) shown.add(c.date);
  for (const c of candidates) if (c && shown.has(c)) return c;
  for (const m of months) for (const c of m.cells) if (c.date) return c.date;
  return null;
}
