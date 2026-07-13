"use client";

import { useEffect, useState } from "react";
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

// The ONE stay date-range picker (DatePicker reference): a trigger that reads
// the applied range, and an in-flow panel with two months, a nights summary and
// החל / ביטול. In-flow (not floating) because the panels it lives in scroll —
// an absolutely-positioned popover would be clipped by .dw-bd.

const hebDay = (d: DateOnly) =>
  `${Number(d.slice(8, 10))} ב${HEBREW_MONTHS[Number(d.slice(5, 7)) - 1]}`;

export function DateRangeField({
  checkIn,
  checkOut,
  disabled = false,
  onApply,
}: {
  checkIn: string;
  checkOut: string;
  disabled?: boolean;
  onApply: (checkIn: DateOnly, checkOut: DateOnly) => void;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DraftRange>({
    start: checkIn || null,
    end: checkOut || null,
  });
  // null until first open: the month in view depends on the client clock, and a
  // value rendered on the server would hydrate differently (D71).
  const [view, setView] = useState<{ year: number; month: number } | null>(null);

  // the applied dates are the source of truth — an external change (a calendar
  // drag, a reloaded reservation) re-seeds the draft.
  useEffect(() => {
    setRange({ start: checkIn || null, end: checkOut || null });
  }, [checkIn, checkOut]);

  const applied = checkIn && checkOut;
  const draftNights =
    range.start && range.end ? nightsBetween(range.start, range.end) : 0;

  const toggle = () => {
    if (!open) {
      const now = new Date();
      setView(
        range.start
          ? monthOf(range.start)
          : { year: now.getFullYear(), month: now.getMonth() },
      );
    }
    setOpen(!open);
  };

  const apply = () => {
    if (!range.start || !range.end) return;
    onApply(range.start, range.end);
    setOpen(false);
  };

  const cancel = () => {
    setRange({ start: checkIn || null, end: checkOut || null });
    setOpen(false);
  };

  return (
    <>
      <div className="field dp-cell">
        <span className="field-label">
          תאריכי שהות <span className="bw-req">*</span>
        </span>
        <button
          type="button"
          className="field-input dp-trigger"
          disabled={disabled}
          aria-expanded={open}
          onClick={toggle}
        >
          <Icon name="calendar" size={20} className="text-primary" />
          <span className="dp-trigger-v ltr-num">
            {applied
              ? `${hebDay(checkIn)} – ${hebDay(checkOut)} ${checkOut.slice(0, 4)}`
              : "בחירת תאריכים"}
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
            <Month view={view} range={range} onPick={(d) => setRange(pickRange(range, d))} />
            <span className="dp-sep" />
            <div className="dp-m2">
              <Month
                view={shiftMonth(view, 1)}
                range={range}
                onPick={(d) => setRange(pickRange(range, d))}
              />
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

          <div className="dp-ft">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!range.start || !range.end}
              onClick={apply}
            >
              החל
            </button>
            <button type="button" className="btn btn-tertiary" onClick={cancel}>
              ביטול
            </button>
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
}: {
  view: { year: number; month: number };
  range: DraftRange;
  onPick: (d: DateOnly) => void;
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
