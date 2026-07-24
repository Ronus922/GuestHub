// ============================================================
// §26 — Production activation guard.
//
// The certification program runs Staging-only. Production Channex traffic is
// impossible unless an operator has explicitly activated it AND the guard's own
// preconditions hold. This module is the SINGLE decision point for "which
// environment is this deployment operating in" — every Channex setup operation
// resolves its environment through effectiveChannelEnvironment(), so flipping to
// production is one guarded switch, not a literal edit across 30 call sites.
//
// Default (unset flag) → "staging". There is no code path that reaches the
// production base URL without CHANNEX_PRODUCTION_ACTIVATION being set to an
// explicit on-value. `check:production-activation-guard` proves this invariant.
// ============================================================

import type { ChannelEnvironment } from "./config";

// The activation flag. Deliberately a hard opt-in string, not a loose truthy
// check: only these exact values enable production.
const ON_VALUES = new Set(["1", "true", "on", "enabled"]);

export function isProductionActivationEnabled(): boolean {
  const raw = process.env.CHANNEX_PRODUCTION_ACTIVATION;
  return typeof raw === "string" && ON_VALUES.has(raw.trim().toLowerCase());
}

// The effective environment for setup/management operations. Production is
// returned ONLY behind the activation flag; otherwise staging. The runtime ARI
// send path routes off each connection row's own `environment` column and does
// not call this — but a production connection can never reach `state='active'`
// without an operator having activated production first (see the setup ops).
export function effectiveChannelEnvironment(): ChannelEnvironment {
  return isProductionActivationEnabled() ? "production" : "staging";
}

// Read-only status for the certification console and the guard check. Carries no
// secret and performs no network call.
export type ProductionActivationStatus = {
  flagPresent: boolean;
  activationEnabled: boolean;
  effectiveEnvironment: ChannelEnvironment;
  // true only when production is both flagged on AND the encryption key exists;
  // an activated flag without CHANNEL_SECRETS_KEY cannot decrypt any credential,
  // so no production call could actually authenticate.
  productionOperable: boolean;
};

export function channexActivationStatus(): ProductionActivationStatus {
  const activationEnabled = isProductionActivationEnabled();
  return {
    flagPresent: typeof process.env.CHANNEX_PRODUCTION_ACTIVATION === "string",
    activationEnabled,
    effectiveEnvironment: effectiveChannelEnvironment(),
    productionOperable: activationEnabled && !!process.env.CHANNEL_SECRETS_KEY,
  };
}

// Fail-closed assertion for any production-only path (including §26's own
// authentication test). Throws unless production is genuinely activated.
export function assertProductionActivationAuthorized(): void {
  if (!isProductionActivationEnabled()) {
    throw new Error(
      "הפעלת סביבת production ל-Channex אינה מאושרת (CHANNEX_PRODUCTION_ACTIVATION כבוי)",
    );
  }
}
