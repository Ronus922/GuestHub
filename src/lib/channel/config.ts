import "server-only";
import { sql } from "@/lib/db";
import { createChannelProvider, type ChannelManagerProvider } from "./provider";

// ============================================================
// The single server-only environment/config boundary for the channel
// manager (§W). Base URLs live HERE and nowhere else. Nothing in Phase 3
// sets CHANNEX_ENABLED, so every provider resolution yields the disabled
// provider and no network call is possible.
// ============================================================

export const CHANNEX_BASE_URLS = {
  staging: "https://staging.channex.io/api/v1",
  production: "https://app.channex.io/api/v1",
} as const;

export function isChannexEnabled(): boolean {
  return process.env.CHANNEX_ENABLED === "true";
}

// Resolve the provider for a tenant's connection. Disabled unless BOTH the
// server flag and an active connection exist (never in Phase 3).
export async function getChannelProvider(
  tenantId: string,
): Promise<ChannelManagerProvider> {
  if (!isChannexEnabled()) {
    return createChannelProvider({ channexEnabled: false, connectionState: null });
  }
  const [conn] = await sql<{ state: string }[]>`
    SELECT state FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = 'channex'
    ORDER BY (state = 'active') DESC LIMIT 1`;
  return createChannelProvider({
    channexEnabled: true,
    connectionState: conn?.state ?? null,
  });
}
