import { createHmac, timingSafeEqual } from "node:crypto";
import { getConnectionByWebhookToken } from "@/lib/messaging/store";
import {
  advanceMessageStatus,
  findMessageByProviderId,
  recordMessageEvent,
} from "@/lib/messaging/messages";
import { mapTwilioStatus } from "@/lib/messaging/whatsapp/twilio";
import type { TwilioSecrets } from "@/lib/messaging/types";

// Twilio status-callback webhook (D53). Twilio POSTs form-urlencoded delivery
// status. Authenticity is TWO independent layers:
//   1. Routing/obscurity — the [token] path segment is an OPAQUE, server-generated
//      webhook token (never the account SID). It resolves the connection, and thus
//      the tenant. Inbound payloads are never trusted for tenant identity.
//   2. Cryptographic — the official X-Twilio-Signature (HMAC-SHA1 over the exact
//      public callback URL + sorted params) is verified with the connection's
//      decrypted Auth Token. The opaque token does NOT replace this.
// The signed callback URL is built from the ONE canonical configured origin
// (NEXT_PUBLIC_APP_URL) — never from an attacker-controllable request Host.
// Idempotent via recordMessageEvent; monotonic via advanceMessageStatus. Twilio
// expects a 2xx; we return 204.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Twilio signature: base64( HMAC-SHA1( authToken, URL + concat(sortedKey + value) ) ).
function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const form = await request.formData();
  const paramMap: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value === "string") paramMap[key] = value;
  });
  const field = (key: string): string => paramMap[key] ?? "";

  const messageSid = field("MessageSid") || field("SmsSid");
  const messageStatus = field("MessageStatus") || field("SmsStatus");
  if (!messageSid || !messageStatus) {
    return new Response("", { status: 204 });
  }

  // Layer 1 — resolve the connection (and tenant) via the opaque webhook token.
  const conn = await getConnectionByWebhookToken("twilio", token);
  if (!conn) {
    return new Response("forbidden", { status: 403 });
  }
  const secrets = (conn.secrets ?? {}) as Partial<TwilioSecrets>;
  const authToken = secrets.authToken ?? "";

  // Layer 2 — verify the official X-Twilio-Signature. When the connection has an
  // auth token (every live connection does), the signature is REQUIRED, built over
  // the canonical configured origin (never the request Host).
  if (authToken) {
    const signature = request.headers.get("x-twilio-signature");
    if (!signature) return new Response("forbidden", { status: 403 });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const callbackUrl = `${appUrl}/api/messaging/webhook/twilio/${token}`;
    const expected = twilioSignature(authToken, callbackUrl, paramMap);
    if (!timingSafeEqualStr(signature, expected)) {
      return new Response("forbidden", { status: 403 });
    }
  }

  // Resolve the outbound message and confirm it belongs to the token's tenant.
  const message = await findMessageByProviderId("twilio", messageSid);
  if (!message || message.tenantId !== conn.tenantId) {
    // Unknown / cross-tenant message: ack no-op (Twilio expects 2xx).
    return new Response("", { status: 204 });
  }

  const mappedStatus = mapTwilioStatus(messageStatus);
  const dedupKey = `${messageSid}:${messageStatus}`;

  const isNew = await recordMessageEvent({
    tenantId: message.tenantId,
    messageId: message.id,
    provider: "twilio",
    eventType: `status:${messageStatus}`,
    mappedStatus,
    dedupKey,
    eventTs: null,
    raw: paramMap,
  });

  if (isNew) {
    await advanceMessageStatus(message.id, mappedStatus, null);
  }

  return new Response("", { status: 204 });
}
