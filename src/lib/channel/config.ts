// ============================================================
// The single environment/config boundary for the channel manager (§W).
// The channel provider is Beds24 (D91); its base URL lives HERE and nowhere else.
//
// Outbound ARI goes through ./beds24-ari.ts. The gate is not an env flag but the
// connection's own state: only `state='active' AND outbound_sync_enabled AND NOT
// full_sync_required` — reached solely by the operator running the Full Sync —
// is ever drained, and only the PM2 worker drains it. No request path, no
// migration and no test can send ARI.
// ============================================================

// A channel connection's environment column. Beds24 is production-only; the
// staging value is retained so historical rows and the evidence ledger type
// stay valid.
export type ChannelEnvironment = "staging" | "production";

// ---- Beds24 (D78) ----
// Beds24 exposes ONE production API v2 — no staging/sandbox exists. The API is
// reachable at both api.beds24.com/v2 and beds24.com/api/v2; api.beds24.com is
// the canonical host and the ONLY one used here. A `provider='beds24'`
// connection row is always environment='production' (enforced in
// beds24-admin.ts). Every Beds24 HTTP call derives its baseUrl through this
// function only.
export const BEDS24_BASE_URLS = {
  production: "https://api.beds24.com/v2",
} as const;

export function beds24BaseUrl(): string {
  return BEDS24_BASE_URLS.production;
}
