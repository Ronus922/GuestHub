"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { enqueueChannelJob, logChannelError } from "./queue";
import { CHANNEX_BASE_URLS } from "./config";
import { decryptSecret, channelSecretsConfigured } from "./crypto";
import { isAmbiguous, type ChannexApiFailure, type ChannexApiErrorCategory } from "./channex-http";
import {
  listChannexRoomTypes,
  getChannexRoomType,
  createChannexRoomType,
  type ChannexRoomType,
} from "./channex-room-types";
import {
  buildSyncPlan,
  buildCreateRoomTypePayload,
  buildRoomTypeTitle,
  deriveChannexOccupancy,
  verifyExternalRoomType,
  roomTypeJobKey,
  roomTypeSyncJobKey,
  COUNT_OF_ROOMS,
  type SyncPlan,
  type SyncRoom,
  type SyncMapping,
  type ExternalRoomType,
} from "./room-type-sync";

// ============================================================
// Channex Staging — PHYSICAL ROOM → Room Type synchronization (D64).
// super_admin ONLY, enforced server-side on EVERY action (UI hiding is not
// security). The inventory unit is the individual physical GuestHub room; the 3
// descriptive GuestHub room categories are never mapped as Channex inventory.
//
// Hard invariants:
//  • NO external Room Type is ever created on page load, refresh, connection
//    test, deploy, migration or test run. Creation happens only inside
//    startChannexRoomTypeSyncAction, which the operator triggers explicitly.
//  • NO GuestHub room / category / capacity / rate / reservation is written.
//  • NO Rate Plan, availability, restriction, OTA channel, webhook or booking
//    request is ever issued; DELETE /room_types is never called.
//  • An AMBIGUOUS external result is never blindly re-POSTed.
//  • The api-key is decrypted per call, never returned, logged or audited.
// ============================================================

const CHANNEX_ENV = "staging" as const;
const PROVIDER = "channex" as const;

// One run is bounded so a long sync can never exceed the reverse-proxy timeout.
// Everything is durable, so the operator simply resumes; only unmapped rooms run.
// ponytail: wall-clock budget beats a fixed row cap — it degrades with latency.
const RUN_BUDGET_MS = 25_000;
const CREATE_TIMEOUT_MS = 15_000;
// A parent run whose process died leaves a 'processing' job behind. After this it
// is provably abandoned (no worker exists to hold it) and a new run may take over.
const STALE_RUN_MINUTES = 10;

type Result<T = undefined> = { success: true; data?: T } | { success: false; error: string };

