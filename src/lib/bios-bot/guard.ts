import "server-only";
import type { NextResponse } from "next/server";
import { requireBiosBotSecret, resolveBiosBotTenantId } from "./config";
import { biosBotErrorResponse } from "./errors";

export type BiosBotContext = { tenantId: string };

// Every /api/bios-bot/v1/* route calls this FIRST, before any business logic
// or database access (Phase 5 §6: "Authentication MUST happen before
// business/database access"). tenantId comes ONLY from trusted server
// configuration — never from the request (Phase 5 §7).
export function authenticateBiosBotRequest(
  req: Request,
): { ok: true; ctx: BiosBotContext } | { ok: false; response: NextResponse } {
  if (!requireBiosBotSecret(req)) {
    return {
      ok: false,
      response: biosBotErrorResponse("AUTHENTICATION_ERROR", "missing or invalid service credential"),
    };
  }
  const tenantId = resolveBiosBotTenantId();
  if (!tenantId) {
    return {
      ok: false,
      response: biosBotErrorResponse(
        "CONNECTOR_UNAVAILABLE",
        "the BIOS Bot service API is not configured for a property yet",
      ),
    };
  }
  return { ok: true, ctx: { tenantId } };
}
