import "server-only";
import { getResolvedConnection, getActiveWhatsAppProvider, type ResolvedConnection } from "./store";
import { GmailOAuthProvider, GmailSmtpProvider } from "./email/gmail";
import { GreenApiWhatsAppProvider } from "./whatsapp/green-api";
import { TwilioWhatsAppProvider } from "./whatsapp/twilio";
import type {
  EmailProvider,
  WhatsAppProvider,
  GmailConfig,
  GmailSecrets,
  GreenApiConfig,
  GreenApiSecrets,
  TwilioConfig,
  TwilioSecrets,
  WhatsAppProviderId,
} from "./types";

// Resolves the per-tenant provider instance behind the shared interfaces. The
// rest of the app depends on these functions — never on the adapter classes or
// the raw provider APIs directly. Returns null when the provider is not
// configured (no connection / no secret) — callers surface an honest
// "not configured" state, never a fake success.

export function buildEmailProvider(conn: ResolvedConnection): EmailProvider {
  const config = conn.config as unknown as GmailConfig;
  const secrets = conn.secrets as unknown as GmailSecrets;
  return config.mode === "smtp"
    ? new GmailSmtpProvider(config, secrets)
    : new GmailOAuthProvider(config, secrets);
}

export function buildWhatsAppProvider(providerId: WhatsAppProviderId, conn: ResolvedConnection): WhatsAppProvider | null {
  if (providerId === "green_api") {
    return new GreenApiWhatsAppProvider(conn.config as unknown as GreenApiConfig, conn.secrets as unknown as GreenApiSecrets);
  }
  if (providerId === "twilio") {
    return new TwilioWhatsAppProvider(conn.config as unknown as TwilioConfig, conn.secrets as unknown as TwilioSecrets);
  }
  return null;
}

export async function resolveEmailProvider(tenantId: string): Promise<EmailProvider | null> {
  const conn = await getResolvedConnection(tenantId, "gmail");
  if (!conn || Object.keys(conn.secrets).length === 0) return null;
  return buildEmailProvider(conn);
}

export async function resolveWhatsAppProvider(
  tenantId: string,
): Promise<{ provider: WhatsAppProvider; id: "green_api" | "twilio" } | null> {
  const active = await getActiveWhatsAppProvider(tenantId);
  if (active === "disabled") return null;
  const conn = await getResolvedConnection(tenantId, active);
  if (!conn || Object.keys(conn.secrets).length === 0) return null;
  const provider = buildWhatsAppProvider(active, conn);
  return provider ? { provider, id: active } : null;
}

export type { WhatsAppProviderId };