async function requireChannelAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  const guard = canManageChannels({ userId: actor.userId, roleKey: actor.roleKey });
  if (!guard.ok) throw new AuthorizationError(guard.error);
  return actor;
}

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error("[channex-room-types]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

const apiFail = (f: ChannexApiFailure): { success: false; error: string } => ({
  success: false,
  error: f.message,
});

const iso = (v: Date | string | null): string | null =>
  v ? (typeof v === "string" ? v : v.toISOString()) : null;

// ---- connection / credential ----

type ConnRow = {
  id: string;
  channex_property_id: string | null;
  channex_property_title: string | null;
  api_key_ciphertext: string | null;
};

async function loadConnection(tenantId: string): Promise<ConnRow | null> {
  const [row] = await sql<ConnRow[]>`
    SELECT id, channex_property_id, channex_property_title, api_key_ciphertext
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = ${PROVIDER} AND environment = ${CHANNEX_ENV}`;
  return row ?? null;
}

// Resolve everything an external call needs. The decrypted key never leaves this
// module's call stack and is never returned to the browser.
type Ready = { conn: ConnRow; propertyId: string; apiKey: string };

async function requireReady(tenantId: string): Promise<Ready | { error: string }> {
  if (!channelSecretsConfigured()) return { error: "מפתח ההצפנה CHANNEL_SECRETS_KEY אינו מוגדר בשרת" };
  const conn = await loadConnection(tenantId);
  if (!conn) return { error: "לא נמצא חיבור Channex" };
  if (!conn.channex_property_id) return { error: "לא קיים נכס Channex ממופה — יש למפות נכס תחילה" };
  if (!conn.api_key_ciphertext) return { error: "מפתח API לא הוגדר — שמור מפתח Channex תחילה" };
  let apiKey: string;
  try {
    apiKey = decryptSecret(conn.api_key_ciphertext);
  } catch {
    return { error: "פענוח המפתח נכשל — ייתכן שמפתח ההצפנה בשרת השתנה" };
  }
  return { conn, propertyId: conn.channex_property_id, apiKey };
}

// ---- DB reads (never touch the network) ----

async function loadRooms(tenantId: string): Promise<SyncRoom[]> {
  return sql<SyncRoom[]>`
    SELECT r.id, r.room_number, r.floor, r.is_active, r.status,
           a.name  AS area_name,
           rt.name AS room_type_name,
           r.max_occupancy, r.max_adults, r.max_children, r.max_infants, r.default_occupancy
    FROM guesthub.rooms r
    LEFT JOIN guesthub.areas a       ON a.id  = r.area_id
    LEFT JOIN guesthub.room_types rt ON rt.id = r.room_type_id
    WHERE r.tenant_id = ${tenantId}`;
}

type MappingRow = Omit<SyncMapping, "last_verified_at"> & { last_verified_at: Date | null };

async function loadMappings(connectionId: string): Promise<SyncMapping[]> {
  const rows = await sql<MappingRow[]>`
    SELECT room_id, channex_room_type_id, channex_title, status, method,
           external_state, last_verified_at, last_error
    FROM guesthub.channel_room_mappings
    WHERE connection_id = ${connectionId}`;
  return rows.map((r) => ({ ...r, last_verified_at: iso(r.last_verified_at) }));
}

async function countRoomCategories(tenantId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM guesthub.room_types
    WHERE tenant_id = ${tenantId} AND is_active`;
  return row?.n ?? 0;
}

// ---- 1) read-only context (page load — NO network call, NO write) ----

export type RoomSyncContext = {
  connected: boolean;
  secretsKeyConfigured: boolean;
  apiKeyConfigured: boolean;
  propertyId: string | null;
  propertyTitle: string | null;
  environment: "staging";
  plan: SyncPlan;
  /** true while a sync run holds the durable parent job */
  running: boolean;
};

export async function getChannexRoomSyncContextAction(): Promise<Result<RoomSyncContext>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    if (!conn) {
      return {
        success: true,
        data: {
          connected: false,
          secretsKeyConfigured: channelSecretsConfigured(),
          apiKeyConfigured: false,
          propertyId: null,
          propertyTitle: null,
          environment: CHANNEX_ENV,
          running: false,
          plan: buildSyncPlan({ rooms: [], mappings: [], externalRoomTypes: null, roomCategories: 0 }),
        },
      };
    }

    const [rooms, mappings, roomCategories, running] = await Promise.all([
      loadRooms(actor.tenantId),
      loadMappings(conn.id),
      countRoomCategories(actor.tenantId),
      isRunActive(conn.id, conn.channex_property_id),
    ]);

    // externalRoomTypes = null → "not fetched"; the locally-known mapped room
    // types are counted from the mappings, never guessed from Channex.
    const plan = buildSyncPlan({ rooms, mappings, externalRoomTypes: null, roomCategories });
    plan.summary.externalRoomTypes = plan.summary.mappedRooms;

    return {
      success: true,
      data: {
        connected: true,
        secretsKeyConfigured: channelSecretsConfigured(),
        apiKeyConfigured: !!conn.api_key_ciphertext,
        propertyId: conn.channex_property_id,
        propertyTitle: conn.channex_property_title,
        environment: CHANNEX_ENV,
        running,
        plan,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

async function isRunActive(connectionId: string, propertyId: string | null): Promise<boolean> {
  if (!propertyId) return false;
  const [row] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${connectionId}
      AND idempotency_key = ${roomTypeSyncJobKey(propertyId)}
      AND status IN ('queued','processing','retry_wait')
      AND COALESCE(locked_at, created_at) >= now() - make_interval(mins => ${STALE_RUN_MINUTES})`;
  return (row?.n ?? 0) > 0;
}

// ---- external fetch shared by refresh / preview / sync ----

const toExternal = (rt: ChannexRoomType): ExternalRoomType => ({
  id: rt.id,
  title: rt.title,
  countOfRooms: rt.countOfRooms,
  occAdults: rt.occAdults,
  occChildren: rt.occChildren,
  occInfants: rt.occInfants,
});

const externalSnapshot = (rt: ChannexRoomType): Record<string, unknown> => ({
  title: rt.title,
  count_of_rooms: rt.countOfRooms,
  occ_adults: rt.occAdults,
  occ_children: rt.occChildren,
  occ_infants: rt.occInfants,
  default_occupancy: rt.defaultOccupancy,
  room_kind: rt.roomKind,
});

// ---- 2) refresh + verification (§14) ----
// Fetches every Room Type of the mapped property, verifies each mapped external
// UUID, refreshes safe snapshots and last-verified timestamps, and flags entities
// that are no longer accessible. It NEVER deletes a local mapping and NEVER
// updates an external entity.

export type RefreshResult = {
  externalRoomTypes: number;
  verified: number;
  drifted: number;
  inaccessible: number;
  externalUnmapped: number;
  /** ambiguous rooms proven un-created by a complete external listing */
  cleared: number;
  truncated: boolean;
};

export async function refreshChannexRoomTypesAction(): Promise<Result<RefreshResult>> {
  try {
    const actor = await requireChannelAdmin();
    const ready = await requireReady(actor.tenantId);
    if ("error" in ready) return { success: false, error: ready.error };

    const listed = await listChannexRoomTypes({
      apiKey: ready.apiKey,
      baseUrl: CHANNEX_BASE_URLS.staging,
      propertyId: ready.propertyId,
    });
    if (!listed.ok) return apiFail(listed);

    const external = new Map(listed.roomTypes.map((rt) => [rt.id, rt]));
    const [rooms, mappings] = await Promise.all([loadRooms(actor.tenantId), loadMappings(ready.conn.id)]);
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    const auditCtx = await auditRequestContext();

    let verified = 0;
    let drifted = 0;
    let inaccessible = 0;

    for (const m of mappings) {
      if (m.status !== "mapped" || !m.channex_room_type_id) continue;
      let rt = external.get(m.channex_room_type_id) ?? null;

      // Absent from the property listing → prove it with a direct GET before
      // calling it inaccessible (it may have moved, or the list may be stale).
      if (!rt) {
        const got = await getChannexRoomType({
          apiKey: ready.apiKey,
          baseUrl: CHANNEX_BASE_URLS.staging,
          id: m.channex_room_type_id,
        });
        if (got.ok) rt = got.roomType;
        else {
          // only a definitive "gone / not yours" flips the flag; a transient
          // failure leaves the previous state untouched.
          const gone =
            got.category === "not_found" || got.category === "forbidden" || got.category === "unauthorized";
          if (gone) {
            inaccessible++;
            await sql`
              UPDATE guesthub.channel_room_mappings
              SET external_state = 'inaccessible', last_error_code = ${got.category},
                  last_error = ${got.message}, updated_by = ${actor.userId}
              WHERE connection_id = ${ready.conn.id} AND room_id = ${m.room_id}`;
            await writeAudit(actor, {
              entityType: "channel_room_mapping",
              entityId: null,
              action: "channex_room_type_verification_failed",
              after: {
                environment: CHANNEX_ENV,
                propertyId: ready.propertyId,
                roomId: m.room_id,
                channexRoomTypeId: m.channex_room_type_id,
                category: got.category,
              },
              ip: auditCtx.ip,
              session: auditCtx.session,
            });
          }
          continue;
        }
      }

      // verify title / count_of_rooms / occupancy against what GuestHub expects
      const room = roomById.get(m.room_id);
      let drift: { field: string; expected: string; actual: string }[] = [];
      if (room) {
        const title = buildRoomTypeTitle(room.room_number, room.room_type_name);
        const occ = deriveChannexOccupancy(room);
        if (title.ok && occ.ok) drift = verifyExternalRoomType({ title: title.title, occ: occ.occ }, toExternal(rt));
      }
      if (drift.length) drifted++;
      verified++;

      await sql`
        UPDATE guesthub.channel_room_mappings
        SET channex_title = ${rt.title}, snapshot = ${sql.json(externalSnapshot(rt) as never)},
            external_state = 'ok', last_verified_at = now(),
            last_error_code = ${drift.length ? "drift" : null},
            last_error = ${drift.length ? `אי-התאמה מול Channex: ${drift.map((d) => d.field).join(", ")}` : null},
            updated_by = ${actor.userId}
        WHERE connection_id = ${ready.conn.id} AND room_id = ${m.room_id}`;
    }

    const mappedIds = new Set(mappings.map((m) => m.channex_room_type_id).filter(Boolean));
    const externalUnmapped = listed.roomTypes.filter((rt) => !mappedIds.has(rt.id));

    // A COMPLETE listing (not truncated) that contains no unmapped Room Type is
    // positive proof that Channex holds nothing we do not know about. Rooms left
    // ambiguous by a timeout therefore were NOT created and become retryable.
    // Rows that already carry an external id are never cleared this way.
    let cleared = 0;
    if (!listed.truncated && externalUnmapped.length === 0) {
      const rows = await sql<{ id: string }[]>`
        UPDATE guesthub.channel_room_mappings
        SET status = 'failed', last_error_code = 'not_created',
            last_error = 'לא נוצר ב-Channex — ניתן לנסות שוב', updated_by = ${actor.userId}
        WHERE connection_id = ${ready.conn.id}
          AND channex_room_type_id IS NULL
          AND status IN ('creating','reconciliation_required')
        RETURNING id`;
      cleared = rows.length;
    }

    if (verified > 0) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: ready.conn.id,
        action: "channex_room_type_verification_succeeded",
        after: {
          environment: CHANNEX_ENV,
          propertyId: ready.propertyId,
          verified,
          drifted,
          cleared,
          externalRoomTypes: listed.roomTypes.length,
        },
        ip: auditCtx.ip,
        session: auditCtx.session,
      });
    }
    if (externalUnmapped.length > 0) {
      await writeAudit(actor, {
        entityType: "channel_connection",
        entityId: ready.conn.id,
        action: "channex_room_type_reconciliation_required",
        after: {
          environment: CHANNEX_ENV,
          propertyId: ready.propertyId,
          externalUnmapped: externalUnmapped.length,
          externalRoomTypeIds: externalUnmapped.map((e) => e.id),
        },
        ip: auditCtx.ip,
        session: auditCtx.session,
      });
    }

    return {
      success: true,
      data: {
        externalRoomTypes: listed.roomTypes.length,
        verified,
        drifted,
        inaccessible,
        externalUnmapped: externalUnmapped.length,
        cleared,
        truncated: listed.truncated,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// ---- 3) explicit preview for the confirmation modal (§10) ----
// Operator-triggered. Fetches the CURRENT external Room Types so the numbers in
// the confirmation modal are real, and audits that a preview happened. It creates
// nothing.

export type SyncPreview = {
  environment: "staging";
  propertyId: string;
  propertyTitle: string | null;
  activeRooms: number;
  alreadyMapped: number;
  toCreate: number;
  externalRoomTypes: number;
  externalUnmapped: ExternalRoomType[];
  validationErrors: number;
  countOfRooms: number; // 1, for every Room Type
  blockedReason: string | null;
  titles: { roomNumber: string; title: string }[];
};

export async function previewChannexRoomTypeSyncAction(): Promise<Result<SyncPreview>> {
  try {
    const actor = await requireChannelAdmin();
    const ready = await requireReady(actor.tenantId);
    if ("error" in ready) return { success: false, error: ready.error };

    const listed = await listChannexRoomTypes({
      apiKey: ready.apiKey,
      baseUrl: CHANNEX_BASE_URLS.staging,
      propertyId: ready.propertyId,
    });
    if (!listed.ok) return apiFail(listed);

    const [rooms, mappings, roomCategories] = await Promise.all([
      loadRooms(actor.tenantId),
      loadMappings(ready.conn.id),
      countRoomCategories(actor.tenantId),
    ]);
    const plan = buildSyncPlan({
      rooms,
      mappings,
      externalRoomTypes: listed.roomTypes.map(toExternal),
      roomCategories,
    });

    const auditCtx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: ready.conn.id,
      action: "room_type_sync_previewed",
      after: {
        environment: CHANNEX_ENV,
        propertyId: ready.propertyId,
        activeRooms: plan.summary.activeRooms,
        toCreate: plan.summary.validReady,
        externalRoomTypes: plan.summary.externalRoomTypes,
      },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });

    return {
      success: true,
      data: {
        environment: CHANNEX_ENV,
        propertyId: ready.propertyId,
        propertyTitle: ready.conn.channex_property_title,
        activeRooms: plan.summary.activeRooms,
        alreadyMapped: plan.summary.mappedRooms,
        toCreate: plan.summary.validReady,
        externalRoomTypes: plan.summary.externalRoomTypes,
        externalUnmapped: plan.externalUnmapped,
        validationErrors: plan.summary.validationErrors,
        countOfRooms: COUNT_OF_ROOMS,
        blockedReason: blockReason(plan, listed.truncated),
        titles: plan.rows
          .filter((r) => r.creatable && r.proposedTitle)
          .map((r) => ({ roomNumber: r.roomNumber, title: r.proposedTitle! })),
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// The ONLY conditions under which a POST run is allowed to start. Channex does
// NOT reject duplicate titles, so an unmapped external Room Type is the one thing
// that could turn a create run into silent duplication — it blocks, always.
function blockReason(plan: SyncPlan, truncated: boolean): string | null {
  if (truncated)
    return "רשימת סוגי החדרים ב-Channex ארוכה מהצפוי ולא נקראה במלואה — לא ניתן לוודא שאין כפילויות";
  if (plan.externalUnmapped.length > 0)
    return `נמצאו ${plan.externalUnmapped.length} סוגי חדרים ב-Channex שאינם ממופים — יש לאמץ או לטפל בהם לפני יצירה`;
  if (plan.summary.reconciliationRequired > 0)
    return `${plan.summary.reconciliationRequired} חדרים ממתינים להתאמה מחדש — יש לרענן את המצב מ-Channex`;
  if (plan.summary.validReady === 0) return "אין חדרים תקינים ליצירה";
  return null;
}

// ---- 4) the real synchronization (§12/§13) ----
// Durable, deduplicated, sequential, resumable. Creates ONE Channex Room Type per
// valid unmapped ACTIVE physical room, with count_of_rooms = 1. Pushes no
// availability, no rates, no restrictions.

export type SyncRunResult = {
  created: number;
  failed: number;
  skipped: number;
  remaining: number;
  stopped: "budget" | "ambiguous" | null;
  partial: boolean;
};

type ItemFail = { category: ChannexApiErrorCategory; message: string };

export async function startChannexRoomTypeSyncAction(): Promise<Result<SyncRunResult>> {
  let parentJobId: string | null = null; // hoisted so the catch can settle it
  try {
    const actor = await requireChannelAdmin();
    const ready = await requireReady(actor.tenantId);
    if ("error" in ready) return { success: false, error: ready.error };
    const { conn, propertyId, apiKey } = ready;
    const baseUrl = CHANNEX_BASE_URLS.staging;

    // (a) refresh the external truth BEFORE anything is created (§11/§12)
    const listed = await listChannexRoomTypes({ apiKey, baseUrl, propertyId });
    if (!listed.ok) return apiFail(listed);

    const [rooms, mappings, roomCategories] = await Promise.all([
      loadRooms(actor.tenantId),
      loadMappings(conn.id),
      countRoomCategories(actor.tenantId),
    ]);
    const plan = buildSyncPlan({
      rooms,
      mappings,
      externalRoomTypes: listed.roomTypes.map(toExternal),
      roomCategories,
    });

    const blocked = blockReason(plan, listed.truncated);
    if (blocked) return { success: false, error: blocked };

    // (b) take the durable run mutex (double-click / concurrent request safe)
    const parentKey = roomTypeSyncJobKey(propertyId);
    const claim = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`channex:rt_sync:${actor.tenantId}:${CHANNEX_ENV}`}))`;
      // an abandoned run (its process died; no worker exists to finish it) is retired
      await tx`
        UPDATE guesthub.channel_sync_jobs
        SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL,
            last_error_code = 'abandoned', last_error_message = 'ריצה קודמת נקטעה'
        WHERE connection_id = ${conn.id} AND idempotency_key = ${parentKey}
          AND status IN ('queued','processing','retry_wait')
          AND COALESCE(locked_at, created_at) < now() - make_interval(mins => ${STALE_RUN_MINUTES})`;
      const enq = await enqueueChannelJob(tx, {
        tenantId: actor.tenantId,
        connectionId: conn.id,
        jobType: "sync_room_types",
        priority: 10,
        idempotencyKey: parentKey,
        payload: { propertyId, environment: CHANNEX_ENV, candidates: plan.summary.validReady },
      });
      if ("duplicate" in enq) return null;
      await tx`
        UPDATE guesthub.channel_sync_jobs
        SET status = 'processing', locked_at = now(), locked_by = ${`sync:${actor.userId}`},
            started_at = now(), attempts = 1
        WHERE id = ${enq.id}`;
      return enq.id;
    });
    if (!claim) return { success: false, error: "סנכרון כבר פועל — המתן לסיומו" };
    parentJobId = claim;

    const auditCtx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "room_type_sync_requested",
      after: {
        environment: CHANNEX_ENV,
        propertyId,
        activeRooms: plan.summary.activeRooms,
        alreadyMapped: plan.summary.mappedRooms,
        toCreate: plan.summary.validReady,
      },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });

    // (c) per-room, sequential, bounded
    const candidates = plan.rows.filter((r) => r.creatable);
    const t0 = Date.now();
    const run: SyncRunResult = { created: 0, failed: 0, skipped: 0, remaining: 0, stopped: null, partial: false };

    for (const row of candidates) {
      if (Date.now() - t0 > RUN_BUDGET_MS) {
        run.stopped = "budget";
        break;
      }
      const room = rooms.find((r) => r.id === row.roomId)!;
      const title = buildRoomTypeTitle(room.room_number, room.room_type_name);
      const occ = deriveChannexOccupancy(room);
      if (!title.ok || !occ.ok) {
        run.skipped++;
        continue;
      }

      // (c1) RESERVE: advisory lock + re-check the local mapping + durable item
      // job, all in one transaction. The persisted 'creating' row is the
      // reservation: a concurrent run sees it and skips. No DB transaction is
      // held across the network call.
      const reserved = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`channex:room:${actor.tenantId}:${CHANNEX_ENV}:${row.roomId}`}))`;
        // Reap a previous item job stranded in 'processing'/'queued'/'retry_wait'
        // by a crashed run. Without this, the job stays inside the idempotency
        // partial index and every future enqueue for this room returns duplicate,
        // permanently bricking the room. Only a provably abandoned job (older than
        // the stale window, and we hold this room's advisory lock so no live run
        // owns it) is retired.
        await tx`
          UPDATE guesthub.channel_sync_jobs
          SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL,
              last_error_code = 'abandoned', last_error_message = 'ריצת יצירה קודמת נקטעה'
          WHERE connection_id = ${conn.id}
            AND idempotency_key = ${roomTypeJobKey(propertyId, row.roomId)}
            AND status IN ('queued','processing','retry_wait')
            AND COALESCE(locked_at, created_at) < now() - make_interval(mins => ${STALE_RUN_MINUTES})`;
        const [existing] = await tx<{ status: string }[]>`
          SELECT status FROM guesthub.channel_room_mappings
          WHERE connection_id = ${conn.id} AND room_id = ${row.roomId} FOR UPDATE`;
        if (existing && existing.status !== "failed") return null; // mapped / creating / reconciliation
        const enq = await enqueueChannelJob(tx, {
          tenantId: actor.tenantId,
          connectionId: conn.id,
          jobType: "create_room_type",
          idempotencyKey: roomTypeJobKey(propertyId, row.roomId),
          payload: { propertyId, roomId: row.roomId, roomNumber: room.room_number, environment: CHANNEX_ENV },
        });
        if ("duplicate" in enq) return null; // another run owns this room
        await tx`
          UPDATE guesthub.channel_sync_jobs
          SET status = 'processing', locked_at = now(), locked_by = ${`sync:${actor.userId}`}, started_at = now()
          WHERE id = ${enq.id}`;
        await tx`
          INSERT INTO guesthub.channel_room_mappings
            (tenant_id, connection_id, channex_property_id, room_id, room_number, status, created_by, updated_by)
          VALUES (${actor.tenantId}, ${conn.id}, ${propertyId}, ${row.roomId}, ${room.room_number},
                  'creating', ${actor.userId}, ${actor.userId})
          ON CONFLICT (connection_id, room_id) DO UPDATE SET
            status = 'creating', channex_property_id = ${propertyId},
            last_error = NULL, last_error_code = NULL, updated_by = ${actor.userId}`;
        return enq.id;
      });
      if (!reserved) {
        run.skipped++;
        continue;
      }
      const jobId = reserved;

      // (c2) the ONE external write of this milestone
      const created = await createChannexRoomType({
        apiKey,
        baseUrl,
        timeoutMs: CREATE_TIMEOUT_MS,
        payload: buildCreateRoomTypePayload(propertyId, { title: title.title, occ: occ.occ }),
      });

      if (created.ok) {
        // §13 — persist the external UUID in the DURABLE JOB RESULT first, so a
        // failing local mapping write can never lose the created entity.
        await sql`
          UPDATE guesthub.channel_sync_jobs SET provider_task_id = ${created.roomType.id} WHERE id = ${jobId}`;
        // The mapping+job commit is the ONLY thing whose failure means
        // "external success / local write failed". Once it commits, success is
        // locked in — anything after it (audit) is best-effort and must NEVER
        // reclassify the room back to reconciliation.
        try {
          await sql.begin(async (tx) => {
            await tx`
              UPDATE guesthub.channel_room_mappings
              SET channex_room_type_id = ${created.roomType.id},
                  channex_title = ${created.roomType.title ?? title.title},
                  status = 'mapped', method = 'created', external_state = 'ok',
                  snapshot = ${sql.json(externalSnapshot(created.roomType) as never)},
                  last_verified_at = now(), last_error = NULL, last_error_code = NULL,
                  updated_by = ${actor.userId}
              WHERE connection_id = ${conn.id} AND room_id = ${row.roomId}`;
            await tx`
              UPDATE guesthub.channel_sync_jobs
              SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL
              WHERE id = ${jobId}`;
          });
        } catch (dbErr) {
          // External success, local failure. The entity EXISTS upstream and its id
          // is on the job row. Never re-POST — surface it for explicit recovery.
          console.error("[channex-room-types] local mapping write failed after 201", dbErr);
          await markReconciliation(conn.id, row.roomId, "local_write_failed", actor.userId);
          await settleJobFailed(jobId, "local_write_failed", "כתיבת המיפוי המקומי נכשלה לאחר יצירה ב-Channex");
          await logChannelError(sql, {
            tenantId: actor.tenantId,
            connectionId: conn.id,
            jobId,
            code: "local_write_failed",
            message: "Channex created the room type but the local mapping write failed",
            context: { roomId: row.roomId, channexRoomTypeId: created.roomType.id },
          });
          await auditReconciliation(actor, auditCtx, conn.id, propertyId, row.roomId, room.room_number, {
            reason: "local_write_failed",
            channexRoomTypeId: created.roomType.id,
          });
          run.failed++;
          run.stopped = "ambiguous";
          break;
        }
        // committed: the room is genuinely mapped. Audit is best-effort only.
        run.created++;
        try {
          await writeAudit(actor, {
            entityType: "channel_room_mapping",
            entityId: null,
            action: "channex_room_type_created",
            after: {
              environment: CHANNEX_ENV,
              propertyId,
              roomId: row.roomId,
              roomNumber: room.room_number,
              channexRoomTypeId: created.roomType.id,
              title: title.title,
              countOfRooms: COUNT_OF_ROOMS,
            },
            ip: auditCtx.ip,
            session: auditCtx.session,
          });
        } catch (auditErr) {
          console.error("[channex-room-types] audit after successful create failed (mapping committed)", auditErr);
        }
        continue;
      }

      // (c3) the POST failed
      const f: ItemFail = { category: created.category, message: created.message };
      await settleJobFailed(jobId, f.category, f.message);
      await logChannelError(sql, {
        tenantId: actor.tenantId,
        connectionId: conn.id,
        jobId,
        code: f.category,
        message: f.message,
        context: { roomId: row.roomId, roomNumber: room.room_number },
      });

      if (isAmbiguous(f.category)) {
        // The room type may or may not exist upstream. Do NOT retry, do NOT
        // continue creating — a second ambiguous write would compound the damage.
        await markReconciliation(conn.id, row.roomId, f.category, actor.userId);
        await auditReconciliation(actor, auditCtx, conn.id, propertyId, row.roomId, room.room_number, {
          reason: f.category,
        });
        run.failed++;
        run.stopped = "ambiguous";
        break;
      }

      // definite, room-scoped failure (401/403/404/409/422) — record and continue
      await sql`
        UPDATE guesthub.channel_room_mappings
        SET status = 'failed', last_error_code = ${f.category}, last_error = ${f.message},
            updated_by = ${actor.userId}
        WHERE connection_id = ${conn.id} AND room_id = ${row.roomId}`;
      await writeAudit(actor, {
        entityType: "channel_room_mapping",
        entityId: null,
        action: "channex_room_type_create_failed",
        after: {
          environment: CHANNEX_ENV,
          propertyId,
          roomId: row.roomId,
          roomNumber: room.room_number,
          category: f.category,
        },
        ip: auditCtx.ip,
        session: auditCtx.session,
      });
      run.failed++;
      // A rejected credential will reject every remaining room too — stop early.
      if (f.category === "unauthorized" || f.category === "forbidden") {
        run.stopped = "ambiguous";
        break;
      }
    }

    // (d) close the parent job + report honestly
    const after = await loadMappings(conn.id);
    const mappedNow = new Set(after.filter((m) => m.status === "mapped").map((m) => m.room_id));
    run.remaining = plan.rows.filter((r) => r.isActive && !mappedNow.has(r.roomId)).length;
    run.partial = run.remaining > 0;

    await sql`
      UPDATE guesthub.channel_sync_jobs
      SET status = ${run.partial ? "failed" : "succeeded"}, finished_at = now(),
          locked_at = NULL, locked_by = NULL,
          last_error_code = ${run.partial ? (run.stopped ?? "partial") : null},
          last_error_message = ${run.partial ? "סנכרון חלקי — ניתן להמשיך" : null}
      WHERE id = ${parentJobId}`;

    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: run.partial ? "room_type_sync_partially_completed" : "room_type_sync_completed",
      after: {
        environment: CHANNEX_ENV,
        propertyId,
        created: run.created,
        failed: run.failed,
        skipped: run.skipped,
        remaining: run.remaining,
        stopped: run.stopped,
      },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });

    return { success: true, data: run };
  } catch (e) {
    // Any throw after the parent job was claimed would otherwise leave it
    // 'processing', blocking new runs for the whole stale window. Settle it so a
    // resume is immediate; the run is durable, so no successful room is lost.
    if (parentJobId) {
      try {
        await settleJobFailed(parentJobId, "run_error", "הריצה נעצרה עקב שגיאה — ניתן להמשיך");
      } catch (settleErr) {
        console.error("[channex-room-types] failed to settle parent job after run error", settleErr);
      }
    }
    return failFrom(e);
  }
}

