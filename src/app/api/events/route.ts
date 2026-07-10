import { getActor } from "@/lib/auth/actor";
import { subscribeTenantEvents } from "@/lib/realtime/hub";

// ============================================================
// GET /api/events — tenant-scoped SSE stream (D77 §6).
//
// Auth: the session cookie resolves to an actor; the stream is bound to
// actor.tenantId server-side (the client cannot choose a tenant). Payloads
// are the whitelisted DomainEvent shape only — ids, rooms, dates, lifecycle;
// never guest/card/token data (encodeDomainEvent has no such fields).
//
// nginx: proxy_buffering is ON for this vhost — X-Accel-Buffering:no disables
// it per-response; the ≤25s heartbeat stays far inside proxy_read_timeout
// (300s) so an idle stream is never severed.
// ============================================================

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
// bounded stream lifetime: auth is checked at connect; closing periodically
// forces the browser's automatic reconnect through a FRESH auth check, so a
// deactivated/logged-out user stops receiving events within this window
const MAX_STREAM_MS = 10 * 60_000;

export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor) return new Response("unauthorized", { status: 401 });
  const tenantId = actor.tenantId;

  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
        }
      };
      send(`retry: 3000\n\n: connected\n\n`);
      const unsubscribe = subscribeTenantEvents(tenantId, (event) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => send(`: hb\n\n`), HEARTBEAT_MS);
      let cleaned = false; // teardown fires via BOTH abort and cancel — once only
      const lifetime = setTimeout(() => cleanup(), MAX_STREAM_MS);
      cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        open = false;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
