"use client";

import { useState } from "react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "sonner";
import { TenantProvider } from "@/components/providers/TenantProvider";
import { NewReservationProvider } from "@/components/reservations/NewReservationProvider";
import type { LookupItem } from "@/app/(dashboard)/calendar/CalendarScreen";
import type { ActorContext } from "@/lib/auth/actor";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export type NewReservationConfig = {
  bookingSources: LookupItem[];
  paymentMethods: LookupItem[];
  ratePlans: { id: string; name: string; code: string }[];
  vatRate: number;
  canSaveCard: boolean;
  canPriceOverride: boolean;
  canCreate: boolean;
};

export function Shell({
  actor,
  newReservation,
  children,
}: {
  actor: ActorContext;
  newReservation: NewReservationConfig;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <TenantProvider actor={actor}>
      <NuqsAdapter>
        <NewReservationProvider {...newReservation}>
          <div className="flex h-screen overflow-hidden bg-appbg">
            {/* Sidebar — צד ימין ב-RTL (הילד הראשון) */}
            <Sidebar collapsed={collapsed} />

            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar onToggleSidebar={() => setCollapsed((v) => !v)} />
              <main className="thin-scroll flex-1 overflow-auto">{children}</main>
            </div>
          </div>
        </NewReservationProvider>
        <Toaster
          position="bottom-center"
          richColors
          closeButton
          dir="rtl"
          toastOptions={{ style: { fontFamily: "var(--font-sans)" } }}
        />
      </NuqsAdapter>
    </TenantProvider>
  );
}
