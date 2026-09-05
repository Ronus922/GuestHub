import "server-only";
import { sql } from "@/lib/db";
import { channelHealth, type ChannelHealthVerdict, type HealthChannel } from "./channel-health";

// The ONE query that feeds the channel-health rule (D173). The dashboard KPI
// and the failure-streak alert both read through here, so the two can never
// disagree about what the last send was.
//
// The window is the newest HEALTH_WINDOW_ROWS counted rows; a streak longer
// than that reports the window's length. `now` comes from the DATABASE, the
// same clock that wrote submitted_at/updated_at.

export const HEALTH_WINDOW_ROWS = 200;

type Row = {
  id: string;
  status: string;
  error_code: string | null;
  final_error_category: string | null;
  provider: string;
  at_ms: number;
  now_ms: number;
};

export async function loadChannelHealth(tenantId: string, channel: HealthChannel): Promise<ChannelHealthVerdict> {
  const rows = await sql<Row[]>`
    SELECT id, status, error_code, final_error_category, provider,
           (extract(epoch FROM COALESCE(submitted_at, updated_at)) * 1000)::float8 AS at_ms,
           (extract(epoch FROM now()) * 1000)::float8 AS now_ms
      FROM guesthub.outbound_messages
     WHERE tenant_id = ${tenantId} AND channel = ${channel}
       AND status IN ('submitted', 'sent', 'delivered', 'read', 'failed')
     ORDER BY COALESCE(submitted_at, updated_at) DESC
     LIMIT ${HEALTH_WINDOW_ROWS}`;
  const nowMs = rows.length > 0 ? Number(rows[0].now_ms) : Date.now();
  return channelHealth(
    channel,
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      errorCode: r.error_code,
      finalErrorCategory: r.final_error_category,
      provider: r.provider,
      atMs: Number(r.at_ms),
    })),
    nowMs,
  );
}
