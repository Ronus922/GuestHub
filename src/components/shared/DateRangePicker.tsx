"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { type DateOnly, todayInTz } from "@/lib/dates";
import { type DraftRange, monthOf } from "@/lib/date-range";
import {
  type DismissKind,
  type MonthView,
  type RangeRules,
  canDecNights,
  canIncNights,
  dismissRestores,
  formatRangeText,
  nightsOf,
  pickDay,
  setNightsRange,
} from "@/lib/date-range-picker";
import { DesktopPopover } from "./date-range-picker/DesktopPopover";
import { MobileSheet } from "./date-range-picker/MobileSheet";
import { NightsStepper } from "./date-range-picker/NightsStepper";
import { focusablesIn, useMediaQuery } from "./date-range-picker/hooks";

// The stay date-range picker of the booking windows (the datePicker skill,
// ported onto the repo's date model and tokens). A trigger row (field + nights
// stepper) that never reserves height; the months float in a portal — a
// popover on desktop, a bottom sheet under 768px (decided by the WINDOW width,
// so a narrow drawer on desktop still gets the popover).
//
// WRITE-THROUGH: a COMPLETE range reaches the form the moment it is picked
// (`write`). A half range (check-in only) lives in this component's draft and
// never reaches the form. Esc / ביטול / X restore the dates the picker opened
// on; every other close ("סגור", outside click, the sheet's backdrop) keeps what
// was written — dismissRestores() (owner decisions 1 + C).
// check_out is EXCLUSIVE (D32) — `to` is the departure day.

export const MOBILE_QUERY = "(max-width: 767px)";
const PLACEHOLDER = "בחרו תאריכים";

const seed = (from: string, to: string): DraftRange => ({ start: from || null, end: to || null });

export function DateRangePicker({
  from,
  to,
  min,
  max,
  maxNights,
  disabled = false,
  invalid = false,
  onChange,
}: {
  from: string;
  to: string;
  min?: DateOnly;
  max?: DateOnly;
  /** stepper ceiling — a typo guard, not a business rule */
  maxNights?: number;
  disabled?: boolean;
  /** red trigger when a required range is missing (form validation) */
  invalid?: boolean;
  /** called ONLY with a complete range */
  onChange: (from: DateOnly, to: DateOnly) => void;
}) {
  const rules: RangeRules = { min, max, maxNights };
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const sheet = isMobile;
  const dialogId = `drp-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const [draft, setDraft] = useState<DraftRange>(() => seed(from, to));
  const [open, setOpen] = useState(false);
  // null until opened: today and the month in view depend on the client clock,
  // and a value rendered on the server would hydrate differently (D71).
  const [today, setToday] = useState<DateOnly | null>(null);
  const [view, setView] = useState<MonthView | null>(null);
  const baseRef = useRef<DraftRange>(draft);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // the form's dates are the source of truth — an external change (a reloaded
  // reservation, a calendar drag that opens the editor) re-seeds the draft.
  useEffect(() => {
    setDraft(seed(from, to));
  }, [from, to]);

  const write = (next: DraftRange) => {
    setDraft(next);
    if (next.start && next.end) onChange(next.start, next.end);
  };

  const focusTrigger = () => triggerRef.current?.focus({ preventScroll: true });

  const openPicker = () => {
    const now = todayInTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
    baseRef.current = draft;
    setToday(now);
    setView(monthOf(draft.start ?? (min && min > now ? min : now)));
    setOpen(true);
  };

  /** every way the picker closes goes through here (owner decision 1) */
  const dismiss = (kind: DismissKind, restoreFocus: boolean) => {
    if (dismissRestores(kind, draft)) {
      const base = baseRef.current;
      // a base without a check-out was never in the form — show the form's dates
      if (base.start && base.end) write(base);
      else setDraft(seed(from, to));
    }
    setOpen(false);
    if (restoreFocus) focusTrigger();
  };

  const setNights = (n: number) => {
    write(setNightsRange(draft, n, rules));
    if (draft.start && view) setView(monthOf(draft.start));
  };

  // Keyboard while open, in the CAPTURE phase with stopPropagation — the same
  // stacking rule as MobileDetailSheet: the picker is the innermost surface, so
  // one Esc must not also close the drawer behind it (SidePanel listens on the
  // document), and Tab must cycle inside the picker, not jump into the drawer.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // the nights field answers its own Esc (restores the typed value)
        if (e.target instanceof Element && e.target.closest(".drp-step-in")) return;
        e.stopPropagation();
        e.preventDefault();
        dismissRef.current("cancel", true);
        return;
      }
      if (e.key !== "Tab") return;
      const roots = [sheet ? null : rootRef.current, layerRef.current].filter(
        (r): r is HTMLDivElement => r !== null,
      );
      const active = document.activeElement;
      if (!roots.some((r) => r.contains(active))) return;
      const items = roots.flatMap(focusablesIn);
      if (items.length === 0) return;
      e.stopPropagation();
      e.preventDefault();
      const i = items.indexOf(active as HTMLElement);
      const next = e.shiftKey ? items[(i - 1 + items.length) % items.length] : items[(i + 1) % items.length];
      next.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, sheet]);

  const hasEnd = draft.start != null && draft.end != null;
  const sel: PickerSelection = {
    range: draft,
    nights: nightsOf(draft),
    rules,
    canCommit: hasEnd,
    canDec: !disabled && canDecNights(draft),
    canInc: !disabled && canIncNights(draft, rules),
    pick: (d: DateOnly) => write(pickDay(draft, d, rules)),
    setNights,
  };

  return (
    <div ref={rootRef} className="drp-top">
      <button
        ref={triggerRef}
        type="button"
        className={`field-input drp-field${open ? " drp-on" : ""}${invalid ? " field-error" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => (open ? dismiss("outside", true) : openPicker())}
      >
        <Icon name="calendar" size={20} className="text-primary" />
        <span className="drp-field-text">{formatRangeText(draft, PLACEHOLDER)}</span>
        {!sheet && <Icon name={open ? "chevron-up" : "chevron"} size={20} className="drp-chev" />}
      </button>

      {!sheet && (
        <div className="drp-stepw">
          <NightsStepper
            nights={sel.nights}
            hasRange={hasEnd}
            hasStart={draft.start != null && !disabled}
            canDec={sel.canDec}
            canInc={sel.canInc}
            onSetNights={setNights}
          />
          <span className="drp-hint">שינוי מזיז את תאריך היציאה</span>
        </div>
      )}

      {open && today && view && sheet && (
        <MobileSheet
          layerRef={layerRef}
          id={dialogId}
          sel={sel}
          today={today}
          anchor={view}
          onCancel={() => dismiss("cancel", true)}
          onCommit={() => dismiss("close", true)}
          onOutside={() => dismiss("outside", true)}
        />
      )}
      {open && today && view && !sheet && (
        <DesktopPopover
          layerRef={layerRef}
          id={dialogId}
          anchorRef={triggerRef}
          rootRef={rootRef}
          sel={sel}
          view={view}
          onViewChange={setView}
          today={today}
          placeholder={PLACEHOLDER}
          onCancel={() => dismiss("cancel", true)}
          onCommit={() => dismiss("close", true)}
          onOutside={() => dismiss("outside", false)}
        />
      )}
    </div>
  );
}

export type PickerSelection = {
  range: DraftRange;
  nights: number;
  rules: RangeRules;
  canCommit: boolean;
  canDec: boolean;
  canInc: boolean;
  pick: (d: DateOnly) => void;
  setNights: (n: number) => void;
};