async function settleJobFailed(jobId: string, code: string, message: string): Promise<void> {
  // 'failed' rather than 'retry_wait': no worker process exists, so a scheduled
  // retry would be a phantom backlog. The operator resumes explicitly.
  await sql`
    UPDATE guesthub.channel_sync_jobs
    SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL,
        last_error_code = ${code}, last_error_message = ${message}
    WHERE id = ${jobId}`;
}

async function markReconciliation(
  connectionId: string,
  roomId: string,
  code: string,
  userId: string,
): Promise<void> {
  await sql`
    UPDATE guesthub.channel_room_mappings
    SET status = 'reconciliation_required', last_error_code = ${code},
        last_error = 'תוצאת היצירה אינה חד-משמעית — יש לרענן את המצב מ-Channex לפני ניסיון נוסף',
        updated_by = ${userId}
    WHERE connection_id = ${connectionId} AND room_id = ${roomId}`;
}

async function auditReconciliation(
  actor: Actor,
  ctx: { ip: string | null; session: string | null },
  connectionId: string,
  propertyId: string,
  roomId: string,
  roomNumber: string,
  extra: Record<string, unknown>,
): Promise<void> {
  await writeAudit(actor, {
    entityType: "channel_room_mapping",
    entityId: null,
    action: "channex_room_type_reconciliation_required",
    after: { environment: CHANNEX_ENV, propertyId, roomId, roomNumber, connectionId, ...extra },
    ip: ctx.ip,
    session: ctx.session,
  });
}

