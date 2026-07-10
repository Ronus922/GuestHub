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
