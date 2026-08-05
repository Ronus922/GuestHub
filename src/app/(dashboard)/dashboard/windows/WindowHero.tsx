"use client";

// ============================================================
// <WindowHero> — the v2 opening tile the rvw and msg windows share (rule #8:
// one anatomy, two call sites): brand square carrying THE number, a headline,
// one line of context, and at most one status chip pushed to the far edge.
//
// The chip is the CALLER's element, already dressed (chip-approval /
// chip-partial) — this component does not know what zero means for each
// window, so "omit the chip at 0" is decided where the number is understood.
// ============================================================
export function WindowHero({
  value,
  headline,
  subline,
  chip,
}: {
  /** the square's number, already formatted ("8.7", "4") */
  value: string;
  headline: string;
  subline: React.ReactNode;
  chip?: React.ReactNode;
}) {
  return (
    <div className="win-hero">
      <span className="win-hero-score ltr-num">{value}</span>
      <div className="win-hero-text">
        <div className="win-hero-t">{headline}</div>
        <div className="win-hero-d">{subline}</div>
      </div>
      {chip && <span className="win-hero-chip">{chip}</span>}
    </div>
  );
}
