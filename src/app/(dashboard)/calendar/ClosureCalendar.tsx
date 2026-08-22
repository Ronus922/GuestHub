"use client";

import { Icon } from "@/components/shared/Icon";
import {
  HEBREW_DAY_LETTERS,
  formatDayMonth,
  hebrewMonthYear,
  type DateOnly,
} from "@/lib/dates";
import { firstOfMonth, monthCells, shiftMonth } from "@/lib/date-range";
import {
  nightState,
  presetRange,
  type NightOwner,
  type OccupancyWindow,
} from "@/lib/closures/occupancy";

// ============================================================
// THE closure calendar (owner reference "סגירת חדר זמנית" §3) — two months
// side by side, the room's taken nights in red and NOT clickable, past days
// dimmed, a range picked in two clicks, and a legend that names every colour.
//
// It is not <DateRangeField>. That one is a trigger plus a popover over a
// range with no third party in it; this one is always open, it is the panel's
// main surface, and its whole point is the OCCUPANCY painted underneath the
// range. What the two DO share is the pure layer — monthCells / shiftMonth /
// HEBREW_DAY_LETTERS — so neither reimplements a Hebrew month.
//
// The two months live in a `flex-wrap` row with a container query, exactly like
// the stay picker: when the panel is too narrow for the pair, the second month
// wraps BELOW instead of shrinking the cells. The 44px cell (iron rule #6) is
// the invariant; the month count is what gives.
// ============================================================

const PRESETS: { label: string; span: number | "month" }[] = [
  { label: "לילה אחד", span: 1 },
  { label: "3 לילות", span: 3 },
  { label: "שבוע", span: 7 },
  { label: "עד סוף החודש", span: "month" },
];

export function ClosureCalendar({
  view,
  onView,
  today,
  start,
  lastNight,
  occupied,
  occWindow,
  onPick,
  onPreset,
}: {
  view: { year: number; month: number };
  onView: (v: { year: number; month: number }) => void;
  today: DateOnly;
  start: DateOnly | "";
  lastNight: DateOnly | "";
  occupied: ReadonlyMap<DateOnly, NightOwner>;
  occWindow: OccupancyWindow;
  onPick: (d: DateOnly) => void;
  onPreset: (span: number | "month") => void;
}) {
  const activePreset = (span: number | "month") => {
    if (!start || !lastNight) return false;
    const p = presetRange(today, span);
    return p.start === start && p.lastNight === lastNight;
  };

  return (
    <section className="card cp-cal">
      <header className="cp-cal-hd">
        <span className="field-label">לילות סגורים</span>
        <button
          type="button"
          className="icon-btn cp-nav"
          aria-label="חודש קודם"
          onClick={() => onView(shiftMonth(view, -1))}
        >
          <Icon name="chevron-right" size={20} />
        </button>
        <button
          type="button"
          className="icon-btn cp-nav"
          aria-label="חודש הבא"
          onClick={() => onView(shiftMonth(view, 1))}
        >
          <Icon name="chevron-left" size={20} />
        </button>
      </header>

      <div className="cp-months">
        <Month
          view={view}
          today={today}
          start={start}
          lastNight={lastNight}
          occupied={occupied}
          occWindow={occWindow}
          onPick={onPick}
        />
        <span className="cp-sep" />
        <div className="cp-m2">
          <Month
            view={shiftMonth(view, 1)}
            today={today}
            start={start}
            lastNight={lastNight}
            occupied={occupied}
            occWindow={occWindow}
            onPick={onPick}
          />
        </div>
      </div>

      <footer className="cp-cal-ft">
        <div className="cp-presets">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`cp-chip${activePreset(p.span) ? " on" : ""}`}
              onClick={() => onPreset(p.span)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="cp-legend">
          <span className="cp-leg">
            <span className="cp-leg-sw cp-leg-sel" />
            סגור
          </span>
          <span className="cp-leg">
            <span className="cp-leg-sw cp-leg-busy" />
            תפוס
          </span>
          <span className="cp-leg">
            <span className="cp-leg-sw cp-leg-today" />
            היום
          </span>
        </div>
      </footer>
    </section>
  );
}

function Month({
  view,
  today,
  start,
  lastNight,
  occupied,
  occWindow,
  onPick,
}: {
  view: { year: number; month: number };
  today: DateOnly;
  start: DateOnly | "";
  lastNight: DateOnly | "";
  occupied: ReadonlyMap<DateOnly, NightOwner>;
  occWindow: OccupancyWindow;
  onPick: (d: DateOnly) => void;
}) {
  return (
    <div className="cp-month">
      <p className="cp-mt">{hebrewMonthYear(firstOfMonth(view))}</p>
      <div className="cp-grid">
        {HEBREW_DAY_LETTERS.map((l) => (
          <span key={l} className="cp-wd">
            {l.slice(0, 1)}
          </span>
        ))}
        {monthCells(view.year, view.month).map((d, i) => {
          if (d === null) return <span key={`e${i}`} />;
          const state = nightState(d, occupied, occWindow);
          const owner = occupied.get(d);
          const inRange = Boolean(start && lastNight && d >= start && d <= lastNight);
          const edge = d === start || d === lastNight;
          // A taken night is not a target. Past days are not either: a closure
          // that starts before today cannot be filed, and the reference dims
          // them rather than hiding them so the month still reads as a month.
          const disabled = state === "blocked" || d < today;
          const cls = [
            "cp-day",
            state === "blocked" ? "busy" : "",
            state === "unknown" && !inRange ? "unk" : "",
            d < today && !inRange ? "past" : "",
            inRange ? (edge ? "edge" : "mid") : "",
            d === today && !inRange ? "today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={d}
              type="button"
              className={cls}
              disabled={disabled}
              title={
                owner
                  ? owner.kind === "stay"
                    ? `הזמנה: ${owner.label}`
                    : owner.label
                  : state === "unknown"
                    ? "מחוץ לחלון היומן הטעון — ייבדק בשמירה"
                    : formatDayMonth(d)
              }
              onClick={() => onPick(d)}
            >
              <span className="ltr-num">{Number(d.slice(8, 10))}</span>
              {owner ? <span className="cp-dot" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
