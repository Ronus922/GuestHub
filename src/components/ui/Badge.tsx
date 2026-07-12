// Badge = a thin wrapper over the CANONICAL `.chip` (GUIDELINES §3). There is no
// second chip implementation in the app: the anatomy (28px tall, 8px dot,
// 13.5px/700, radius 8) comes from design-system.css and is never re-typed here.
// Every tone maps to a GLOBAL chip class (§0.2) — the approved §3.1 triplets
// plus the canonical .chip-neutral / .chip-brand; no colour is composed locally.

const TONES: Record<string, string> = {
  neutral: "chip-neutral",
  brand: "chip-brand",
  success: "chip-paid",
  danger: "chip-unpaid",
  warning: "chip-approval",
  muted: "chip-cancelled",
};

// tones without a §3.1 dot colour of their own tint the dot with the text colour
const CURRENT_DOT = new Set(["brand", "neutral"]);

export type BadgeTone = "neutral" | "brand" | "success" | "danger" | "warning" | "muted";

export function Badge({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={`chip ${TONES[tone]}`}>
      {dot ? (
        <span className={`dot${CURRENT_DOT.has(tone) ? " bg-current" : ""}`} />
      ) : null}
      {children}
    </span>
  );
}
