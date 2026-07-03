"use client";

import { Icon } from "@/components/shared/Icon";
import { useActor } from "@/components/providers/TenantProvider";

export function TopBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const actor = useActor();
  const initial = (actor.fullName ?? actor.username).trim().charAt(0) || "G";

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur-md">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="כווץ/הרחב תפריט"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-hover"
      >
        <Icon name="chevron" size={20} />
      </button>

      {/* חיפוש */}
      <div className="relative w-full max-w-md">
        <Icon
          name="search"
          size={18}
          className="pointer-events-none absolute start-0 top-1/2 ms-3 -translate-y-1/2 text-faint"
        />
        <input
          type="search"
          placeholder="חיפוש הזמנות, אורחים או חדרים…"
          className="h-11 w-full rounded-xl bg-field ps-11 pe-4 text-sm text-ink placeholder:text-faint focus:bg-surface"
        />
      </div>

      {/* אשכול פעולות — נדחף לצד שמאל (inline-end ב-RTL) */}
      <div className="ms-auto flex items-center gap-1">
        <IconButton icon="languages" label="שפה" />
        <IconButton icon="bell" label="התראות" />
        <IconButton icon="moon" label="מצב כהה" />
        <span className="ms-1 grid h-9 w-9 place-items-center rounded-xl bg-primary text-sm font-bold text-white">
          {initial}
        </span>
      </div>
    </header>
  );
}

function IconButton({
  icon,
  label,
}: {
  icon: "languages" | "bell" | "moon";
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="grid h-11 w-11 place-items-center rounded-xl text-muted hover:bg-hover"
    >
      <Icon name={icon} size={20} />
    </button>
  );
}
