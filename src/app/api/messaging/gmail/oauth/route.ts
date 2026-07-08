import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getActor } from "@/lib/auth/actor";
import { getResolvedConnection } from "@/lib/messaging/store";
import type { GmailSecrets } from "@/lib/messaging/types";

// Gmail OAuth — STEP 1: start consent (D53). Only a super_admin may connect a
// tenant's Gmail sender. We build Google's consent URL with access_type=offline
// + prompt=consent (forces a refresh_token every time), and stash a CSRF state in
// an httpOnly cookie that the callback re-checks. The client id comes from the
// tenant's stored gmail secrets, else the global env fallback. No secret is ever
// put in a redirect URL.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GMAIL_SCOPES =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email";

export async function GET(request: Request) {
  // Behind nginx request.url is the internal upstream; NEXT_PUBLIC_APP_URL is the
  // public origin. redirect_uri MUST be identical here and in the callback.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const redirect = (path: string) => NextResponse.redirect(new URL(path, appUrl));

  const actor = await getActor();
  if (!actor || actor.roleKey !== "super_admin") {
    return redirect("/dashboard");
  }

  // Prefer the tenant's own OAuth client; fall back to the global env client.
  let existingSecrets: Partial<GmailSecrets> = {};
  try {
    const conn = await getResolvedConnection(actor.tenantId, "gmail");
    existingSecrets = (conn?.secrets ?? {}) as Partial<GmailSecrets>;
  } catch {
    existingSecrets = {};
  }
  const clientId = existingSecrets.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  if (!clientId) {
    return redirect("/settings?section=messaging&gmail=error_no_client");
  }

  const redirectUri = `${appUrl}/api/messaging/gmail/oauth/callback`;
  const state = Buffer.from(
    JSON.stringify({ tenantId: actor.tenantId, n: randomBytes(16).toString("hex") }),
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
  });

  const cookieStore = await cookies();
  cookieStore.set("gmail_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}
