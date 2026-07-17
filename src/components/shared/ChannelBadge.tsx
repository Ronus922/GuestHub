import { CHANNEL_CONFIG, type VisibleChannel } from "@/lib/colors";

// The ONE reservation-channel badge — calendar pill (lg, 21px, white ring),
// popover row (md, 18px), legend (sm, 16px). Glyph, colors and display name
// all come from CHANNEL_CONFIG (src/lib/colors.ts). It accepts ONLY a visible
// channel (booking/airbnb/expedia/site) — an internal reservation has no
// channel, so its parent renders nothing (no wrapper, no reserved width).
// `flex: none` in .ch-badge guarantees the circle never shrinks or distorts
// on a narrow pill.
export function ChannelBadge({
  channel,
  size = "md",
  ring = false,
}: {
  channel: VisibleChannel;
  /** sm 16px (legend) · md 18px (popover) · lg 21px (calendar pill) */
  size?: "sm" | "md" | "lg";
  /** white separation ring — calendar pills only */
  ring?: boolean;
}) {
  const c = CHANNEL_CONFIG[channel];
  const label = `ערוץ: ${c.name}`;
  return (
    <span
      className={`ch-badge${size === "lg" ? "" : ` ${size}`}${ring ? " ring" : ""}`}
      style={{ background: c.bg, color: c.tx }}
      role="img"
      title={label}
      aria-label={label}
    >
      {c.glyph}
    </span>
  );
}
