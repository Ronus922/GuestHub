// ============================================================
// <Donut> — the ONE SVG ring renderer (audit §B.2).
//
// Two call sites are coming: the dashboard's `src` window at 150px and the
// booking-sources screen at 280px. Same maths, two sizes — so the maths lives
// in ./donut-arcs.ts (pure, tested) and this file only maps it onto elements.
//
// The three traps of InvitationSources.md §10 are solved here, once:
//   1. negative accumulating stroke-dashoffset  → donut-arcs.ts
//   2. rotate(-90deg) on the <svg>, NOT on each <circle>  → the `donut-svg`
//      class in design-system.css carries the transform
//   3. pointer-events:none on the centre label, so it never eats a slice click
//      → the `donut-center` class
//
// Colour comes from the caller (there is one channel→colour map, and it is
// src/lib/colors.ts); this component declares none. The track ring is styled
// by class, not by attribute, for the same reason.
// ============================================================
import { donutArcs, type DonutSlice } from "./donut-arcs";

export function Donut({
  slices,
  size,
  centerValue,
  centerUnit,
  centerLabel,
  selectedId,
  onSelect,
  label,
}: {
  slices: readonly DonutSlice[];
  /** rendered box in px; the viewBox is always 200×200 */
  size: number;
  centerValue?: string;
  centerUnit?: string;
  centerLabel?: string;
  /** when set, every other slice dims — the filter affordance */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** accessible name; the ring is decorative without it */
  label?: string;
}) {
  const g = donutArcs(slices);
  const interactive = typeof onSelect === "function";

  return (
    <div className="donut" style={{ width: size, height: size }}>
      {/* ds-allow: the donut IS the SVG — <Icon> renders ligatures, not arcs */}
      <svg
        className="donut-svg"
        viewBox={g.viewBox}
        width={size}
        height={size}
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        <circle
          className="donut-track"
          cx={g.center}
          cy={g.center}
          r={g.radius}
          fill="none"
          strokeWidth={g.strokeWidth}
        />
        {g.arcs.map((a) => (
          <circle
            key={a.id}
            className={`donut-arc${interactive ? " clickable" : ""}`}
            cx={g.center}
            cy={g.center}
            r={g.radius}
            fill="none"
            stroke={a.color}
            strokeWidth={g.strokeWidth}
            strokeDasharray={a.dash}
            strokeDashoffset={a.offset}
            opacity={selectedId && selectedId !== a.id ? 0.28 : 1}
            onClick={interactive ? () => onSelect?.(a.id) : undefined}
          >
            <title>{a.label}</title>
          </circle>
        ))}
      </svg>
      {(centerValue || centerLabel) && (
        <div className="donut-center">
          {centerValue && <span className="donut-value ltr-num">{centerValue}</span>}
          {centerUnit && <span className="donut-unit">{centerUnit}</span>}
          {centerLabel && <span className="donut-label">{centerLabel}</span>}
        </div>
      )}
    </div>
  );
}
