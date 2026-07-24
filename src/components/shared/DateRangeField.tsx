"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import {
  HEBREW_DAY_LETTERS,
  HEBREW_MONTHS,
  type DateOnly,
  formatFullDate,
  hebrewMonthYear,
  nightsBetween,
} from "@/lib/dates";
import {
  type DraftRange,
  firstOfMonth,
  monthCells,
  monthOf,
  pickRange,
  shiftMonth,
} from "@/lib/date-range";

// The ONE date-range picker (DatePicker reference): a trigger that reads the
// form's dates, and an in-flow panel with the months, a nights summary and
// סגור / ביטול. In-flow (not floating) because the panels it lives in scroll —
// an absolutely-positioned popover would be clipped by .dw-bd.
// A picked range is written to the form IMMEDIATELY (see `pick`): the trigger
// and every derived number always show what a save would actually write.
//
// Two range semantics, one component (mode):
//   "nights" — a stay: `to` is the check-OUT, exclusive (default).
//   "days"   — a rates window: every picked date is a night, `to` is INCLUSIVE,
//              and a single day is a legal range.

const hebDay = (d: DateOnly) =>
  `${Number(d.slice(8, 10))} ב${HEBREW_MONTHS[Number(d.slice(5, 7)) - 1]}`;

export function DateRangeField({
  from,
  to,
  mode = "nights",
  label = "תאריכי שהות",
  required = true,
  min,
  max,
  disabled = false,
  invalid = false,
  onApply,
}: {
  from: string;
  to: string;
  mode?: "nights" | "days";
  label?: string;
  required?: boolean;
  /** writable horizon — days outside [min, max] cannot be picked */
  min?: DateOnly;
  max?: DateOnly;
  disabled?: boolean;
  /** red the trigger when a required range is missing (form validation) */
  invalid?: boolean;
  onApply: (from: DateOnly, to: DateOnly) => void;
}) {
  const days = mode === "days";
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DraftRange>({ start: from || null, end: to || null });
  // null until first open: the month in view depends on the client clock, and a
  // value rendered on the server would hydrate differently (D71).
  const [view, setView] = useState<{ year: number; month: number } | null>(null);

  // the form's dates are the source of truth — an external change (a calendar
  // drag, a reloaded reservation, a preset button) re-seeds the draft.
  useEffect(() => {
    setRange({ start: from || null, end: to || null });
  }, [from, to]);

  const applied = from && to;
  // in "days" mode the end date is itself a night, so it counts
  const draftNights =
    range.start && range.end ? nightsBetween(range.start, range.end) + (days ? 1 : 0) : 0;

  // the dates the panel was opened on — what "ביטול" restores
  const openedRef = useRef<DraftRange>({ start: null, end: null });

  const toggle = () => {
    if (!open) {
      const now = new Date();
      openedRef.current = { start: from || null, end: to || null };
      setView(
        range.start
          ? monthOf(range.start)
          : { year: now.getFullYear(), month: now.getMonth() },
      );
    }
    setOpen(!open);
  };

  // WRITE-THROUGH: a completed range enters the form the moment it is picked.
  // It used to sit in this component as a draft until "החל" was clicked — so an
  // operator who picked dates and went straight to the form's save button saved
  // the OLD dates and saw nothing change. A picker inside a form must never hold
  // a second, invisible commit step.
  const pick = (d: DateOnly) => {
    const next = pickRange(range, d, { allowSameDay: days });
    setRange(next);
    if (next.start && next.end) onApply(next.start, next.end);
  };

  const cancel = () => {
    const opened = openedRef.current;
    setRange(opened);
    if (opened.start && opened.end) onApply(opened.start, opened.end);
    setOpen(false);
  };

  return (
    <>
      <div className="field dp-cell">
        <span className="field-label">
          {label} {required && <span className="bw-req">*</span>}
        </span>
        <button
          type="button"
          className={`field-input dp-trigger${invalid ? " field-error" : ""}`}
          disabled={disabled}
          aria-expanded={open}
          onClick={toggle}
        >
          <Icon name="calendar" size={20} className="text-primary" />
          <span className="dp-trigger-v ltr-num">
            {applied ? `${hebDay(from)} – ${hebDay(to)} ${to.slice(0, 4)}` : "בחירת תאריכים"}
          </span>
          <Icon name="chevron" size={20} className={open ? "dp-rot" : undefined} />
        </button>
      </div>

      {open && view && (
        <div className="dp-panel">
          <div className="dp-hd">
            <div className="dp-hd-sum">
              <span className="dp-moon">
                <Icon name="moon" size={24} />
              </span>
              <div>
                <p className="dp-nights">
                  {range.start && range.end ? `${draftNights} לילות` : "בחירת טווח"}
                </p>
                {range.start && range.end && (
                  <p className="dp-sub ltr-num">
                    {hebDay(range.start)} – {hebDay(range.end)} {range.end.slice(0, 4)}
                  </p>
                )}
              </div>
            </div>

            <div className="dp-box">
              <div>
                <p className="field-label">מתאריך</p>
                <p className="dp-box-v ltr-num">
                  {range.start ? formatFullDate(range.start) : "—"}
                </p>
              </div>
              <span className="dp-badge">
                <Icon name="moon" size={13.5} />
                {draftNights}
              </span>
              <div>
                <p className="field-label">עד תאריך</p>
                <p className="dp-box-v ltr-num">
                  {range.end ? formatFullDate(range.end) : "—"}
                </p>
              </div>
            </div>
          </div>

          <div className="dp-months">
            <button
              type="button"
              aria-label="חודש קודם"
              className="icon-btn"
              onClick={() => setView(shiftMonth(view, -1))}
            >
              <Icon name="chevron-right" size={20} />
            </button>
            <Month view={view} range={range} onPick={pick} min={min} max={max} />
            <span className="dp-sep" />
            <div className="dp-m2">
              <Month view={shiftMonth(view, 1)} range={range} onPick={pick} min={min} max={max} />
            </div>
            <button
              type="button"
              aria-label="חודש הבא"
              className="icon-btn"
              onClick={() => setView(shiftMonth(view, 1))}
            >
              <Icon name="chevron-left" size={20} />
            </button>
          </div>

          {/* The dates are ALREADY in the form (write-through) — this footer only
              closes the panel or restores what it was opened on. No button here
              is the thing that "commits", so none can be missed. */}
          <div className="dp-ft">
            <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
              סגור
            </button>
            <button type="button" className="btn btn-tertiary" onClick={cancel}>
              ביטול
            </button>
            <span className="dp-ft-hint">
              {range.start && !range.end
                ? days
                  ? "בחרו תאריך סיום"
                  : "בחרו תאריך יציאה"
                : days
                  ? "הטווח עודכן — ההחלה מתבצעת בכפתור העדכון של הפאנל"
                  : "התאריכים עודכנו בטופס — לשמירה לחצו שמור שינויים"}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function Month({
  view,
  range,
  onPick,
  min,
  max,
}: {
  view: { year: number; month: number };
  range: DraftRange;
  onPick: (d: DateOnly) => void;
  min?: DateOnly;
  max?: DateOnly;
}) {
  const { start, end } = range;
  return (
    <div className="dp-month">
      <p className="dp-mt">{hebrewMonthYear(firstOfMonth(view))}</p>
      <div className="dp-grid">
        {HEBREW_DAY_LETTERS.map((l) => (
          <span key={l} className="dp-wd">
            {l.slice(0, 1)}
          </span>
        ))}
        {monthCells(view.year, view.month).map((d, i) =>
          d === null ? (
            <span key={`e${i}`} />
          ) : (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              // outside the writable horizon (Group Update: today … today+5y)
              disabled={(min != null && d < min) || (max != null && d > max)}
              className={`dp-day${
                d === start || d === end
                  ? " dp-edge"
                  : start && end && d > start && d < end
                    ? " dp-in"
                    : ""
              }`}
            >
              <span className="ltr-num">{Number(d.slice(8, 10))}</span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}
