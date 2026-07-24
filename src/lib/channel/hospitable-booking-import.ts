import "server-only";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { decryptSecret } from "./crypto";
import { hospitableBaseUrl } from "./config";
import { asObj, asStr } from "./channex-http";
import {
  hospitableFail,
  hospitableRequest,
  mapErrorStatus,
  type HospitableApiFailure,
  type HospitableReqOpts,
} from "./hospitable-http";
import { importNormalizedRevision, type RoomResolver } from "./booking-import";
import {
  hospitableReservationIdentity,
  normalizeHospitableReservation,
  type HospitableNormalizeResult,
  type HospitablePropertyMapping,
} from "./hospitable-normalize";
import type { NormalizedRevision } from "./booking-normalize";
import { quarantineRevision } from "./revisions";
import { redactPayload } from "./payloads";
import { logChannelError } from "./queue";
import { ARI_HORIZON_DAYS } from "./ranges";
import { dispatchExternalChangeEmails } from "./external-changes";

// ============================================================
// Hospitable inbound booking import (D77) — reservations → GuestHub
// reservations through the SAME post-normalize core as Channex
// (importNormalizedRevision), with the two provider-specific halves supplied
// here: the Hospitable normalizer and a room resolver over
// channel_hospitable_property_mappings.
//
// Hospitable has NO revisions feed and NO ack endpoint (D77 §"Inbound without
// a feed"): each fetched reservation persists into channel_booking_revisions
// under a SYNTHETIC content-hash revision id
//   "{reservation_uuid}:{sha256(JSON.stringify(payload)).slice(0,16)}"
// so the existing UNIQUE (connection_id, provider_revision_id) makes a
// re-poll of an unchanged reservation a no-op (0 inserts), and any upstream
// change naturally lands as a NEW revision row → the D76 modified path. Rows
// insert pre-acknowledged (ack semantics do not exist upstream).
//
// Convergence: newly-inserted rows import immediately; a bounded sweep then
// re-imports rows still pending/quarantined/failed (crash between insert and
// import, or a mapping fixed since) — the Hospitable analogue of the Channex
// feed re-serving unacknowledged revisions every pull.
// ============================================================

export type HospitableInboundConnection = {
  id: string;
  tenant_id: string;
  api_key_ciphertext: string;
};

export type HospitableInboundPullSummary = {
  fetched: number;
  inserted: number;
  imported: number;
  quarantined: number;
  failed: number;
  /** sanitized error messages (bounded) — never an upstream body */
  errors: string[];
};

const PER_PAGE = 100; // Hospitable maximum
const MAX_PAGES = 50; // hard bound — never an unbounded pagination loop
const LOOKBACK_DAYS = 30;
// forward horizon = the one horizon the channel layer speaks (ranges.ts) —
// Hospitable reservations beyond it are picked up as the window advances
const FORWARD_DAYS = ARI_HORIZON_DAYS;
const SWEEP_LIMIT = 200;
const MAX_ERRORS = 20;

export function hospitableInboundCreds(conn: HospitableInboundConnection): HospitableReqOpts {
  return {
    token: decryptSecret(conn.api_key_ciphertext),
    baseUrl: hospitableBaseUrl(),
  };
}

// Mirror of loadInboundConnections (booking-import.ts) for the hospitable
// provider — the worker's provider dispatch seam (D77) selects by these.
export async function loadHospitableInboundConnections(
  db: Sql,
): Promise<HospitableInboundConnection[]> {
  return db<HospitableInboundConnection[]>`
    SELECT id, tenant_id, api_key_ciphertext
    FROM guesthub.channel_connections
    WHERE provider = 'hospitable' AND is_active_provider = true
      AND state IN ('ready', 'active')
      AND inbound_sync_enabled = true AND api_key_ciphertext IS NOT NULL`;
}

// ---------------------------------------------------------------
// reservations client (mirrors channex-bookings.ts style: envelope-only
// validation here, payloads handed onward verbatim)
// ---------------------------------------------------------------

type ReservationsPage = {
  ok: true;
  reservations: unknown[];
  /** meta.last_page when the envelope carries one (Laravel-style pagination) */
  lastPage: number | null;
};

