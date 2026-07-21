import { CHANNEL_CONFIG, type BadgeChannel } from "@/lib/colors";
import { Icon } from "@/components/shared/Icon";

// The ONE reservation-channel badge — calendar pill (lg, 21px, white ring),
// popover row (md, 18px), legend (sm, 16px). Glyph/icon, colors and display name
// all come from CHANNEL_CONFIG (src/lib/colors.ts). booking/airbnb/expedia wear a
// letter; site (globe) and manual (pencil) wear a Material Symbol. `flex: none`
// in .ch-badge guarantees the circle never shrinks or distorts on a narrow pill.
export function ChannelBadge({
  channel,
  size = "md",
  ring = false,
}: {
  channel: BadgeChannel;
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
      {c.icon ? <Icon name={c.icon} size={13.5} /> : c.glyph}
    </span>
  );
}
