"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "sonner";
import { TenantProvider } from "@/components/providers/TenantProvider";
import { RealtimeProvider } from "@/components/providers/RealtimeProvider";
import { NewReservationProvider } from "@/components/reservations/NewReservationProvider";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";
import type { ActorContext } from "@/lib/auth/actor";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export type NewReservationConfig = {
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  workflowStatuses: LookupItem[];
  ratePlans: { id: string; name: string; code: string }[];
  vatRate: number;
  canSaveCard: boolean;
  canPriceOverride: boolean;
  canCreate: boolean;
};

export function Shell({
  actor,
  propertyIdentity,
  newReservation,
  children,
}: {
  actor: ActorContext;
  propertyIdentity: string;
  newReservation: NewReservationConfig;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("#dashboard-sidebar a[href], #dashboard-sidebar button:not([disabled])")
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      sidebarToggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileOpen((open) => !open);
      return;
    }
    setCollapsed((value) => !value);
  };

  const closeMobileSidebar = (restoreFocus = false) => {
    setMobileOpen(false);
    if (restoreFocus) requestAnimationFrame(() => sidebarToggleRef.current?.focus());
  };

  return (
    <TenantProvider actor={actor}>
      <NuqsAdapter>
        <RealtimeProvider>
        <NewReservationProvider {...newReservation}>
          <div className="flex h-screen overflow-hidden bg-appbg">
            {/* Sidebar — צד ימין ב-RTL (הילד הראשון) */}
            {mobileOpen && (
              <button
                type="button"
                className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm md:hidden"
                aria-label="סגירת תפריט הניווט"
                onClick={() => closeMobileSidebar(true)}
              />
            )}
            <Sidebar
              collapsed={isMobile ? false : collapsed}
              mobileOpen={mobileOpen}
              isMobile={isMobile}
              propertyIdentity={propertyIdentity}
              onNavigate={() => closeMobileSidebar(false)}
            />

            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar
                onToggleSidebar={toggleSidebar}
                expanded={isMobile ? mobileOpen : !collapsed}
                toggleRef={sidebarToggleRef}
              />
              <main className="thin-scroll flex-1 overflow-auto">{children}</main>
            </div>
          </div>
        </NewReservationProvider>
        </RealtimeProvider>
        {/* GUIDELINES §9 — the ONE toast: bottom-centre, 26px from the bottom,
            ink surface, white 15px/700, r-md, gone after 2.8s. `richColors` is
            deliberately OFF: it would paint per-type surfaces that are not in
            the token set. Semantic difference is carried by the icon colour. */}
        <Toaster
          position="bottom-center"
          dir="rtl"
          offset={26}
          duration={2800}
          toastOptions={{ className: "gh-toast" }}
        />
      </NuqsAdapter>
    </TenantProvider>
  );
}
