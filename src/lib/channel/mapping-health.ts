import "server-only";
import type { Sql } from "postgres";
import { logChannelError } from "./queue";

// ============================================================
// Room-mapping audit (B5.2) — a room that reaches no channel must SAY SO.
//
// THE SILENCE THIS EXISTS TO BREAK. Three layers of the inbound path are gated
// on `channel_beds24_room_mappings … status = 'mapped'`, and NONE of them ever
// told anybody when the gate closed:
//
//   1. `loadRoomMappings` builds the pull's snapshot from mapped rows only, and
//      `runBeds24InboundPull` returns at `mappings.size === 0` before importing
//      a single revision — so ONE broken mapping does not merely lose one
//      room's cancellations, it can stop the whole pull.
//   2. `loadBeds24InboundConnections` carries the same EXISTS filter (comment
//      "review W-1"). A connection whose every room got unmapped is therefore
//      not polled at all — `ensureInboundPullJobs` skips it AND
//      `ensureReconcileJobs` skips it. No job, no failure, no dead letter, no
//      row in channel_sync_errors. Total silence, by construction. That filter
//      traded retry noise for blindness and nothing replaced the noise.
//   3. Outbound ARI is scoped to mapped rooms too, so an unmapped room's
//      availability never leaves the building.
//
// Measured on production 2026-07-25: 14 of 16 rooms mapped (all to Beds24
// property 342449). Room "1318" — a genuinely sold room carrying back-office
// reservations — has no live mapping, and no surface in the product said so.
//
// WHY IT DOES NOT CRY WOLF. Room "חניה זמנית" also has no mapping, and that is
// CORRECT — it is a parking pseudo-room. Absence of a mapping is not evidence
// of intent, exactly as D93 ruled that absence of a booking from a provider
// response is not evidence of cancellation. Intent is therefore explicit:
// `rooms.channel_distribution_excluded` (migration 057). Excluded rooms are
// counted and reported in the summary but never alerted on.
//
// WHERE IT SURFACES. `channel_sync_errors` — the SAME mechanism D93 uses for
// `cancelled_at_source_checked_in` / `cancellation_reconciled`, read back by
// `getChannelStatusAction` for the /channels diagnostics screen. No second
// alerting mechanism was invented.
//
// WHY IT SELF-RESOLVES. This runs hourly. Re-inserting a row per sweep would
// bury the operator's ten-row error panel within half a day, so the audit is
// a reconciliation, not an append: one open row per (code, room) while the
// defect lasts, and `resolved_at` stamped the moment it clears.
// ============================================================

/** The connection shape the audit needs — deliberately NOT
 *  Beds24InboundConnection: that type comes from a loader whose own mapping
 *  filter is half the bug. */
export type ChannelAuditConnection = { id: string; tenant_id: string };

export const MAPPING_ALERT_CODES = [
  /** an active, distribution-expected room has no mapping row at all */
  "room_mapping_missing",
  /** a mapping row exists but its status is not 'mapped' (unmapped/quarantined) */
  "room_mapping_broken",
  /** not one mapped room is left on the connection — the inbound path is inert */
  "channel_mappings_empty",
] as const;

export type MappingAlertCode = (typeof MAPPING_ALERT_CODES)[number];

export type RoomDistributionRow = {
  room_id: string;
  room_number: string;
  room_name: string | null;
  is_active: boolean;
  status: string;
  channel_distribution_excluded: boolean;
  /** null = no mapping row for this (connection, room) at all */
  mapping_status: string | null;
};

export type ChannelMappingAuditSummary = {
  rooms: number;
  /** rooms the audit expects to find distributed */
  expected: number;
  mapped: number;
  missing: number;
  broken: number;
  /** deliberately not distributed — reported, never alerted */
  excluded: number;
  /** the connection has zero mapped rooms → nothing polls it any more */
  inert: boolean;
  raised: number;
  resolved: number;
};

// ---------------------------------------------------------------
// THE CENTRAL PREDICATE
// ---------------------------------------------------------------
/**
 * Does this room's mapping state constitute a defect, and which one?
 *
 * `null` means "nothing to report" and comes in three flavours that are NOT
 * interchangeable:
 *   · the room is mapped                    → healthy
 *   · the room is out of service            → not expected to be distributed
 *   · the operator excluded it deliberately → intent, recorded in the schema
 *
 * A room is expected to be distributed unless something explicit says
 * otherwise. Defaulting the other way is what let room 1318 sit unmapped and
 * unremarked.
 */
export function classifyRoomDistribution(room: RoomDistributionRow): MappingAlertCode | null {
  // Explicit operator intent wins over everything (migration 057). This is the
  // ONLY thing that makes "חניה זמנית" quiet while "1318" stays loud — the two
  // rooms are indistinguishable by mapping state alone.
  if (room.channel_distribution_excluded) return null;

  // Out of service: `is_active = false` and `status = 'inactive'` are both
  // deliberate "this room is not in the inventory" markers. 'out_of_order' is
  // NOT one of them — that is a temporary physical block and the room must
  // still be mapped, or it silently drops off the channel while it is repaired.
  if (!room.is_active || room.status === "inactive") return null;

  if (room.mapping_status === null) return "room_mapping_missing";
  if (room.mapping_status !== "mapped") return "room_mapping_broken";
  return null;
}

/** The alert text an operator reads. Kept beside the predicate so a new code
 *  cannot be added without a message. */