// ---- 5) explicit adoption of an EXISTING external Room Type (§11) ----
// Never automatic, never by title. The external entity is verified with GET
// before it is bound, and the unique index guarantees one external Room Type can
// belong to only one physical room.

export async function adoptChannexRoomTypeAction(input: {
  roomId: string;
  channexRoomTypeId: string;
}): Promise<Result<{ roomId: string; channexRoomTypeId: string }>> {
  try {
    const actor = await requireChannelAdmin();
    const ready = await requireReady(actor.tenantId);
    if ("error" in ready) return { success: false, error: ready.error };

    const roomId = (input.roomId ?? "").trim();
    const externalId = (input.channexRoomTypeId ?? "").trim();
    if (!roomId || !externalId) return { success: false, error: "יש לבחור חדר וסוג חדר חיצוני" };

    const [room] = await sql<{ id: string; room_number: string; is_active: boolean }[]>`
      SELECT id, room_number, is_active FROM guesthub.rooms
      WHERE id = ${roomId} AND tenant_id = ${actor.tenantId}`;
    if (!room) return { success: false, error: "החדר לא נמצא" };
    if (!room.is_active) return { success: false, error: "לא ניתן לאמץ סוג חדר לחדר שאינו פעיל" };

    // verify the external Room Type with GET before adoption
    const got = await getChannexRoomType({
      apiKey: ready.apiKey,
      baseUrl: CHANNEX_BASE_URLS.staging,
      id: externalId,
    });
    if (!got.ok) return apiFail(got);
    // Fail CLOSED: adopt only when the external room type provably belongs to the
    // mapped property. A missing/unknown owner is treated as a mismatch, never
    // waved through — otherwise a null property_id would bypass the check.
    if (got.roomType.propertyId !== ready.propertyId)
      return { success: false, error: "סוג החדר אינו שייך לנכס Channex הממופה (או שלא ניתן לאמת שיוך)" };

    const auditCtx = await auditRequestContext();
    try {
      const outcome = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`channex:room:${actor.tenantId}:${CHANNEX_ENV}:${roomId}`}))`;
        const [existing] = await tx<{ status: string; channex_room_type_id: string | null }[]>`
          SELECT status, channex_room_type_id FROM guesthub.channel_room_mappings
          WHERE connection_id = ${ready.conn.id} AND room_id = ${roomId} FOR UPDATE`;
        if (existing?.channex_room_type_id) return "dup" as const;
        await tx`
          INSERT INTO guesthub.channel_room_mappings
            (tenant_id, connection_id, channex_property_id, room_id, room_number,
             channex_room_type_id, channex_title, status, method, external_state,
             snapshot, last_verified_at, created_by, updated_by)
          VALUES (${actor.tenantId}, ${ready.conn.id}, ${ready.propertyId}, ${roomId}, ${room.room_number},
                  ${got.roomType.id}, ${got.roomType.title}, 'mapped', 'adopted', 'ok',
                  ${sql.json(externalSnapshot(got.roomType) as never)}, now(),
                  ${actor.userId}, ${actor.userId})
          ON CONFLICT (connection_id, room_id) DO UPDATE SET
            channex_room_type_id = ${got.roomType.id}, channex_title = ${got.roomType.title},
            status = 'mapped', method = 'adopted', external_state = 'ok',
            snapshot = ${sql.json(externalSnapshot(got.roomType) as never)},
            last_verified_at = now(), last_error = NULL, last_error_code = NULL,
            updated_by = ${actor.userId}`;
        return "ok" as const;
      });
      if (outcome === "dup") return { success: false, error: "לחדר זה כבר קיים מיפוי" };
    } catch (e) {
      // uq_crm_channex_room_type — the external Room Type already belongs to
      // another physical room. One external entity, one local room. Always.
      if (isUniqueViolation(e))
        return { success: false, error: "סוג החדר הזה ב-Channex כבר משויך לחדר פיזי אחר" };
      throw e;
    }

    await writeAudit(actor, {
      entityType: "channel_room_mapping",
      entityId: null,
      action: "channex_room_type_adopted",
      after: {
        environment: CHANNEX_ENV,
        propertyId: ready.propertyId,
        roomId,
        roomNumber: room.room_number,
        channexRoomTypeId: got.roomType.id,
        title: got.roomType.title,
      },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });
    return { success: true, data: { roomId, channexRoomTypeId: got.roomType.id } };
  } catch (e) {
    return failFrom(e);
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}
