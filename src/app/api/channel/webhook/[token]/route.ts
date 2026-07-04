import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { sha256Hex } from "@/lib/channel/crypto";
import { redactPayload } from "@/lib/channel/payloads";
import { enqueueChannelJob } from "@/lib/channel/queue";

// ============================================================
// Webhook endpoint CONTRACT (§Y) — prepared, not activated. No webhook is
// registered with Channex and no connection can be active in Phase 3, so
// every request 404s before touching anything. Future flow (on activation):
// authenticate by per-connection token → persist redacted event → dedupe →
// enqueue a pull job → return fast. Processing is always async; this route
// never mutates bookings directly.
// ============================================================

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

// ponytail: in-memory fixed-window rate limit per token; move to a shared
// store if the app ever runs multi-process inbound webhooks.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const hits = new Map<string, { windowStart: number; count: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.windowStart > WINDOW_MS) {
    hits.set(key, { windowStart: now, count: 1 });
    return false;
  }
  h.count += 1;
  return h.count > MAX_PER_WINDOW;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || token.length < 20 || rateLimited(token)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // The token authenticates a specific ACTIVE, inbound-enabled connection.
  // Stored hashed only; while nothing is active (all of Phase 3) this is
  // always a 404 — the endpoint does not exist as far as the outside world
  // can tell, and no tenant/existence oracle leaks.
  const [conn] = await sql<{ id: string; tenant_id: string }[]>`
    SELECT id, tenant_id FROM guesthub.channel_connections
    WHERE webhook_token_hash = ${sha256Hex(token)}
      AND state = 'active' AND inbound_sync_enabled = true
    LIMIT 1`;
  if (!conn) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const eventType = String(body.event ?? body.event_type ?? "unknown");
  // dedupe by the provider event id when present, else by body hash
  const dedupKey = String(body.event_id ?? body.id ?? sha256Hex(raw));

  // persist redacted (§Z) + dedupe + enqueue, then return quickly (§Y)
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO guesthub.channel_webhook_events
      (tenant_id, connection_id, event_type, dedup_key, payload, status)
    VALUES (${conn.tenant_id}, ${conn.id}, ${eventType}, ${dedupKey},
            ${sql.json(redactPayload(body) as never)}, 'enqueued')
    ON CONFLICT (connection_id, dedup_key) DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  await enqueueChannelJob(sql, {
    tenantId: conn.tenant_id,
    connectionId: conn.id,
    jobType: "pull_booking_revisions",
    idempotencyKey: `pull:${conn.id}:${dedupKey}`,
  });

  return NextResponse.json({ ok: true });
}
