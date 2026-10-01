import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/Icon";
import { parseNights } from "@/lib/date-range-picker";

// [−] N [+] in LTR. N is a typed field: the operator knows the length of stay
// and should not have to click to it. The draft commits on Enter or blur — not
// per keystroke, which would clamp "1" out of "12" and fire a rooms+quote
// round-trip per character. After Enter the text is re-selected so the next
// digits replace it; Esc restores the value and does NOT close the picker;
// ↑/↓ = ±1. Empty / 0 / not a number → the previous value. Read-only (—)
// without a check-in; the buttons rest until there is a full range.

export function NightsStepper({
  nights,
  hasRange,
  hasStart,
  canDec,
  canInc,
  onSetNights,
  variant = "field",
}: {
  nights: number;
  hasRange: boolean;
  /** a check-in exists (and the picker is enabled): the field takes typing */
  hasStart: boolean;
  canDec: boolean;
  canInc: boolean;
  /** end = start + n — exactly what [+]/[−] do */
  onSetNights: (n: number) => void;
  variant?: "field" | "sheet";
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectAfterCommit = useRef(false);
  const shown = draft ?? (hasRange ? String(nights) : "—");

  useEffect(() => {
    if (!selectAfterCommit.current) return;
    selectAfterCommit.current = false;
    const el = inputRef.current;
    if (el && document.activeElement === el) el.select();
  });

  // Esc is handled NATIVELY on the input: it must stop before it reaches the
  // document, where the drawer (SidePanel) would take it as "close the window".
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setDraft(null);
      el.select();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  const commit = () => {
    if (draft === null) return;
    const n = parseNights(draft);
    setDraft(null);
    if (n !== null && n !== nights) onSetNights(n);
  };

  return (
    <div className={`drp-step${variant === "sheet" ? " drp-step-sheet" : ""}`} role="group" aria-label="מספר לילות">
      <button
        type="button"
        className="drp-step-btn"
        onClick={() => onSetNights(nights - 1)}
        disabled={!canDec}
        aria-label="פחות לילה"
      >
        <Icon name="minus" size={20} />
      </button>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        className="drp-step-v drp-step-in ltr-num"
        value={shown}
        readOnly={!hasStart}
        aria-label="מספר לילות"
        dir="ltr"
        style={{ width: `${Math.max(shown.length, 1) + 1}ch` }}
        onFocus={(e) => {
          if (!hasStart) return;
          setDraft(hasRange ? String(nights) : "");
          e.currentTarget.select();
        }}
        onChange={(e) => hasStart && setDraft(e.target.value.replace(/\D/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (!hasStart) return;
          if (e.key === "Enter") {
            e.preventDefault(); // never submits the host form
            selectAfterCommit.current = true;
            commit();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const current = parseNights(draft ?? "") ?? (hasRange ? nights : 0);
            setDraft(null);
            onSetNights(Math.max(1, current + (e.key === "ArrowUp" ? 1 : -1)));
          }
        }}
      />
      <button
        type="button"
        className="drp-step-btn"
        onClick={() => onSetNights(nights + 1)}
        disabled={!canInc}
        aria-label="עוד לילה"
      >
        <Icon name="plus" size={20} />
      </button>
    </div>
  );
}
