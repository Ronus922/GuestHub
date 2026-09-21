import "server-only";
import { timingSafeEqual } from "node:crypto";

// ============================================================
// BIOS Bot Service API (Phase 5) — shared configuration + auth.
//
// Server-to-server only: the BIOS Bot GuestHub Connector calls
// /api/bios-bot/v1/* with the x-bios-bot-secret header. Env unset ⇒ the API
// is OFF (fail-closed) — same shape as requireBookingSecret
// (src/lib/public-booking/config.ts), deliberately a SEPARATE secret: never
// PUBLIC_BOOKING_API_SECRET. The two integrations must be rotatable,
// scopable and revocable independently of each other.
//
// BIOS Bot never gets a session, never gets SUPABASE_SERVICE_ROLE_KEY, and
// never gets DATABASE_URL — this module is the only thing it authenticates
// with, and the only thing it authenticates AS is the fixed tenant below.
// ============================================================

// The GuestHub tenant/property this service boundary serves. Configured
// server-side only — a caller-supplied tenantId is NEVER trusted (Phase 5
// audit §7: "the server decides scope"). No hardcoded fallback: unset means
// the API is not wired to any property yet, not "guess the public one."
export function resolveBiosBotTenantId(): string | null {
  return process.env.BIOS_BOT_TENANT_ID || null;
}

export function requireBiosBotSecret(req: Request): boolean {
  const secret = process.env.BIOS_BOT_API_SECRET;
  const sent = req.headers.get("x-bios-bot-secret");
  if (!secret || !sent) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b);
}
