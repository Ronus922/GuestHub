import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/shared/Icon";
import { type DateOnly, formatFullDate } from "@/lib/dates";
import { monthOf, shiftMonth } from "@/lib/date-range";
import { type MonthView, buildMonths, keyboardStep, monthKey, nightsTitle } from "@/lib/date-range-picker";
import type { PickerSelection } from "../DateRangePicker";
import { MonthGrid, WeekdayRow, dayButton, pickTabDate } from "./MonthGrid";
import { NightsStepper } from "./NightsStepper";
import { useBodyScrollLock } from "./hooks";

// Mobile (<768px window): a bottom sheet 48px off the top — handle → title + X
// → summary row with the nights stepper → pinned weekday row → months scrolling
// from the check-in month, "חודשים נוספים" (+3) → pinned footer. No hover, no
// month arrows. Backdrop / X / ביטול / Esc / dragging the handle down = cancel.

const DRAG_DISMISS_PX = 80;

export function MobileSheet({
  layerRef,
  id,
  sel,
  today,
  anchor,
  onCancel,
  onCommit,
}: {
  /** the sheet element — the parent's focus trap reads it */
  layerRef: RefObject<HTMLDivElement | null>;
  id: string;
  sel: PickerSelection;
  today: DateOnly;
  /** the first month listed (the check-in month at open) */
  anchor: MonthView;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(3);
  const [focusDate, setFocusDate] = useState<DateOnly | null>(sel.range.start);
  const pendingFocus = useRef<DateOnly | null>(null);
  const touchStartY = useRef<number | null>(null);
  const { range } = sel;

  useBodyScrollLock();
  // focus enters the sheet itself (not a day) — no ring, no scroll jump on tap
  useEffect(() => {
    layerRef.current?.focus({ preventScroll: true });
  }, [layerRef]);

  const views = Array.from({ length: count }, (_, i) => shiftMonth(anchor, i));
  const months = buildMonths(views, false, { range, effEnd: range.end, today, rules: sel.rules });
  const tabDate = pickTabDate(months, [focusDate, range.start, today]);

  useEffect(() => {
    const d = pendingFocus.current;
    if (!d) return;
    const el = dayButton(bodyRef.current, d);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  const onBodyKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = (e.target as HTMLElement).dataset?.date;
    if (!current) return;
    const next = keyboardStep(e.key, current);
    if (!next) return;
    e.preventDefault();
    if (monthKey(monthOf(next)) < monthKey(anchor)) return;
    if (monthKey(monthOf(next)) > monthKey(views[views.length - 1])) setCount((c) => c + 3);
    setFocusDate(next);
    pendingFocus.current = next;
  };

  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    touchStartY.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    const y0 = touchStartY.current;
    if (y0 === null) return;
    if ((e.touches[0]?.clientY ?? y0) - y0 > DRAG_DISMISS_PX) {
      touchStartY.current = null;
      onCancel();
    }
  };
  const onTouchEnd = () => {
    touchStartY.current = null;
  };

  const hasEnd = range.start != null && range.end != null;
  const titleId = `${id}-title`;

  return createPortal(
    <div dir="rtl">
      <div className="drp-backdrop" onClick={onCancel} aria-hidden="true" />
      <div
        ref={layerRef}
        id={id}
        className="drp-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div
          className="drp-sh-head"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div className="drp-grab" />
          <div className="drp-sh-h">
            <div>
              <div className="drp-sh-t" id={titleId}>
                {nightsTitle(range)}
              </div>
              <div className="drp-sum-s">בחירת תאריכי שהייה</div>
            </div>
            <button type="button" className="drp-sh-x" onClick={onCancel} aria-label="סגירה">
              <Icon name="close" size={20} />
            </button>
          </div>
        </div>

        <div className="drp-m-sum">
          <div className="drp-ft-col">
            <span className="drp-ft-l">מתאריך</span>
            <span className="drp-ft-v ltr-num">{range.start ? formatFullDate(range.start) : "—"}</span>
          </div>
          <NightsStepper
            variant="sheet"
            nights={sel.nights}
            hasRange={hasEnd}
            hasStart={range.start != null}
            canDec={sel.canDec}
            canInc={sel.canInc}
            onSetNights={sel.setNights}
          />
          <div className="drp-ft-col drp-ft-end">
            <span className="drp-ft-l">עד תאריך</span>
            <span className={`drp-ft-v ltr-num${hasEnd ? "" : " drp-dim"}`}>
              {range.end ? formatFullDate(range.end) : "—"}
            </span>
          </div>
        </div>

        <WeekdayRow className="drp-m-wd" />

        <div ref={bodyRef} className="drp-m-body" onKeyDown={onBodyKeyDown}>
          {months.map((m, i) => {
            const monthTitleId = `${id}-m${i}`;
            return (
              <MonthGrid
                key={`${m.year}-${m.month}`}
                month={m}
                className="drp-m-mo"
                tabDate={tabDate}
                titleId={monthTitleId}
                onPick={sel.pick}
                onFocusDay={setFocusDate}
                header={
                  <div className="drp-m-mo-t" id={monthTitleId}>
                    {m.title}
                  </div>
                }
              />
            );
          })}
          <button type="button" className="drp-m-more" onClick={() => setCount((c) => c + 3)}>
            <Icon name="chevron" size={20} />
            חודשים נוספים
          </button>
        </div>

        <div className="drp-m-foot">
          <span className="drp-m-foot-h" aria-live="polite">
            {hasEnd ? "התאריכים יעודכנו בטופס" : "הקישו על תאריך היציאה לסיום הבחירה"}
          </span>
          <div className="drp-m-btns">
            <button type="button" className="drp-btn-sec" onClick={onCancel}>
              ביטול
            </button>
            <button type="button" className="drp-btn" onClick={onCommit} disabled={!sel.canCommit}>
              סגור
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
