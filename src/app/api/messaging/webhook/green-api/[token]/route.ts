import { NextResponse } from "next/server";
import { getConnectionByWebhookToken } from "@/lib/messaging/store";
import {
  advanceMessageStatus,
  findMessageByProviderId,
  recordMessageEvent,
} from "@/lib/messaging/messages";
import type { MessageStatus } from "@/lib/messaging/types";

// GREEN-API status webhook (D53). GREEN-API posts JSON status callbacks for
// outgoing messages. The [token] path segment is an OPAQUE, server-generated
// webhook token (never the predictable instance id) — it resolves the connection
// and therefore the tenant; inbound payloads are never trusted for tenant
// identity. GREEN-API does not sign requests, so the unguessable token is the
// authentication. Idempotent: recordMessageEvent dedupes, so replays never
// re-apply a status; advanceMessageStatus is monotonic.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// green-api outgoing status → our canonical honest lifecycle.
function mapGreenStatus(status: string): MessageStatus | null {
  switch (status) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
    case "noAccount":
    case "notInGroup":
      return "undelivered";
    default:
      return null;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const typeWebhook = typeof body.typeWebhook === "string" ? body.typeWebhook : "";
  // Only outgoing status webhooks carry delivery state — ignore incoming etc.
  if (typeWebhook !== "outgoingMessageStatus") {
    return NextResponse.json({ ok: true });
  }

  const idMessage = typeof body.idMessage === "string" ? body.idMessage : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!idMessage || !status) {
    return NextResponse.json({ ok: true });
  }

  // Authenticity + routing: the opaque token must resolve to a connection.
  const conn = await getConnectionByWebhookToken("green_api", token);
  if (!conn) {
    return new Response("forbidden", { status: 403 });
  }

  // Resolve the outbound message and confirm it belongs to the token's tenant.
  const message = await findMessageByProviderId("green_api", idMessage);
  if (!message || message.tenantId !== conn.tenantId) {
    // Unknown / cross-tenant message: ack so green-api stops retrying.
    return NextResponse.json({ ok: true });
  }

  const mappedStatus = mapGreenStatus(status);
  if (!mappedStatus) {
    return NextResponse.json({ ok: true });
  }

  const timestamp = typeof body.timestamp === "number" ? body.timestamp : null;
  const eventTs = timestamp ? new Date(timestamp * 1000).toISOString() : null;
  const dedupKey = `${idMessage}:${status}`;

  const isNew = await recordMessageEvent({
    tenantId: message.tenantId,
    messageId: message.id,
    provider: "green_api",
    eventType: `${typeWebhook}:${status}`,
    mappedStatus,
    dedupKey,
    eventTs,
    raw: body,
  });

  if (isNew) {
    await advanceMessageStatus(message.id, mappedStatus, eventTs);
  }

  return NextResponse.json({ ok: true });
}
