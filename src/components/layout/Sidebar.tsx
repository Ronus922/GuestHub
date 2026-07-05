"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { NAV_SECTIONS, type NavItem } from "./nav-items";
import { useActor, usePermission } from "@/components/providers/TenantProvider";
import { useNewReservation } from "@/components/reservations/NewReservationProvider";
import { logoutAction } from "@/lib/auth/actions";

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const actor = useActor();
  const { openNewReservation, canCreate } = useNewReservation();
  const initial = (actor.fullName ?? actor.username).trim().charAt(0) || "G";

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-e border-line bg-surface transition-[width] duration-200 ${
        collapsed ? "w-[76px]" : "w-[250px]"
      }`}
    >
      {/* מותג */}
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary">
          <Icon name="building" size={20} className="text-white" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate font-extrabold text-ink">GuestHub</p>
            <p className="truncate text-xs text-faint">Property Management</p>
          </div>
        )}
      </div>

      {/* CTA — global new-reservation entry point (D48): opens the shared
          BookingPanel over the current page from any dashboard route */}
      {canCreate && (
        <div className="px-3 pb-2">
          <button
            type="button"
            className={`btn btn-primary w-full ${collapsed ? "px-0" : ""}`}
            title="הזמנה חדשה"
            onClick={() => openNewReservation({ source: "global_sidebar" })}
          >
            <Icon name="plus" size={18} />
            {!collapsed && "הזמנה חדשה"}
          </button>
        </div>
      )}

      {/* ניווט */}
      <nav className="thin-scroll flex-1 overflow-y-auto px-3 py-2">
        {NAV_SECTIONS.map((section) => {
          if (section.hidden) return null;
          const items = section.items.filter((item) => !item.hidden);
          if (items.length === 0) return null;
          return (
            <div key={section.title} className="mb-4">
              {!collapsed && (
                <p className="px-3 pb-1 text-[11px] font-bold tracking-wide text-faint">
                  {section.title}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <NavRow key={item.label} item={item} collapsed={collapsed} />
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* משתמש + התנתקות */}
      <div className="border-t border-line p-3">
        <div
          className={`flex items-center gap-3 rounded-xl border border-line px-3 py-2 ${
            collapsed ? "justify-center" : ""
          }`}
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-sm font-bold text-white">
            {initial}
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-ink">
                  {actor.fullName ?? actor.username}
                </p>
                <p className="truncate text-xs text-faint">{actor.tenantName}</p>
              </div>
              <Icon name="chevron" size={16} className="shrink-0 text-faint" />
            </>
          )}
        </div>

        <form action={logoutAction} className="mt-1">
          <button
            type="submit"
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-status-danger hover:bg-status-danger-050 ${
              collapsed ? "justify-center" : ""
            }`}
          >
            <Icon name="logout" size={18} />
            {!collapsed && "התנתקות"}
          </button>
        </form>
      </div>
    </aside>
  );
}

// Active when the path matches and the `panel` overlay param matches too
// (absent === absent). Keeps /rates and /rates?panel=group-update mutually
// exclusive in the highlight; other params (from/view) don't affect it.
function isNavActive(href: string | undefined, pathname: string, curPanel: string | null): boolean {
  if (!href) return false;
  const [path, query = ""] = href.split("?");
  if (pathname !== path) return false;
  return (new URLSearchParams(query).get("panel") ?? null) === (curPanel ?? null);
}

function NavRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const allowed = usePermission(item.permission);
  if (!allowed) return null;

  const active = isNavActive(item.href, pathname, searchParams.get("panel"));

  const base = `relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
    collapsed ? "justify-center" : ""
  }`;
  const state = active
    ? "bg-primary-050 font-semibold text-primary"
    : "text-text2 hover:bg-hover";

  const inner = (
    <>
      {active && (
        <span className="pointer-events-none absolute inset-y-2 start-0 w-1 rounded-full bg-primary" />
      )}
      <Icon name={item.icon} size={20} className="shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </>
  );

  if (item.href) {
    return (
      <li>
        <Link href={item.href} className={`${base} ${state}`} title={item.label}>
          {inner}
        </Link>
      </li>
    );
  }

  // Inert item (Phase 1 — no business screen yet).
  return (
    <li>
      <span
        className={`${base} ${state} cursor-default`}
        title={item.label}
        aria-disabled="true"
      >
        {inner}
      </span>
    </li>
  );
}
