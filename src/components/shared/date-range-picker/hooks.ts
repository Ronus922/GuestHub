import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { DateOnly } from "@/lib/dates";
import { firstOfMonth, shiftMonth } from "@/lib/date-range";
import type { MonthView } from "@/lib/date-range-picker";

/** the months a surface shows, as [first day, first day after) */
export type MonthsWindow = { from: DateOnly; to: DateOnly };
/** `opened` is true on the first call after the picker opened */
export type MonthsShown = (window: MonthsWindow, opened: boolean) => void;

/**
 * Tells the owner which months are on screen — on mount (= the picker opened)
 * and on every change — so it can load what to paint for them. The callback is
 * read through a ref: a new function each render must not re-fire it.
 */
export function useMonthsShown(first: MonthView, count: number, onShown?: MonthsShown): void {
  const cb = useRef(onShown);
  cb.current = onShown;
  const opened = useRef(true);
  const from = firstOfMonth(first);
  const to = firstOfMonth(shiftMonth(first, count));
  useEffect(() => {
    cb.current?.({ from, to }, opened.current);
    opened.current = false;
  }, [from, to]);
}

/** desktop vs mobile by the WINDOW width (matchMedia), not by the container */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getAttribute("aria-hidden") !== "true",
  );
}

/** body locked while the sheet is open */
export function useBodyScrollLock(): void {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
}
