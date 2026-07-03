"use client";

import { createContext, useContext } from "react";
import type { ActorContext } from "@/lib/auth/actor";

const ActorCtx = createContext<ActorContext | null>(null);

export function TenantProvider({
  actor,
  children,
}: {
  actor: ActorContext;
  children: React.ReactNode;
}) {
  return <ActorCtx.Provider value={actor}>{children}</ActorCtx.Provider>;
}

export function useActor(): ActorContext {
  const ctx = useContext(ActorCtx);
  if (!ctx) throw new Error("useActor must be used within <TenantProvider>");
  return ctx;
}

// UI-only convenience (buttons/nav). The server still enforces requirePermission.
export function usePermission(key: string | undefined): boolean {
  const actor = useActor();
  if (!key) return true;
  return (
    actor.roleKey === "super_admin" ||
    actor.roleKey === "admin" ||
    actor.permissions.includes(key)
  );
}
