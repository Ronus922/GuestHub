// Token-only status/role pill (DESIGN_SYSTEM §5 badges). No invented colors.
const TONES = {
  neutral: "bg-hover text-text2",
  brand: "bg-primary-050 text-primary",
  success: "bg-status-success-050 text-status-success",
  danger: "bg-status-danger-050 text-status-danger",
  warning: "bg-status-warning-050 text-status-warning",
  muted: "bg-hover text-muted",
} as const;

export type BadgeTone = keyof typeof TONES;

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
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
