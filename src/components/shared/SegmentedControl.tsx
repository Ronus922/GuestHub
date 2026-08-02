"use client";

// ============================================================
// <SegmentedControl> — the track-style selector (audit §B.2).
//
// Four instances across two coming screens: the guest inbox's
// ממתינות/הכול/טופלו filter and its channel picker, and the sources screen's
// period and metric switches. The two references already disagree on its height
// (32px in GuestMessages, 34px in InvitationSources) — which is the whole
// argument for one component. Both are off-system; it snaps to `.btn-sm`
// (36px), the app's only small control height (GUIDELINES §4).
//
// Keyboard: it is a radiogroup, so ←/→ move the selection rather than the
// focus, which is what a segmented control is for.
// ============================================================
import { Icon, type IconName } from "./Icon";

export type Segment<T extends string> = {
  value: T;
  label: string;
  icon?: IconName;
};

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  grow,
}: {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (next: T) => void;
  /** accessible name for the group */
  label: string;
  /** segments share the width equally instead of hugging their labels */
  grow?: boolean;
}) {
  const move = (delta: number) => {
    const i = segments.findIndex((s) => s.value === value);
    if (i < 0) return;
    const next = segments[(i + delta + segments.length) % segments.length];
    onChange(next.value);
  };

  return (
    <div
      className={`seg${grow ? " seg-grow" : ""}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {segments.map((s) => {
        const on = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`seg-btn${on ? " on" : ""}`}
            onClick={() => onChange(s.value)}
          >
            {s.icon && <Icon name={s.icon} size={17} />}
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
