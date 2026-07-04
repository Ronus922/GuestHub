"use client";

// Segmented control — DESIGN_SYSTEM Tabs "Variation 3": track bg #f4f2fc, active tab
// white + primary text + shadow. Controlled.
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
    <div className="inline-flex flex-wrap rounded-xl bg-[#f4f2fc] p-1" role="tablist">
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={`min-h-11 rounded-lg px-4 py-1.5 text-sm transition-colors ${
              active
                ? "bg-white font-semibold text-primary shadow-sm"
                : "font-medium text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
