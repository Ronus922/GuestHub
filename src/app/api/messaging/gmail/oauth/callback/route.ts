import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getActor } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import { getResolvedConnection, upsertConnection } from "@/lib/messaging/store";
import type { GmailConfig, GmailSecrets } from "@/lib/messaging/types";

// Gmail OAuth — STEP 2: callback (D53). Verifies the CSRF state cookie, re-checks
// that the caller is still the same super_admin of the state's tenant, exchanges
// the code for a refresh_token, reads the connected mailbox address, and persists
// an encrypted, self-contained oauth connection (clientId + clientSecret +
// refreshToken) so future sends work. On ANY failure we redirect to /settings
// with a coarse error code — never a token or secret in the URL or a log.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StateShape = { tenantId?: string; n?: string };

function decodeState(state: string): StateShape | null {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as StateShape;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const cookieStore = await cookies();
  const settings = (query: string) => {
    cookieStore.delete("gmail_oauth_state");
    return NextResponse.redirect(new URL(`/settings?section=messaging&${query}`, appUrl));
  };

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // CSRF: the returned state must equal the one we set at start.
  const stateCookie = cookieStore.get("gmail_oauth_state")?.value;
  if (!state || !stateCookie || stateCookie !== state) {
    return settings("gmail=error_state");
  }
  const tenantId = decodeState(state)?.tenantId;
  if (!tenantId) {
    return settings("gmail=error_state");
  }

  // Re-authorize: same super_admin, same tenant as the state — never trust it blindly.
  const actor = await getActor();
  if (!actor || actor.roleKey !== "super_admin" || actor.tenantId !== tenantId) {
    return settings("gmail=error");
  }
  if (!code) {
    return settings("gmail=error");
  }

  // Credentials: tenant's stored oauth client first, else the global env client.
  let existingSecrets: Partial<GmailSecrets> = {};
  let existingConfig: Partial<GmailConfig> = {};
  try {
    const existing = await getResolvedConnection(tenantId, "gmail");
    existingSecrets = (existing?.secrets ?? {}) as Partial<GmailSecrets>;
    existingConfig = (existing?.config ?? {}) as Partial<GmailConfig>;
  } catch {
    existingSecrets = {};
    existingConfig = {};
  }
  const clientId = existingSecrets.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = existingSecrets.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    return settings("gmail=error_no_client");
  }

  const redirectUri = `${appUrl}/api/messaging/gmail/oauth/callback`;

  // Exchange the authorization code for tokens.
  let refreshToken: string | undefined;
  let accessToken: string | undefined;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      return settings("gmail=error");
    }
    const token = (await res.json()) as { refresh_token?: string; access_token?: string };
    refreshToken = token.refresh_token;
    accessToken = token.access_token;
  } catch {
    return settings("gmail=error");
  }

  // No refresh_token means Google skipped re-consent (prompt=consent should prevent it).
  if (!refreshToken) {
    return settings("gmail=error_no_refresh");
  }

  // Best-effort: read the connected mailbox address for the sender config.
  let emailAddress: string | null = null;
  if (accessToken) {
    try {
      const profile = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (profile.ok) {
        const pj = (await profile.json()) as { emailAddress?: string };
        emailAddress = pj.emailAddress ?? null;
      }
    } catch {
      emailAddress = null;
    }
  }

  const senderEmail = emailAddress || existingConfig.senderEmail || "";

  // Persist a self-contained encrypted connection (client id/secret + refresh token).
  const mergedSecrets: Record<string, unknown> = {
    ...existingSecrets,
    clientId,
    clientSecret,
    refreshToken,
  };
  const mergedConfig: Record<string, unknown> = {
    ...existingConfig,
    mode: "oauth",
    senderEmail,
  };

  try {
    await upsertConnection({
      tenantId,
      provider: "gmail",
      config: mergedConfig,
      secrets: mergedSecrets,
      status: "connected",
      statusDetail: "חשבון Gmail חובר בהצלחה",
      userId: actor.userId,
    });
    // Audit WITHOUT any token/secret — only the provider + account address.
    await writeAudit(actor, {
      entityType: "messaging_provider",
      entityId: null,
      action: "messaging_gmail_connected",
      after: { provider: "gmail", account: emailAddress },
    });
  } catch {
    return settings("gmail=error");
  }

  return settings("gmail=connected");
}
