import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/shared/Icon";
import { type DateOnly, formatFullDate } from "@/lib/dates";
import { monthOf, shiftMonth } from "@/lib/date-range";
import {
  type MonthView,
  type PopoverPosition,
  buildMonths,
  computePopoverPosition,
  effectiveEnd,
  formatRangeText,
  keyboardStep,
  monthKey,
  nightsTitle,
} from "@/lib/date-range-picker";
import type { PickerSelection } from "../DateRangePicker";
import { MonthGrid, dayButton, pickTabDate } from "./MonthGrid";
import { useMonthsShown } from "./hooks";

// Desktop (≥768px window): a popover in a portal on <body>, position:fixed from
// the trigger's rect — it floats over the drawer and never pushes the form.
// Re-placed on every scroll (capture, so the drawer body .dw-bd counts) and on
// resize. Header summary → two months side by side → footer.

export function DesktopPopover({
  layerRef: popRef,
  id,
  anchorRef,
  rootRef,
  sel,
  view,
  onViewChange,
  today,
  placeholder,
  onCancel,
  onCommit,
  onOutside,
}: {
  /** the popover element — the parent's focus trap reads it */
  layerRef: RefObject<HTMLDivElement | null>;
  id: string;
  /** the date field — the anchor */
  anchorRef: RefObject<HTMLElement | null>;
  /** the trigger row (field + stepper): a press inside it is not "outside" */
  rootRef: RefObject<HTMLElement | null>;
  sel: PickerSelection;
  /** the right-hand month */
  view: MonthView;
  onViewChange: (v: MonthView) => void;
  today: DateOnly;
  placeholder: string;
  onCancel: () => void;
  onCommit: () => void;
  onOutside: () => void;
}) {
  const calRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const [hover, setHover] = useState<DateOnly | null>(null);
  const [focusDate, setFocusDate] = useState<DateOnly | null>(sel.range.start);
  const pendingFocus = useRef<DateOnly | null>(null);
  const { range } = sel;

  const effEnd = effectiveEnd(range, hover);
  const months = buildMonths([view, shiftMonth(view, 1)], true, {
    range, effEnd, today, rules: sel.rules, occupied: sel.occupied,
  });
  useMonthsShown(view, 2, sel.onMonthsShown);
  const tabDate = pickTabDate(months, [focusDate, range.start, today]);

  // ---- placement ----
  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const field = anchor.getBoundingClientRect();
    // width and bottom edge from the whole trigger row (field + stepper + hint),
    // alignment from the field's right edge — the popover never covers the hint
    const row = rootRef.current?.getBoundingClientRect() ?? field;
    const rect = {
      top: field.top,
      bottom: Math.max(field.bottom, row.bottom),
      right: field.right,
      width: Math.max(field.width, row.width),
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // width first, so the height is measured after wrapping
    pop.style.width = `${computePopoverPosition(rect, 0, vw, vh).width}px`;
    const next = computePopoverPosition(rect, pop.offsetHeight, vw, vh);
    setPos((p) => (p && p.top === next.top && p.left === next.left && p.width === next.width ? p : next));
  }, [anchorRef, rootRef, popRef]);

  useLayoutEffect(() => {
    place();
  });

  useEffect(() => {
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);

  // ---- a press outside: keep a complete range, drop a half one (decision 1) ----
  const outsideRef = useRef(onOutside);
  outsideRef.current = onOutside;
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || popRef.current?.contains(t) || rootRef.current?.contains(t)) return;
      outsideRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [rootRef, popRef]);

  // ---- focus: into the check-in day (or the roving day) on open ----
  useEffect(() => {
    const root = popRef.current;
    (dayButton(root, range.start) ?? dayButton(root, tabDate) ?? root)?.focus({ preventScroll: true });
    // once, on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const d = pendingFocus.current;
    if (!d) return;
    const el = dayButton(calRef.current, d);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  const onCalKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = (e.target as HTMLElement).dataset?.date;
    if (!current) return;
    const next = keyboardStep(e.key, current);
    if (!next) return;
    e.preventDefault();
    const nm = monthOf(next);
    if (monthKey(nm) < monthKey(view)) onViewChange(nm);
    else if (monthKey(nm) > monthKey(shiftMonth(view, 1))) onViewChange(shiftMonth(nm, -1));
    setFocusDate(next);
    pendingFocus.current = next;
  };

  const hasEnd = range.start != null && range.end != null;
  const titleId = `${id}-title`;

  return createPortal(
    <div
      ref={popRef}
      id={id}
      className="drp-pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      dir="rtl"
      style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: 0, left: 0, visibility: "hidden" }}
    >
      <div className="drp-pop-h">
        <span className="drp-moon">
          <Icon name="moon" size={24} />
        </span>
        <div>
          <div className="drp-sum-t" id={titleId}>
            {nightsTitle(range)}
          </div>
          <div className="drp-sum-s">{formatRangeText(range, placeholder)}</div>
        </div>
        <div className="drp-ft">
          <div className="drp-ft-col">
            <span className="drp-ft-l">מתאריך</span>
            <span className="drp-ft-v ltr-num">{range.start ? formatFullDate(range.start) : "—"}</span>
          </div>
          <span className="drp-ft-chip">
            <Icon name="moon" size={17} />
            <span className="ltr-num">{hasEnd ? sel.nights : "—"}</span>
          </span>
          <div className="drp-ft-col">
            <span className="drp-ft-l">עד תאריך</span>
            <span className={`drp-ft-v ltr-num${hasEnd ? "" : " drp-dim"}`}>
              {range.end ? formatFullDate(range.end) : "—"}
            </span>
          </div>
        </div>
      </div>

      <div ref={calRef} className="drp-cal" onMouseLeave={() => setHover(null)} onKeyDown={onCalKeyDown}>
        {months.map((m, i) => {
          const monthTitleId = `${id}-m${i}`;
          return (
            <MonthGrid
              key={`${m.year}-${m.month}`}
              month={m}
              className="drp-mo"
              showWeekdays
              tabDate={tabDate}
              titleId={monthTitleId}
              onPick={(d) => {
                setHover(null);
                sel.pick(d);
              }}
              onHover={(d) => range.start && !range.end && setHover(d)}
              onFocusDay={(d) => {
                setFocusDate(d);
                if (range.start && !range.end) setHover(d);
              }}
              header={
                <div className="drp-mo-h">
                  {i === 0 ? (
                    <button
                      type="button"
                      className="drp-nav-b"
                      onClick={() => onViewChange(shiftMonth(view, -1))}
                      aria-label="חודש קודם"
                    >
                      <Icon name="chevron-right" size={20} />
                    </button>
                  ) : (
                    <span className="drp-nav-sp" />
                  )}
                  <span className="drp-mo-t" id={monthTitleId}>
                    {m.title}
                  </span>
                  {i === months.length - 1 ? (
                    <button
                      type="button"
                      className="drp-nav-b"
                      onClick={() => onViewChange(shiftMonth(view, 1))}
                      aria-label="חודש הבא"
                    >
                      <Icon name="chevron-left" size={20} />
                    </button>
                  ) : (
                    <span className="drp-nav-sp" />
                  )}
                </div>
              }
            />
          );
        })}
      </div>

      <div className="drp-foot">
        <span className="drp-foot-h" aria-live="polite">
          {hasEnd
            ? "התאריכים עודכנו בטופס — לשמירה לחצו שמור שינויים"
            : "לחצו על תאריך היציאה כדי לסיים את הבחירה"}
        </span>
        <button type="button" className="drp-btn-t" onClick={onCancel}>
          ביטול
        </button>
        <button type="button" className="drp-btn" onClick={onCommit} disabled={!sel.canCommit}>
          סגור
        </button>
      </div>
    </div>,
    document.body,
  );
}