async function fetchReservationsPage(
  opts: HospitableReqOpts,
  propertyIds: string[],
  startDate: string,
  endDate: string,
  page: number,
): Promise<ReservationsPage | HospitableApiFailure> {
  const properties = propertyIds
    .map((id) => `properties[]=${encodeURIComponent(id)}`)
    .join("&");
  const path =
    `/reservations?${properties}` +
    `&start_date=${startDate}&end_date=${endDate}` +
    `&include=guest,financials&page=${page}&per_page=${PER_PAGE}`;
  const res = await hospitableRequest({ ...opts, method: "GET", path });
  if ("ok" in res) return res;
  if (res.status !== 200) return hospitableFail(mapErrorStatus(res.status), res.status);
  const root = asObj(res.body);
  if (!root || !Array.isArray(root.data)) return hospitableFail("bad_response", res.status);
  const meta = asObj(root.meta);
  const lastPage =
    meta && typeof meta.last_page === "number" && Number.isFinite(meta.last_page)
      ? meta.last_page
      : null;
  return { ok: true, reservations: root.data, lastPage };
}

async function fetchReservation(
  opts: HospitableReqOpts,
  reservationUuid: string,
): Promise<{ ok: true; reservation: unknown } | HospitableApiFailure> {
  const res = await hospitableRequest({
    ...opts,
    method: "GET",
    path: `/reservations/${encodeURIComponent(reservationUuid)}?include=guest,financials`,
  });
  if ("ok" in res) return res;
  if (res.status !== 200) return hospitableFail(mapErrorStatus(res.status), res.status);
  const root = asObj(res.body);
  // { data: {...} } envelope, defensively accepting a bare resource body
  const data = asObj(root?.data) ?? (root && asStr(root.id) ? root : null);
  if (!data) return hospitableFail("bad_response", res.status);
  return { ok: true, reservation: data };
}

// ---------------------------------------------------------------
// persistence — synthetic revision rows, pre-acknowledged
// ---------------------------------------------------------------

export function hospitableRevisionId(reservationUuid: string, payload: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `${reservationUuid}:${digest.slice(0, 16)}`;
}

