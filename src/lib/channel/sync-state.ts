// ============================================================
// PURE /rates channel-sync status types (no imports, no DB) — shared by the
// server read model (rates-sync.ts) and the client control on /rates, and
// checkable by scripts/check-rates-sync.mjs.
// ============================================================

export type RatesSyncState = "not_connected" | "synced" | "syncing" | "failed";

/**
 * The single derivation of the /rates sync chip from persisted DB facts.
 * Precedence: failed work needs the operator's attention even while other
 * ranges are still pending, so "failed" wins over "syncing".
 */
export function deriveRatesSyncState(
  connected: boolean,
  pendingRanges: number,
  failedRanges: number,
): RatesSyncState {
  if (!connected) return "not_connected";
  if (failedRanges > 0) return "failed";
  if (pendingRanges > 0) return "syncing";
  return "synced";
}

export const RATES_SYNC_TEXT: Record<RatesSyncState, string> = {
  not_connected: "ללא חיבור ערוצים",
  synced: "מסונכרן",
  syncing: "מסנכרן…",
  failed: "הסנכרון נכשל",
};

/**
 * The serialized status snapshot the /rates page ships to the client.
 * HYDRATION CONTRACT (D71): every timestamp arrives PRE-FORMATTED on the
 * server in the property timezone — the client renders these strings verbatim
 * and never touches a date, locale or clock API.
 */
export type RatesSyncStatus = {
  /** an active, outbound-enabled, baseline-established connection exists */
  connected: boolean;
  state: RatesSyncState;
  pendingRanges: number;
  failedRanges: number;
  /** PM2 worker heartbeat is fresh — pending work will actually drain */
  workerOnline: boolean;
  /** server-formatted "10.7.2026, 11:14", or "—" */
  lastSyncAt: string;
};

/** What the manual "סנכרן ערוצים" action did — counts, never a provider body. */
export type SyncNowResult = {
  /** failed ranges re-queued for ONE more attempt (attempts preserved) */
  retriedFailed: number;
  /** pending ranges the enqueued drain will pick up */
  pendingRanges: number;
  /** nothing pending and nothing failed — no job was created */
  nothingToSync: boolean;
};
