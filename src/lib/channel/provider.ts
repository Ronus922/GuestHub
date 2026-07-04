// ============================================================
// Channel-manager provider boundary (§W) — PURE module, no env/DB/HTTP
// imports, so scripts/check-calendar.mjs can assert "disabled ⇒ no network
// is even possible". Reservation/calendar code NEVER imports HTTP code; it
// only writes local data + dirty ranges. Only the future queue worker talks
// to a provider instance.
// ============================================================

import { validateAriPayload } from "./payloads";

export type ProviderResult =
  | { ok: true; providerTaskId?: string; detail?: string }
  | { ok: false; code: "disabled" | "dry_run" | "validation_error" | "network_error"; message: string };

export type AriBatch = { values: unknown[] };

export interface ChannelManagerProvider {
  readonly kind: "disabled" | "dry_run" | "channex";
  validateConnection(): Promise<ProviderResult>;
  pushAvailability(batches: AriBatch[]): Promise<ProviderResult>;
  pushRates(batches: AriBatch[]): Promise<ProviderResult>;
  pushRestrictions(batches: AriBatch[]): Promise<ProviderResult>;
  pullBookingRevisions(): Promise<ProviderResult>;
  acknowledgeBookingRevision(revisionId: string): Promise<ProviderResult>;
}

const DISABLED: ProviderResult = {
  ok: false,
  code: "disabled",
  message: "channel manager disabled — no connection is active",
};

// The default provider everywhere in Phase 3. Contains no fetch/HTTP code at
// all — an accidental network call is structurally impossible.
export class DisabledChannelManagerProvider implements ChannelManagerProvider {
  readonly kind = "disabled" as const;
  async validateConnection() { return DISABLED; }
  async pushAvailability() { return DISABLED; }
  async pushRates() { return DISABLED; }
  async pushRestrictions() { return DISABLED; }
  async pullBookingRevisions() { return DISABLED; }
  async acknowledgeBookingRevision() { return DISABLED; }
}

// Validates payload structure locally and reports what WOULD be sent.
// Also contains no HTTP code.
export class DryRunChannexProvider implements ChannelManagerProvider {
  readonly kind = "dry_run" as const;

  private validate(batches: AriBatch[]): ProviderResult {
    for (const b of batches) {
      const err = validateAriPayload(b);
      if (err) return { ok: false, code: "validation_error", message: err };
    }
    return {
      ok: true,
      detail: `dry-run: ${batches.length} batches, ${batches.reduce((n, b) => n + b.values.length, 0)} values validated locally`,
    };
  }

  async validateConnection(): Promise<ProviderResult> {
    return { ok: true, detail: "dry-run: connection not validated against provider" };
  }
  async pushAvailability(batches: AriBatch[]) { return this.validate(batches); }
  async pushRates(batches: AriBatch[]) { return this.validate(batches); }
  async pushRestrictions(batches: AriBatch[]) { return this.validate(batches); }
  async pullBookingRevisions(): Promise<ProviderResult> {
    return { ok: false, code: "dry_run", message: "dry-run: inbound pull is disabled" };
  }
  async acknowledgeBookingRevision(): Promise<ProviderResult> {
    return { ok: false, code: "dry_run", message: "dry-run: acknowledgement is disabled" };
  }
}

export type ProviderSelector = {
  // server config flag (CHANNEX_ENABLED === "true"); absent in Phase 3
  channexEnabled: boolean;
  // channel_connections.state — only 'active' may ever reach a real provider
  connectionState: string | null;
  dryRun?: boolean;
};

// The ONLY factory. A real HTTP provider requires BOTH the explicit server
// flag AND an active connection; neither exists in Phase 3, and even then
// this module cannot construct one (the real client lives behind the queue
// worker, never behind reservation/calendar code).
export function createChannelProvider(sel: ProviderSelector): ChannelManagerProvider {
  if (!sel.channexEnabled || sel.connectionState !== "active") {
    return new DisabledChannelManagerProvider();
  }
  // Phase 3 ceiling: even a fully-enabled selector gets the dry-run provider.
  // The real ChannexClient is introduced only at activation time, behind this
  // same factory. ponytail: no dead HTTP code shipped disabled.
  return new DryRunChannexProvider();
}