// Idempotent insert (mirror of persistBookingRevision, revisions.ts) with the
// Hospitable differences: ack columns pre-set (no ack semantics upstream) and
// NO card staging — Hospitable payloads carry no card data (guest payments are
// platform-collected). The stored payload is still redacted for hygiene.
async function insertRevisionRow(
  db: Sql,
  conn: HospitableInboundConnection,
  rev: {
    providerBookingId: string;
    providerRevisionId: string;
    uniqueId: string | null;
    otaReservationCode: string | null;
    otaName: string | null;
    revisionKind: "new" | "modified" | "cancelled";
    rawStatus: string | null;
    payload: unknown;
  },
): Promise<string | null> {
  const rows = await db<{ id: string }[]>`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id,
       unique_id, ota_reservation_code, ota_name, revision_kind, raw_status,
       payload, import_status, ack_status, acknowledged_at)
    VALUES
      (${conn.tenant_id}, ${conn.id}, ${rev.providerBookingId}, ${rev.providerRevisionId},
       ${rev.uniqueId}, ${rev.otaReservationCode}, ${rev.otaName},
       ${rev.revisionKind}, ${rev.rawStatus},
       ${db.json(redactPayload(rev.payload) as never)},
       'pending', 'acknowledged', now())
    ON CONFLICT (connection_id, provider_revision_id) DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------
// import — normalize (provider half) → shared core
// ---------------------------------------------------------------

function propertyRoomResolver(
  conn: HospitableInboundConnection,
): RoomResolver {
  return async (db, room) => {
    // the room's channexRoomTypeId slot carries the Hospitable property uuid
    // (in-memory convention, hospitable-normalize.ts)
    const [mapping] = await db<{ room_id: string }[]>`
      SELECT room_id FROM guesthub.channel_hospitable_property_mappings
      WHERE connection_id = ${conn.id}
        AND hospitable_property_id = ${room.channexRoomTypeId}
        AND status = 'mapped'`;
    return mapping
      ? { roomId: mapping.room_id }
      : { error: `נכס Hospitable ללא מיפוי לחדר מקומי (${room.channexRoomTypeId.slice(0, 8)}…)` };
  };
}

function pushError(summary: HospitableInboundPullSummary, message: string): void {
  if (summary.errors.length < MAX_ERRORS) summary.errors.push(message);
}

// Import ONE persisted revision row through the shared core. The Hospitable
// property-ownership guard lives HERE (mirror of the Channex wrong-property
// rejection in importRevisionRow): a reservation whose property uuid has no
// 'mapped' row in channel_hospitable_property_mappings is visibly parked and
// recorded — never imported into this tenant.
async function importRevisionRowHospitable(
  db: Sql,
  conn: HospitableInboundConnection,
  resolveRoom: RoomResolver,
  mappings: ReadonlyMap<string, HospitablePropertyMapping>,
  row: { id: string; provider_revision_id: string; payload: unknown },
  summary: HospitableInboundPullSummary,
  preNormalized?: HospitableNormalizeResult,
): Promise<void> {
  const norm = preNormalized ?? normalizeHospitableReservation(row.payload, mappings);
  if (!norm.ok) {
    await quarantineRevision(db, row.id, norm.error);
    if (norm.unmappedPropertyId) {
      await logChannelError(db, {
        tenantId: conn.tenant_id,
        connectionId: conn.id,
        code: "unmapped_property",
        message: norm.error,
        context: {
          revision_id: row.provider_revision_id,
          hospitable_property_id: norm.unmappedPropertyId,
        },
      });
    }
    summary.quarantined += 1;
    pushError(summary, norm.error);
    return;
  }

  // the durable row's synthetic id becomes the revision identity everywhere
  // downstream (external_revision_id, audits, date-change records)
  const normalized: NormalizedRevision = {
    ...norm.value,
    revisionId: row.provider_revision_id,
  };
  const outcome = await importNormalizedRevision(db, conn, row.id, normalized, { resolveRoom });
  if (outcome.status === "imported" || outcome.status === "already") {
    summary.imported += 1;
  } else if (outcome.status === "quarantined") {
    summary.quarantined += 1;
    pushError(summary, outcome.reason);
  } else {
    summary.failed += 1;
    pushError(summary, outcome.error);
  }
}

async function processReservation(
  db: Sql,
  conn: HospitableInboundConnection,
  resolveRoom: RoomResolver,
  mappings: ReadonlyMap<string, HospitablePropertyMapping>,
  payload: unknown,
  summary: HospitableInboundPullSummary,
  processedRowIds: Set<string>,
): Promise<void> {
  const identity = hospitableReservationIdentity(payload);
  if (!identity.reservationUuid) {
    // no reservation identity at all — nothing durable can be keyed to it
    summary.failed += 1;
    const message = "הזמנה מ-Hospitable ללא מזהה — לא ניתן לשמור";
    pushError(summary, message);
    await logChannelError(db, {
      tenantId: conn.tenant_id,
      connectionId: conn.id,
      code: "inbound_normalize_failed",
      message,
    });
    return;
  }

  const providerRevisionId = hospitableRevisionId(identity.reservationUuid, payload);
  const norm = normalizeHospitableReservation(payload, mappings);
  const rowId = await insertRevisionRow(db, conn, {
    providerBookingId: identity.reservationUuid,
    providerRevisionId,
    uniqueId: norm.ok ? norm.value.uniqueId : null,
    otaReservationCode: norm.ok ? norm.value.otaReservationCode : identity.otaReservationCode,
    otaName: norm.ok ? norm.value.otaName : identity.otaName,
    revisionKind: norm.ok ? norm.value.kind : "new",
    rawStatus: identity.rawStatus,
    payload,
  });
  if (!rowId) return; // duplicate — unchanged reservation, idempotent no-op

  summary.inserted += 1;
  processedRowIds.add(rowId);
  await importRevisionRowHospitable(
    db,
    conn,
    resolveRoom,
    mappings,
    { id: rowId, provider_revision_id: providerRevisionId, payload },
    summary,
    norm,
  );
}

// Bounded convergence sweep — rows still pending (crash between insert and
// import), quarantined (mapping may have been fixed) or failed (transient),
// excluding rows already processed this run. Re-normalizes from the STORED
// redacted payload, exactly like the Channex importRevisionRow does.
async function sweepUnimportedRows(
  db: Sql,
  conn: HospitableInboundConnection,
  resolveRoom: RoomResolver,
  mappings: ReadonlyMap<string, HospitablePropertyMapping>,
  summary: HospitableInboundPullSummary,
  processedRowIds: Set<string>,
): Promise<void> {
  const rows = await db<{ id: string; provider_revision_id: string; payload: unknown }[]>`
    SELECT id, provider_revision_id, payload
    FROM guesthub.channel_booking_revisions
    WHERE connection_id = ${conn.id}
      AND import_status IN ('pending', 'quarantined', 'failed')
    ORDER BY created_at
    LIMIT ${SWEEP_LIMIT}`;
  for (const row of rows) {
    if (processedRowIds.has(row.id)) continue;
    await importRevisionRowHospitable(db, conn, resolveRoom, mappings, row, summary);
  }
}

async function loadPropertyMappings(
  db: Sql,
  conn: HospitableInboundConnection,
): Promise<Map<string, HospitablePropertyMapping>> {
  const rows = await db<{ hospitable_property_id: string; room_id: string }[]>`
    SELECT hospitable_property_id, room_id
    FROM guesthub.channel_hospitable_property_mappings
    WHERE connection_id = ${conn.id} AND status = 'mapped'`;
  return new Map(rows.map((r) => [r.hospitable_property_id, { roomId: r.room_id }]));
}

const isoDate = (msFromToday: number): string =>
  new Date(Date.now() + msFromToday).toISOString().slice(0, 10);

// ---------------------------------------------------------------
// the pull — GET → persist (synthetic id) → import via the shared core
// ---------------------------------------------------------------

export async function runHospitableInboundPull(
  db: Sql,
  conn: HospitableInboundConnection,
  opts?: { reservationUuid?: string },
): Promise<HospitableInboundPullSummary> {
  const summary: HospitableInboundPullSummary = {
    fetched: 0,
    inserted: 0,
    imported: 0,
    quarantined: 0,
    failed: 0,
    errors: [],
  };
  const creds = hospitableInboundCreds(conn);
  const mappings = await loadPropertyMappings(db, conn);
  const resolveRoom = propertyRoomResolver(conn);
  const processedRowIds = new Set<string>();

  if (mappings.size === 0) {
    // without a single mapped property, nothing can import — and a
    // properties[]-less list call would pull the whole account
    pushError(summary, "אין נכסי Hospitable ממופים לחיבור זה");
    return summary;
  }

  let windowPull = !opts?.reservationUuid;
  if (opts?.reservationUuid) {
    // webhook fast-path: ONE named reservation through the SAME pipeline
    const res = await fetchReservation(creds, opts.reservationUuid);
    if (!res.ok) {
      if (res.category === "not_found") {
        // A webhook-supplied uuid that 404s is likely NOT a reservation id at
        // all (event uuid probed by mistake). Fall through to the full window
        // pull — the correctness backstop — instead of retrying a wrong uuid
        // to dead-letter.
        windowPull = true;
      } else {
        pushError(summary, res.message);
        return summary;
      }
    } else {
      summary.fetched = 1;
      await processReservation(db, conn, resolveRoom, mappings, res.reservation, summary, processedRowIds);
    }
  }
  if (windowPull) {
    const startDate = isoDate(-LOOKBACK_DAYS * 86_400_000);
    const endDate = isoDate(FORWARD_DAYS * 86_400_000);
    const propertyIds = [...mappings.keys()];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetchReservationsPage(creds, propertyIds, startDate, endDate, page);
      if (!res.ok) {
        pushError(summary, res.message);
        break;
      }
      for (const reservation of res.reservations) {
        summary.fetched += 1;
        await processReservation(db, conn, resolveRoom, mappings, reservation, summary, processedRowIds);
      }
      const exhausted =
        res.reservations.length < PER_PAGE || (res.lastPage !== null && page >= res.lastPage);
      if (exhausted) break;
    }
  }

  await sweepUnimportedRows(db, conn, resolveRoom, mappings, summary, processedRowIds);

  // ops emails for external date changes — strictly AFTER the import
  // transactions committed (same placement as the Channex pull); a mail
  // failure never fails the pull.
  try {
    await dispatchExternalChangeEmails(db, conn.tenant_id);
  } catch (e) {
    pushError(summary, e instanceof Error ? e.message : "שליחת התראות המייל נכשלה");
  }

  if (summary.imported > 0) {
    await db`
      UPDATE guesthub.channel_connections SET last_inbound_import_at = now()
      WHERE id = ${conn.id}`;
  }
  return summary;
}
