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
  readonly kind: "disabled" | "dry_run" | "channex" | "record";
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

// A single recorded push call. `seq` is a per-instance monotonic counter (NOT
// Date.now()/Math.random(), which are banned) so recorded ids are deterministic.
export type RecordedCall = {
  method: "pushAvailability" | "pushRates" | "pushRestrictions";
  batch: AriBatch[];
  seq: number;
};

// In-memory recording double (Phase 4A drain checks). Validates every batch
// exactly like the dry-run provider, appends a structured entry to an in-memory
// `calls` array, and returns a deterministic providerTaskId. Contains NO
// fetch/HTTP code — an accidental network call is structurally impossible, so a
// drain test can assert "zero network" by construction. Never the default,
// never a real Channex client; selected only under an explicit mode.
export class RecordingChannelManagerProvider implements ChannelManagerProvider {
  readonly kind = "record" as const;
  private seq = 0;
  private readonly calls: RecordedCall[] = [];

  private record(method: RecordedCall["method"], batches: AriBatch[]): ProviderResult {
    for (const b of batches) {
      const err = validateAriPayload(b);
      if (err) return { ok: false, code: "validation_error", message: err };
    }
    const seq = ++this.seq;
    this.calls.push({ method, batch: batches, seq });
    return { ok: true, providerTaskId: `rec-${seq}` };
  }

  // read-only view of what WOULD have been sent, in call order
  getRecordedCalls(): readonly RecordedCall[] {
    return this.calls;
  }
  // clear the recording (the monotonic seq keeps counting — ids stay unique)
  reset(): void {
    this.calls.length = 0;
  }

  async validateConnection(): Promise<ProviderResult> {
    return { ok: true, detail: "recording: in-memory double, no network" };
  }
  async pushAvailability(batches: AriBatch[]) { return this.record("pushAvailability", batches); }
  async pushRates(batches: AriBatch[]) { return this.record("pushRates", batches); }
  async pushRestrictions(batches: AriBatch[]) { return this.record("pushRestrictions", batches); }
  async pullBookingRevisions(): Promise<ProviderResult> {
    return { ok: false, code: "disabled", message: "recording: inbound pull is disabled" };
  }
  async acknowledgeBookingRevision(): Promise<ProviderResult> {
    return { ok: false, code: "disabled", message: "recording: acknowledgement is disabled" };
  }
}

export type ProviderSelector = {
  // server config flag (CHANNEX_ENABLED === "true"); absent in Phase 3
  channexEnabled: boolean;
  // channel_connections.state — only 'active' may ever reach a real provider
  connectionState: string | null;
  dryRun?: boolean;
  // Explicit opt-in to the in-memory recording double (drain checks / dev). Kept
  // as an argument — NOT a process.env read — so this module stays env-free per
  // the header invariant. Absent in every production call, so the default
  // (Disabled/DryRun) is unchanged; a real Channex client is still never built.
  mode?: "record";
};

// The ONLY factory. A real HTTP provider requires BOTH the explicit server
// flag AND an active connection; neither exists in Phase 3, and even then
// this module cannot construct one (the real client lives behind the queue
// worker, never behind reservation/calendar code).
export function createChannelProvider(sel: ProviderSelector): ChannelManagerProvider {
  // Explicit test/dev opt-in: in-memory recorder, no network, no gating.
  if (sel.mode === "record") {
    return new RecordingChannelManagerProvider();
  }
  if (!sel.channexEnabled || sel.connectionState !== "active") {
    return new DisabledChannelManagerProvider();
  }
  // Phase 3 ceiling: even a fully-enabled selector gets the dry-run provider.
  // The real ChannexClient is introduced only at activation time, behind this
  // same factory. ponytail: no dead HTTP code shipped disabled.
  return new DryRunChannexProvider();
}
