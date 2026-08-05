import { NextResponse } from "next/server";
import { getConnectionByWebhookToken } from "@/lib/messaging/store";
import {
  advanceMessageStatus,
  findMessageByProviderId,
  recordMessageEvent,
} from "@/lib/messaging/messages";
import {
  insertGuestMessage,
  upsertGuestConversation,
} from "@/lib/messaging/guest-conversations";
import type { MessageStatus } from "@/lib/messaging/types";

// GREEN-API status webhook (D53). GREEN-API posts JSON status callbacks for
// outgoing messages. The [token] path segment is an OPAQUE, server-generated
// webhook token (never the predictable instance id) — it resolves the connection
// and therefore the tenant; inbound payloads are never trusted for tenant
// identity. GREEN-API does not sign requests, so the unguessable token is the
// authentication. Idempotent: recordMessageEvent dedupes, so replays never
// re-apply a status; advanceMessageStatus is monotonic.
//
// Phase 4 (076): incomingMessageReceived is now PERSISTED — before it, every
// inbound guest WhatsApp message was a silent 200-ack discard. The message
// lands in guest_conversations / guest_messages (thread key = the GREEN-API
// chatId), idempotent on idMessage. Receive-only: nothing is sent back.

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

  // Inbound guest message → persist (Phase 4). Everything else that is not an
  // outgoing status stays an acknowledged no-op, exactly as before.
  if (typeWebhook === "incomingMessageReceived") {
    return handleIncomingMessage(token, body);
  }
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

// GREEN-API incomingMessageReceived → guest_conversations / guest_messages.
// Payload shape (GREEN-API docs, probed defensively field by field):
//   idMessage, timestamp (epoch seconds), senderData: { chatId, senderName },
//   messageData: { typeMessage, textMessageData?.textMessage,
//                  extendedTextMessageData?.text, fileMessageData?.caption }
async function handleIncomingMessage(
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const idMessage = typeof body.idMessage === "string" ? body.idMessage : "";
  const senderData =
    body.senderData && typeof body.senderData === "object"
      ? (body.senderData as Record<string, unknown>)
      : null;
  const chatId = typeof senderData?.chatId === "string" ? senderData.chatId : "";
  // a payload without the two identities cannot be stored idempotently — ack
  // so GREEN-API stops retrying (a retry would carry the same defect)
  if (!idMessage || !chatId) {
    return NextResponse.json({ ok: true });
  }

  // Authenticity + routing: the opaque token must resolve to a connection.
  const conn = await getConnectionByWebhookToken("green_api", token);
  if (!conn) {
    return new Response("forbidden", { status: 403 });
  }

  const messageData =
    body.messageData && typeof body.messageData === "object"
      ? (body.messageData as Record<string, unknown>)
      : null;
  const typeMessage = typeof messageData?.typeMessage === "string" ? messageData.typeMessage : "";
  const textOf = (key: string, field: string): string | null => {
    const bag = messageData?.[key];
    if (!bag || typeof bag !== "object") return null;
    const v = (bag as Record<string, unknown>)[field];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  // text where the message carries text; a media/location/contact message
  // stores a typed placeholder (the full payload survives in raw)
  const text =
    textOf("textMessageData", "textMessage") ??
    textOf("extendedTextMessageData", "text") ??
    textOf("fileMessageData", "caption") ??
    `[${typeMessage || "message"}]`;

  const timestamp = typeof body.timestamp === "number" ? body.timestamp : null;
  const sentAt = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

  const conversationId = await upsertGuestConversation({
    tenantId: conn.tenantId,
    channel: "whatsapp",
    externalThreadKey: chatId,
  });
  await insertGuestMessage({
    tenantId: conn.tenantId,
    conversationId,
    direction: "inbound",
    provider: "green_api",
    externalMessageId: idMessage,
    body: text,
    sentAt,
    raw: body,
  });

  return NextResponse.json({ ok: true });
}