function alertMessage(code: MappingAlertCode, room?: RoomDistributionRow): string {
  const label = room ? `${room.room_number}${room.room_name ? ` (${room.room_name})` : ""}` : "";
  switch (code) {
    case "room_mapping_missing":
      return `חדר ${label} אינו ממופה ל-Beds24 — הזמינות שלו לא מגיעה לאף ערוץ ואף הזמנה חיצונית עבורו לא תיקלט. אם החדר אינו מיועד להפצה, סמן אותו כ"לא מופץ לערוצים".`;
    case "room_mapping_broken":
      return `מיפוי החדר ${label} ל-Beds24 נמצא במצב "${room?.mapping_status ?? "?"}" ולא "mapped" — החדר מחוץ למשיכת ההזמנות ומחוץ ל-ARI היוצא.`;
    case "channel_mappings_empty":
      return `לחיבור Beds24 לא נותר אף חדר ממופה — משיכת ההזמנות והפיוס המחזורי מפסיקים לרוץ לגמרי (החיבור נושר מ-loadBeds24InboundConnections). אף ביטול ואף הזמנה חיצונית לא ייקלטו עד שיוחזר מיפוי.`;
  }
}

/**
 * Connections the audit sweeps.
 *
 * DO NOT reuse `loadBeds24InboundConnections` here, however tempting: it
 * requires an EXISTS over mapped rooms, so the connection this audit most
 * needs to inspect — the one with nothing left mapped — is precisely the one
 * that loader hides. Outbound-only connections are included as well: an
 * unmapped room stops publishing ARI even when nothing is imported.
 */
export async function loadChannelAuditConnections(db: Sql): Promise<ChannelAuditConnection[]> {
  return db<ChannelAuditConnection[]>`
    SELECT id, tenant_id
    FROM guesthub.channel_connections
    WHERE provider = 'beds24'
      AND is_active_provider = true
      AND state IN ('ready', 'active')
      AND (inbound_sync_enabled = true OR outbound_sync_enabled = true)
    ORDER BY created_at`;
}

/** Stable identity of one open alert: the code plus the room it is about
 *  (empty for the connection-level one). */
const alertKey = (code: MappingAlertCode, roomId: string | null) => `${code}:${roomId ?? ""}`;

export async function runChannelMappingAudit(
  db: Sql,
  conn: ChannelAuditConnection,
): Promise<ChannelMappingAuditSummary> {
  const summary: ChannelMappingAuditSummary = {
    rooms: 0, expected: 0, mapped: 0, missing: 0, broken: 0,
    excluded: 0, inert: false, raised: 0, resolved: 0,
  };

  const rooms = await db<RoomDistributionRow[]>`
    SELECT r.id                            AS room_id,
           r.room_number                   AS room_number,
           r.name                          AS room_name,
           r.is_active                     AS is_active,
           r.status                        AS status,
           r.channel_distribution_excluded AS channel_distribution_excluded,
           m.status                        AS mapping_status
    FROM guesthub.rooms r
    LEFT JOIN guesthub.channel_beds24_room_mappings m
           ON m.room_id = r.id
          AND m.connection_id = ${conn.id}
          AND m.tenant_id = r.tenant_id
    WHERE r.tenant_id = ${conn.tenant_id}
    ORDER BY r.room_number`;

  // ---- 1. classify ----
  const defects = new Map<string, { code: MappingAlertCode; room?: RoomDistributionRow }>();
  for (const room of rooms) {
    summary.rooms += 1;
    if (room.channel_distribution_excluded) summary.excluded += 1;
    if (room.mapping_status === "mapped") summary.mapped += 1;

    const code = classifyRoomDistribution(room);
    if (code === null) continue;
    summary.expected += 1;
    if (code === "room_mapping_missing") summary.missing += 1;
    if (code === "room_mapping_broken") summary.broken += 1;
    defects.set(alertKey(code, room.room_id), { code, room });
  }
  // a healthy mapped room is expected to be distributed too — count it once the
  // defect loop is done so `expected` reads as "rooms that must be distributed"
  summary.expected += summary.mapped;

  // ---- 2. the connection-level defect ----
  // Zero mapped rooms is not "n missing rooms"; it is a different failure with
  // a different blast radius — the connection stops being polled at all, so
  // even the D93 reconciliation that would catch a stale cancellation never
  // runs. It gets its own code so the operator sees the pipeline is dark, not
  // merely that some rooms are unmapped.
  if (summary.mapped === 0 && rooms.length > 0) {
    summary.inert = true;
    defects.set(alertKey("channel_mappings_empty", null), { code: "channel_mappings_empty" });
  }

  // ---- 3. reconcile the open alerts against the defects found now ----
  const open = await db<{ id: string; error_code: string; room_id: string | null }[]>`
    SELECT id, error_code, context->>'room_id' AS room_id
    FROM guesthub.channel_sync_errors
    WHERE tenant_id = ${conn.tenant_id}
      AND connection_id = ${conn.id}
      AND resolved_at IS NULL
      AND error_code = ANY(${MAPPING_ALERT_CODES as unknown as string[]})`;

  const openKeys = new Set(open.map((r) => `${r.error_code}:${r.room_id ?? ""}`));

  for (const [key, defect] of defects) {
    if (openKeys.has(key)) continue; // already on the operator's surface
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: defect.code,
      message: alertMessage(defect.code, defect.room),
      context: {
        room_id: defect.room?.room_id ?? null,
        room_number: defect.room?.room_number ?? null,
        mapping_status: defect.room?.mapping_status ?? null,
        mapped_rooms: summary.mapped,
      },
    });
    summary.raised += 1;
  }

  const staleIds = open
    .filter((r) => !defects.has(`${r.error_code}:${r.room_id ?? ""}`))
    .map((r) => r.id);
  if (staleIds.length > 0) {
    await db`
      UPDATE guesthub.channel_sync_errors
      SET resolved_at = now()
      WHERE id = ANY(${staleIds})`;
    summary.resolved = staleIds.length;
  }

  return summary;
}
