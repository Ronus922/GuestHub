"use client";

import { useEffect } from "react";
import { Icon } from "@/components/shared/Icon";

// Shared chrome for the settings subsystem. Every piece here CONSUMES a canonical
// primitive from design-system.css (.card / .card-hd / .card-bd / .field /
// .field-label / .icon-btn) — nothing re-declares one. Keeping them in one place
// is what stops each settings screen from inventing its own card and field again
// (iron rule #10).

/** §6 card: 17px/800 header with its section icon, padded body. */
export function SettingsCard({
  icon,
  title,
  action,
  children,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  /** trailing control on the header row (e.g. "הוסף מדיניות") */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-hd">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-050 text-primary">
          <Icon name={icon} size={20} />
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {action}
      </header>
      <div className="card-bd">{children}</div>
    </section>
  );
}

/** §5 field: label ABOVE at 12px/700, 44px control underneath. */
export function Field({
  label,
  required,
  full,
  children,
}: {
  label: string;
  required?: boolean;
  /** span the whole form grid */
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`field${full ? " sm:col-span-2" : ""}`}>
      <span className="field-label">
        {label}
        {required && <span className="text-status-danger"> *</span>}
      </span>
      {children}
    </label>
  );
}

/**
 * the two-column form grid every settings section uses.
 * A real <form>, not a <div>: browsers refuse to treat a password field outside
 * a form as a credential (Chrome logs "Password field is not contained in a
 * form" and its password manager misreads the section). Saving always runs
 * through an explicit type="button" handler, so submission is inert.
 */
export function FormGrid({ children }: { children: React.ReactNode }) {
  return (
    <form
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      onSubmit={(e) => e.preventDefault()}
    >
      {children}
    </form>
  );
}

/** §4 icon-only button: 36×36, radius 10, 20px icon — always with an accessible name. */
export function IconBtn({
  name,
  label,
  onClick,
  disabled,
  danger,
}: {
  name: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`icon-btn${danger ? " hover:text-status-danger" : ""}`}
    >
      <Icon name={name} size={20} />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-line"
      }`}
    >
      {/* border-line keeps the knob visible on the OFF (bg-line) track — the
          §1 two-shadow rule removed its drop shadow, tokens supply the edge */}
      <span
        className={`absolute end-0.5 top-0.5 h-5 w-5 rounded-full border border-line bg-white transition-transform ${
          checked ? "translate-x-0" : "translate-x-5"
        }`}
      />
    </button>
  );
}

export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        {hint ? <p className="field-hint">{hint}</p> : null}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

// Segmented single-choice control (RTL: options render right-to-left in source
// order). Sanctioned segmented anatomy: the TRACK renders 44px overall — 36px
// options inside a 4px-padded borderless track (bg-field, like the canonical
// Tabs track) — which is how §4's 44px is satisfied for this control.
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex flex-row-reverse rounded-xl bg-field p-1"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`btn btn-sm rounded-lg ${on ? "bg-primary text-white" : "text-text2 hover:bg-hover"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Warns before leaving/reloading the tab while a form is dirty (§F unsaved-change
// protection). Modal editors sit above this; the inline extra-guest form uses it.
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
