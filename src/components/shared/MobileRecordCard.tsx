import type { ReactNode } from "react";

// One record, as a card, for phone-width viewports.
//
// Below `md` the dense screens stop being tables. A 12-column grid at 1240px does
// not become usable by scrolling it sideways inside a 390px window — the reader
// loses the row they were on the moment the identifying column scrolls out of
// sight. Each row becomes a card instead: the identity stays at the top, the
// facts read as label/value pairs, and the actions sit where a thumb reaches.
//
// This is NOT a new design language. Every surface, radius, weight and colour
// here comes from the canonical primitives — `.card`, `.chip`, `.t-label`,
// `.t-secondary` (design-system.css §1/§3/§6) — which is also why check:design
// stays green over it. It exists so nine screens share one implementation
// instead of nine near-identical ones (iron rule #8).
//
// Paired with the table, never replacing it:
//   <div className="hidden md:block">…the existing table…</div>
//   <div className="md:hidden">…MobileRecordCard per row…</div>
// Both trees always render, mirroring CalendarScreen's desktop/mobile split —
// no `isMobile` guess, so nothing flashes on hydration.

export type RecordField = {
  label: string;
  value: ReactNode;
  /** Take the full width instead of one grid column — for long text. */
  wide?: boolean;
};

export function MobileRecordCard({
  title,
  subtitle,
  badge,
  fields,
  actions,
  onActivate,
  activateLabel,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** A canonical `.chip` — status, payment state, channel. */
  badge?: ReactNode;
  fields: RecordField[];
  /** Buttons/links. Rendered in a wrapping row above the safe area. */
  actions?: ReactNode;
  /**
   * Makes the whole card open the record. Rendered as a real <button> wrapping
   * the header — never a click handler on a <div>, so it keeps keyboard and
   * screen-reader semantics and its own focus ring.
   */
  onActivate?: () => void;
  /** Accessible name for the activate button. Required whenever onActivate is set. */
  activateLabel?: string;
}) {
  const header = (
    <>
      <div className="min-w-0 flex-1">
        {/* bdi: a Latin guest name, an email or a reservation number keeps its own
            direction inside the RTL card instead of scrambling around the digits */}
        <bdi className="t-body block truncate font-bold">{title}</bdi>
        {subtitle ? <span className="t-label mt-0.5 block truncate">{subtitle}</span> : null}
      </div>
      {badge ? <span className="shrink-0">{badge}</span> : null}
    </>
  );

  return (
    <article className="card flex flex-col gap-3 p-4">
      {onActivate ? (
        <button
          type="button"
          onClick={onActivate}
          aria-label={activateLabel}
          className="focus-ring -m-1 flex items-start gap-3 rounded-xl p-1 text-start"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-start gap-3">{header}</div>
      )}

      {fields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          {fields.map((f) => (
            <div key={f.label} className={f.wide ? "col-span-2 min-w-0" : "min-w-0"}>
              <dt className="t-label">{f.label}</dt>
              {/* break-words, not truncate: inside a card there is room for a
                  second line, and a half-shown phone number helps nobody */}
              <dd className="t-secondary break-words">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </article>
  );
}

/** The list wrapper — one place for the gap, so nine screens cannot drift apart. */
export function MobileRecordList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 md:hidden">{children}</div>;
}
