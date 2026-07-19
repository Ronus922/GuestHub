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
// bounded: keys are attacker-supplied — an unauthenticated spray of random
// tokens must not grow this map forever
const MAX_TRACKED_KEYS = 5_000;
const hits = new Map<string, { windowStart: number; count: number }>();

// Hospitable webhook bodies carry the reservation, but the shape is not
// contractual — the uuid is probed defensively at the few observed paths and
// validated as a UUID. A miss is fine: the job runs as a full window pull.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hospitableReservationUuid(body: Record<string, unknown>): string | null {
  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const data = obj(body.data);
  const candidates = [
    data?.uuid,
    obj(body.reservation)?.uuid,
    obj(data?.reservation)?.uuid,
    obj(data?.reservation)?.id,
    data?.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && UUID_RE.test(c)) return c;
  }
  return null;
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.windowStart > WINDOW_MS) {
    if (hits.size >= MAX_TRACKED_KEYS) hits.clear();
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

  // The token authenticates a specific validated, inbound-enabled connection.
  // Stored hashed only; while nothing is enabled this is always a 404 — the
  // endpoint does not exist as far as the outside world can tell, and no
  // tenant/existence oracle leaks. 'ready' is accepted for the D77 read-first
  // rollout (hospitable inbound before the write-scope Full Sync); Channex
  // rows can only be inbound-enabled at 'active', so its gate is unchanged.
  const [conn] = await sql<{ id: string; tenant_id: string; provider: string }[]>`
    SELECT id, tenant_id, provider FROM guesthub.channel_connections
    WHERE webhook_token_hash = ${sha256Hex(token)}
      AND state IN ('ready', 'active') AND inbound_sync_enabled = true
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
  // Hospitable only (D77): the reservation uuid rides the pull job's payload
  // so the worker can take the single-reservation fast path. Channex jobs are
  // enqueued exactly as before (empty payload).
  const reservationUuid =
    conn.provider === "hospitable" ? hospitableReservationUuid(body) : null;

  // Persist redacted (§Z) + dedupe + enqueue in ONE transaction (D77 §3):
  // the event row and its pull job commit together, so a crash between them
  // can no longer strand a deduped event with no job (Channex's retry would
  // hit the dedup row and the booking would wait for the fallback poll).
  // Priority 20 = ahead of routine polls (40) and drains (50) — a webhook is
  // the live signal. The enqueue's pg_notify wakes the worker on commit.
  try {
    const duplicate = await sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO guesthub.channel_webhook_events
          (tenant_id, connection_id, event_type, dedup_key, payload, status)
        VALUES (${conn.tenant_id}, ${conn.id}, ${eventType}, ${dedupKey},
                ${tx.json(redactPayload(body) as never)}, 'enqueued')
        ON CONFLICT (connection_id, dedup_key) DO NOTHING
        RETURNING id`;
      if (inserted.length === 0) return true;
      await enqueueChannelJob(tx, {
        tenantId: conn.tenant_id,
        connectionId: conn.id,
        jobType: "pull_booking_revisions",
        priority: 20,
        payload: reservationUuid ? { reservation_uuid: reservationUuid } : undefined,
        idempotencyKey: `pull:${conn.id}:${dedupKey}`,
      });
      return false;
    });
    return NextResponse.json(duplicate ? { ok: true, duplicate: true } : { ok: true });
  } catch (e) {
    // sanitized 5xx → Channex retries; the tx rolled back atomically
    console.error("[channel-webhook]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "temporary failure" }, { status: 503 });
  }
}
