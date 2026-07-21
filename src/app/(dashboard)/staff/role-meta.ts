import type { IconName } from "@/components/shared/Icon";
import type { BadgeTone } from "@/components/ui/Badge";

// Visual mapping per role key (icon + tint), per employees-list-screen.png.
// Names and descriptions always come from guesthub.roles — this is styling only.
type RoleMeta = { tone: BadgeTone; icon: IconName };

const ROLE_META: Record<string, RoleMeta> = {
  super_admin: { tone: "brand", icon: "crown" },
  admin: { tone: "brand", icon: "shield-check" },
  manager: { tone: "brand", icon: "shield-check" },
  receptionist: { tone: "warning", icon: "concierge" },
  staff: { tone: "neutral", icon: "user" },
  cleaner: { tone: "success", icon: "brush" },
  maintenance: { tone: "warning", icon: "maintenance" },
};

const FALLBACK: RoleMeta = { tone: "neutral", icon: "user" };

export const roleMeta = (key: string | null | undefined): RoleMeta =>
  ROLE_META[key ?? ""] ?? FALLBACK;

// Avatar tint follows the role tone (reference: avatars match role colors).
export const AVATAR_TINT: Record<BadgeTone, string> = {
  brand: "bg-primary-050 text-primary",
  success: "bg-status-success-050 text-status-success",
  warning: "bg-status-warning-050 text-status-warning",
  danger: "bg-status-danger-050 text-status-danger",
  neutral: "bg-hover text-text2",
  muted: "bg-hover text-muted",
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "G";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0]}${parts[1][0]}`;
}
