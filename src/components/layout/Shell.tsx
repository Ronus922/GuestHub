"use client";

import { useState } from "react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { Toaster } from "sonner";
import { TenantProvider } from "@/components/providers/TenantProvider";
import type { ActorContext } from "@/lib/auth/actor";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function Shell({
  actor,
  children,
}: {
  actor: ActorContext;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <TenantProvider actor={actor}>
      <NuqsAdapter>
        <div className="flex h-screen overflow-hidden bg-appbg">
          {/* Sidebar — צד ימין ב-RTL (הילד הראשון) */}
          <Sidebar collapsed={collapsed} />

          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar onToggleSidebar={() => setCollapsed((v) => !v)} />
            <main className="thin-scroll flex-1 overflow-auto">{children}</main>
          </div>
        </div>
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
