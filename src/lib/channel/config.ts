// ============================================================
// The single environment/config boundary for the channel manager (§W).
// Channex base URLs live HERE and nowhere else.
//
// D68 removed the ChannelManagerProvider abstraction that hung off this module
// (Disabled / DryRun / Recording implementations plus the factory choosing
// between them). getChannelProvider() had no caller anywhere in the codebase,
// and the batch shape it spoke was the room-type-keyed one D64 retired.
//
// Outbound ARI now goes through ./channex-ari.ts. The gate is not an env flag
// but the connection's own state: only `state='active' AND outbound_sync_enabled
// AND NOT full_sync_required` — reached solely by the operator running the Full
// Sync — is ever drained, and only the PM2 worker drains it. No request path, no
// migration and no test can send ARI.
// ============================================================

export const CHANNEX_BASE_URLS = {
  staging: "https://staging.channex.io/api/v1",
  production: "https://app.channex.io/api/v1",
} as const;

export type ChannexEnvironment = keyof typeof CHANNEX_BASE_URLS;

// The ONE base-URL resolver. Every Channex HTTP call derives its baseUrl from a
// connection's `environment` column through this function — never from a literal
// member access at the call site. `check:channex-environment-routing` enforces
// that CHANNEX_BASE_URLS is read nowhere else, so a staging/production crossover
// cannot be introduced by a stray literal.
export function channexBaseUrl(env: ChannexEnvironment): string {
  const url = CHANNEX_BASE_URLS[env];
  if (!url) throw new Error(`Unknown Channex environment: ${String(env)}`);
  return url;
}
