"use client";

// Segmented control — THE canonical tabs component (there is no second one).
// Token-only (GUIDELINES §1/§2/§4): the track is the field surface at radius 12
// and renders 44px OVERALL — 36px items inside the 4px-padded track (the
// approved segmented anatomy). The active tab is the white surface with the
// brand text + the ONE card shadow. No invented colour, radius or shadow.
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex flex-wrap rounded-xl bg-field p-1" role="tablist">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={`h-9 rounded-lg px-4 text-[15px] font-bold transition-colors ${
              active
                ? "bg-surface text-primary shadow-card"
                : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
