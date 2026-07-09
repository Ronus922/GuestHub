"use server";

import { sql } from "@/lib/db";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { enqueueChannelJob, logChannelError } from "./queue";
import { CHANNEX_BASE_URLS } from "./config";
import { decryptSecret, channelSecretsConfigured } from "./crypto";
import { isAmbiguous, type ChannexApiFailure, type ChannexApiErrorCategory } from "./channex-http";
import { listChannexRatePlans, createChannexRatePlan, type ChannexRatePlan } from "./channex-rate-plans";
import {
  buildComboPlan,
  buildRatePlanTitle,
  buildOccupancyOptions,
  buildCreateRatePlanPayload,
  ratePlanJobKey,
  ratePlanSyncJobKey,
  SELL_MODE,
  RATE_MODE,
  type ComboPlan,
  type LocalRatePlan,
  type RatePlanRoom,
  type RateMapping,
} from "./rate-plan-sync";

// ============================================================
// Channex Staging — (PHYSICAL ROOM × LOCAL RATE PLAN) → Rate Plan sync (D65).
// super_admin ONLY, enforced server-side on EVERY action. The local GuestHub
// Rate Plan is never duplicated locally; it fans out to one external Channex
// Rate Plan per mapped physical room (each Channex Rate Plan belongs to one
// Room Type = one physical room, D64).
//
// Hard invariants:
//  • NO external Rate Plan is ever created on page load, refresh, connection
//    test, deploy, migration or test run. Creation happens only inside
//    startChannexRatePlanSyncAction, which the operator triggers explicitly.
//  • Every created plan is stop-sold on all 7 weekdays with zero placeholder
//    rates — nothing becomes sellable before the first verified ARI snapshot.
//  • NO real price, availability, restriction push, OTA connection, webhook,
//    booking or cancellation-policy mapping is issued; DELETE/PUT never called.
//  • NO GuestHub room / rate plan / price / policy / reservation is written.
//  • An AMBIGUOUS external result is never blindly re-POSTed.
//  • The api-key is decrypted per call, never returned, logged or audited.
// ============================================================

const CHANNEX_ENV = "staging" as const;
const PROVIDER = "channex" as const;

const RUN_BUDGET_MS = 25_000;
const CREATE_TIMEOUT_MS = 15_000;
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
  console.error("[channex-rate-plans]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

const apiFail = (f: ChannexApiFailure): { success: false; error: string } => ({
  success: false,
  error: f.message,
});

// ---- connection / credential (same seam as room-type-admin) ----

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

// The local Rate Plan entity for channel purposes: a TENANT-scoped pricing plan
// (sellable_unit_id IS NULL). The per-unit "מחיר בסיס" rows are the internal
// pricing substrate, never a channel Rate Plan. Eligibility (active, not
// archived, visible to channels) is decided in the pure module. Validity dates
// govern bookable nights, not the plan's existence — a plan whose window starts
// tomorrow is still synchronized today.
async function loadLocalPlans(tenantId: string): Promise<LocalRatePlan[]> {
  return sql<LocalRatePlan[]>`
    SELECT id, name, is_active, is_archived, is_visible_channels
    FROM guesthub.pricing_plans
    WHERE tenant_id = ${tenantId} AND sellable_unit_id IS NULL`;
}

async function loadRooms(tenantId: string, connectionId: string): Promise<RatePlanRoom[]> {
  const rows = await sql<
    {
      room_id: string;
      room_number: string;
      is_active: boolean;
      included_occupancy: number | null;
      mapping_status: string | null;
      channex_room_type_id: string | null;
      occ_adults: string | null;
    }[]
  >`
    SELECT r.id AS room_id, r.room_number, r.is_active, r.included_occupancy,
           m.status AS mapping_status, m.channex_room_type_id,
           m.snapshot->>'occ_adults' AS occ_adults
    FROM guesthub.rooms r
    LEFT JOIN guesthub.channel_room_mappings m
      ON m.room_id = r.id AND m.connection_id = ${connectionId}
    WHERE r.tenant_id = ${tenantId}`;
  return rows.map((r) => {
    const occ = r.occ_adults === null ? NaN : Number(r.occ_adults);
    return {
      roomId: r.room_id,
      roomNumber: r.room_number,
      isActive: r.is_active,
      includedOccupancy: r.included_occupancy,
      mappingStatus: r.mapping_status,
      channexRoomTypeId: r.channex_room_type_id,
      roomTypeOccAdults: Number.isInteger(occ) && occ > 0 ? occ : null,
    };
  });
}

async function loadRateMappings(connectionId: string): Promise<RateMapping[]> {
  return sql<RateMapping[]>`
    SELECT room_id, local_rate_plan_id, channex_rate_plan_id, status
    FROM guesthub.channel_room_rate_mappings
    WHERE connection_id = ${connectionId}`;
}

async function loadCurrency(tenantId: string): Promise<string> {
  const [row] = await sql<{ currency: string | null }[]>`
    SELECT currency FROM guesthub.tenants WHERE id = ${tenantId}`;
  return row?.currency || "ILS";
}

async function isRunActive(connectionId: string, propertyId: string | null): Promise<boolean> {
  if (!propertyId) return false;
  const [row] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM guesthub.channel_sync_jobs
    WHERE connection_id = ${connectionId}
      AND idempotency_key = ${ratePlanSyncJobKey(propertyId)}
      AND status IN ('queued','processing','retry_wait')
      AND COALESCE(locked_at, created_at) >= now() - make_interval(mins => ${STALE_RUN_MINUTES})`;
  return (row?.n ?? 0) > 0;
}

// ---- 1) read-only context (page load — NO network call, NO write) ----

export type RatePlanSyncContext = {
  connected: boolean;
  configured: boolean; // secrets key + api key + mapped property all present
  environment: "staging";
  /** eligible local plan names ("ללא דמי ביטול") — empty when none */
  planNames: string[];
  mappedRooms: number;
  activeRooms: number;
  requiredCombinations: number;
  mappedCombinations: number;
  creatable: number;
  /** combos needing attention — rendered only when non-empty */
  problems: { roomNumber: string; planName: string; message: string }[];
  running: boolean;
};

export async function getChannexRatePlanSyncContextAction(): Promise<Result<RatePlanSyncContext>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    const empty: RatePlanSyncContext = {
      connected: false,
      configured: false,
      environment: CHANNEX_ENV,
      planNames: [],
      mappedRooms: 0,
      activeRooms: 0,
      requiredCombinations: 0,
      mappedCombinations: 0,
      creatable: 0,
      problems: [],
      running: false,
    };
    if (!conn) return { success: true, data: empty };

    const [plans, rooms, rateMappings, running] = await Promise.all([
      loadLocalPlans(actor.tenantId),
      loadRooms(actor.tenantId, conn.id),
      loadRateMappings(conn.id),
      isRunActive(conn.id, conn.channex_property_id),
    ]);
    const plan = buildComboPlan({ plans, rooms, rateMappings });

    const failedRows = plan.rows.filter(
      (r) => r.status === "failed" || r.status === "reconciliation_required" || r.validationError,
    );
    return {
      success: true,
      data: {
        connected: true,
        configured:
          channelSecretsConfigured() && !!conn.api_key_ciphertext && !!conn.channex_property_id,
        environment: CHANNEX_ENV,
        planNames: [...new Set(plan.rows.map((r) => r.localRatePlanName))],
        mappedRooms: plan.summary.mappedRooms,
        activeRooms: rooms.filter((r) => r.isActive).length,
        requiredCombinations: plan.summary.requiredCombinations,
        mappedCombinations: plan.summary.mappedCombinations,
        creatable: plan.summary.creatable,
        problems: failedRows.map((r) => ({
          roomNumber: r.roomNumber,
          planName: r.localRatePlanName,
          message: r.validationError ?? "היצירה נכשלה — ניתן לנסות שוב",
        })),
        running,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// The ONLY conditions under which a POST run may start. Channex does NOT reject
// duplicate titles, so an unmapped external Rate Plan is the one thing that
// could turn a create run into silent duplication — it blocks, always.
function blockReason(plan: ComboPlan, truncated: boolean, externalUnmapped: ChannexRatePlan[]): string | null {
  if (truncated)
    return "רשימת תוכניות התעריף ב-Channex ארוכה מהצפוי ולא נקראה במלואה — לא ניתן לוודא שאין כפילויות";
  if (externalUnmapped.length > 0)
    return `נמצאו ${externalUnmapped.length} תוכניות תעריף ב-Channex שאינן ממופות — יש לטפל בהן לפני יצירה`;
  if (plan.summary.reconciliationRequired > 0)
    return `${plan.summary.reconciliationRequired} שילובים ממתינים להתאמה מחדש — נסה שוב מאוחר יותר`;
  if (plan.summary.creatable === 0)
    return plan.summary.mappedCombinations > 0 ? "כל תוכניות התעריף כבר נוצרו" : "אין שילובים תקינים ליצירה";
  return null;
}

// ---- 2) the real synchronization — the ONE creation site ----
// Durable, deduplicated, sequential, resumable. Creates ONE Channex Rate Plan
// per (eligible local plan × mapped active room), stop-sold, zero placeholder
// rates, no real prices, no availability, no restrictions, no OTA mapping.

export type RatePlanRunResult = {
  created: number;
  failed: number;
  skipped: number;
  remaining: number;
  stopped: "budget" | "ambiguous" | null;
  partial: boolean;
};

type ItemFail = { category: ChannexApiErrorCategory; message: string };

export async function startChannexRatePlanSyncAction(): Promise<Result<RatePlanRunResult>> {
  let parentJobId: string | null = null; // hoisted so the catch can settle it
  try {
    const actor = await requireChannelAdmin();
    const ready = await requireReady(actor.tenantId);
    if ("error" in ready) return { success: false, error: ready.error };
    const { conn, propertyId, apiKey } = ready;
    const baseUrl = CHANNEX_BASE_URLS.staging;

    // (a) durable run mutex FIRST (double-click / concurrent request safe).
    // Everything after this — the external listing, the ambiguity clearing and
    // every POST — runs strictly under the mutex, so a second click can never
    // race an active run's in-flight state.
    const parentKey = ratePlanSyncJobKey(propertyId);
    const claim = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`channex:rp_sync:${actor.tenantId}:${CHANNEX_ENV}`}))`;
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
        jobType: "sync_rate_plans",
        priority: 10,
        idempotencyKey: parentKey,
        payload: { propertyId, environment: CHANNEX_ENV },
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

    // (b) refresh the external truth BEFORE anything is created
    const listed = await listChannexRatePlans({ apiKey, baseUrl, propertyId });
    if (!listed.ok) {
      await settleJobFailed(parentJobId, listed.category, listed.message);
      return apiFail(listed);
    }

    // A COMPLETE listing is positive proof of what exists upstream. Combos left
    // ambiguous by a timeout whose external id is unknown and which no external
    // plan accounts for were NOT created — flip them back to retryable so the
    // single button self-heals. Rows that carry an external id are never
    // cleared this way.
    const mappedExternalIds = await sql<{ channex_rate_plan_id: string }[]>`
      SELECT channex_rate_plan_id FROM guesthub.channel_room_rate_mappings
      WHERE connection_id = ${conn.id} AND channex_rate_plan_id IS NOT NULL`;
    const known = new Set(mappedExternalIds.map((m) => m.channex_rate_plan_id));
    const externalUnmapped = listed.ratePlans.filter((rp) => !known.has(rp.id));
    if (!listed.truncated && externalUnmapped.length === 0) {
      await sql`
        UPDATE guesthub.channel_room_rate_mappings
        SET status = 'failed', last_error_code = 'not_created',
            last_error = 'לא נוצר ב-Channex — ניתן לנסות שוב', updated_by = ${actor.userId}
        WHERE connection_id = ${conn.id}
          AND channex_rate_plan_id IS NULL
          AND status IN ('creating','reconciliation_required')`;
    }

    const [plans, rooms, rateMappings, currency] = await Promise.all([
      loadLocalPlans(actor.tenantId),
      loadRooms(actor.tenantId, conn.id),
      loadRateMappings(conn.id),
      loadCurrency(actor.tenantId),
    ]);
    const plan = buildComboPlan({ plans, rooms, rateMappings });

    const blocked = blockReason(plan, listed.truncated, externalUnmapped);
    if (blocked) {
      await settleJobFailed(parentJobId, "blocked", blocked);
      return { success: false, error: blocked };
    }

    const auditCtx = await auditRequestContext();
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "rate_plan_sync_requested",
      after: {
        environment: CHANNEX_ENV,
        propertyId,
        requiredCombinations: plan.summary.requiredCombinations,
        alreadyMapped: plan.summary.mappedCombinations,
        toCreate: plan.summary.creatable,
        sellMode: SELL_MODE,
        rateMode: RATE_MODE,
        currency,
      },
      ip: auditCtx.ip,
      session: auditCtx.session,
    });

    // (c) per-combination, sequential, bounded
    const candidates = plan.rows.filter((r) => r.creatable);
    const roomById = new Map(rooms.map((r) => [r.roomId, r]));
    const t0 = Date.now();
    const run: RatePlanRunResult = { created: 0, failed: 0, skipped: 0, remaining: 0, stopped: null, partial: false };

    for (const row of candidates) {
      if (Date.now() - t0 > RUN_BUDGET_MS) {
        run.stopped = "budget";
        break;
      }
      const room = roomById.get(row.roomId);
      const title = buildRatePlanTitle(row.roomNumber, row.localRatePlanName);
      const occ =
        room && room.roomTypeOccAdults !== null
          ? buildOccupancyOptions(room.roomTypeOccAdults, room.includedOccupancy)
          : ({ ok: false } as const);
      if (!room || !room.channexRoomTypeId || !title.ok || !occ.ok) {
        run.skipped++;
        continue;
      }

      // (c1) RESERVE: advisory lock + re-check the mapping + durable item job,
      // all in one transaction. The persisted 'creating' row is the reservation.
      // No DB transaction is held across the network call.
      const jobKey = ratePlanJobKey(propertyId, row.localRatePlanId, row.roomId);
      const reserved = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`channex:rate_plan:${actor.tenantId}:${CHANNEX_ENV}:${row.localRatePlanId}:${row.roomId}`}))`;
        // Reap an item job stranded by a crashed run — otherwise it sits inside
        // the idempotency partial index and permanently bricks this combination.
        await tx`
          UPDATE guesthub.channel_sync_jobs
          SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL,
              last_error_code = 'abandoned', last_error_message = 'ריצת יצירה קודמת נקטעה'
          WHERE connection_id = ${conn.id}
            AND idempotency_key = ${jobKey}
            AND status IN ('queued','processing','retry_wait')
            AND COALESCE(locked_at, created_at) < now() - make_interval(mins => ${STALE_RUN_MINUTES})`;
        const [existing] = await tx<{ status: string }[]>`
          SELECT status FROM guesthub.channel_room_rate_mappings
          WHERE connection_id = ${conn.id} AND room_id = ${row.roomId}
            AND local_rate_plan_id = ${row.localRatePlanId} FOR UPDATE`;
        if (existing && existing.status !== "failed") return null; // mapped / creating / reconciliation
        const enq = await enqueueChannelJob(tx, {
          tenantId: actor.tenantId,
          connectionId: conn.id,
          jobType: "create_rate_plan",
          idempotencyKey: jobKey,
          payload: {
            propertyId,
            roomId: row.roomId,
            roomNumber: row.roomNumber,
            localRatePlanId: row.localRatePlanId,
            environment: CHANNEX_ENV,
          },
        });
        if ("duplicate" in enq) return null; // another run owns this combination
        await tx`
          UPDATE guesthub.channel_sync_jobs
          SET status = 'processing', locked_at = now(), locked_by = ${`sync:${actor.userId}`}, started_at = now()
          WHERE id = ${enq.id}`;
        await tx`
          INSERT INTO guesthub.channel_room_rate_mappings
            (tenant_id, connection_id, channex_property_id, local_rate_plan_id, room_id,
             channel_room_mapping_id, room_number, channex_room_type_id,
             sell_mode, rate_mode, currency, status, created_by, updated_by)
          VALUES (${actor.tenantId}, ${conn.id}, ${propertyId}, ${row.localRatePlanId}, ${row.roomId},
                  (SELECT id FROM guesthub.channel_room_mappings
                   WHERE connection_id = ${conn.id} AND room_id = ${row.roomId}),
                  ${row.roomNumber}, ${room.channexRoomTypeId},
                  ${SELL_MODE}, ${RATE_MODE}, ${currency}, 'creating', ${actor.userId}, ${actor.userId})
          ON CONFLICT (connection_id, room_id, local_rate_plan_id) DO UPDATE SET
            status = 'creating', channex_property_id = ${propertyId},
            channex_room_type_id = ${room.channexRoomTypeId},
            last_error = NULL, last_error_code = NULL, updated_by = ${actor.userId}`;
        return enq.id;
      });
      if (!reserved) {
        run.skipped++;
        continue;
      }
      const jobId = reserved;

      // (c2) the ONE external write of this milestone: structure only —
      // stop-sold on all 7 weekdays, zero placeholder rates, no fees.
      const created = await createChannexRatePlan({
        apiKey,
        baseUrl,
        timeoutMs: CREATE_TIMEOUT_MS,
        payload: buildCreateRatePlanPayload({
          propertyId,
          roomTypeId: room.channexRoomTypeId,
          title: title.title,
          currency,
          options: occ.options,
        }),
      });

      if (created.ok) {
        // Persist the external UUID in the DURABLE JOB RESULT first, so a
        // failing local mapping write can never lose the created entity.
        await sql`
          UPDATE guesthub.channel_sync_jobs SET provider_task_id = ${created.ratePlan.id} WHERE id = ${jobId}`;
        try {
          await sql.begin(async (tx) => {
            await tx`
              UPDATE guesthub.channel_room_rate_mappings
              SET channex_rate_plan_id = ${created.ratePlan.id},
                  channex_title = ${created.ratePlan.title ?? title.title},
                  status = 'mapped', method = 'created', external_state = 'ok',
                  snapshot = ${sql.json(externalSnapshot(created.ratePlan) as never)},
                  last_verified_at = now(), last_error = NULL, last_error_code = NULL,
                  updated_by = ${actor.userId}
              WHERE connection_id = ${conn.id} AND room_id = ${row.roomId}
                AND local_rate_plan_id = ${row.localRatePlanId}`;
            await tx`
              UPDATE guesthub.channel_sync_jobs
              SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL
              WHERE id = ${jobId}`;
          });
        } catch (dbErr) {
          // External success, local failure. The entity EXISTS upstream and its
          // id is on the job row. Never re-POST — surface for explicit recovery.
          console.error("[channex-rate-plans] local mapping write failed after 201", dbErr);
          await markReconciliation(conn.id, row.roomId, row.localRatePlanId, "local_write_failed", actor.userId);
          await settleJobFailed(jobId, "local_write_failed", "כתיבת המיפוי המקומי נכשלה לאחר יצירה ב-Channex");
          await logChannelError(sql, {
            tenantId: actor.tenantId,
            connectionId: conn.id,
            jobId,
            code: "local_write_failed",
            message: "Channex created the rate plan but the local mapping write failed",
            context: { roomId: row.roomId, localRatePlanId: row.localRatePlanId, channexRatePlanId: created.ratePlan.id },
          });
          await auditReconciliation(actor, auditCtx, conn.id, propertyId, row, {
            reason: "local_write_failed",
            channexRatePlanId: created.ratePlan.id,
          });
          run.failed++;
          run.stopped = "ambiguous";
          break;
        }
        // committed: genuinely mapped. Audit is best-effort only — it must never
        // reclassify a committed success.
        run.created++;
        try {
          await writeAudit(actor, {
            entityType: "channel_room_rate_mapping",
            entityId: null,
            action: "channex_rate_plan_created",
            after: {
              environment: CHANNEX_ENV,
              propertyId,
              roomId: row.roomId,
              roomNumber: row.roomNumber,
              localRatePlanId: row.localRatePlanId,
              channexRatePlanId: created.ratePlan.id,
              title: title.title,
              sellMode: SELL_MODE,
              rateMode: RATE_MODE,
              currency,
              stopSell: true,
            },
            ip: auditCtx.ip,
            session: auditCtx.session,
          });
        } catch (auditErr) {
          console.error("[channex-rate-plans] audit after successful create failed (mapping committed)", auditErr);
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
        context: { roomId: row.roomId, roomNumber: row.roomNumber, localRatePlanId: row.localRatePlanId },
      });

      if (isAmbiguous(f.category)) {
        // The rate plan may or may not exist upstream. Do NOT retry, do NOT
        // continue — a second ambiguous write would compound the damage. The
        // next run's complete external listing resolves it.
        await markReconciliation(conn.id, row.roomId, row.localRatePlanId, f.category, actor.userId);
        await auditReconciliation(actor, auditCtx, conn.id, propertyId, row, { reason: f.category });
        run.failed++;
        run.stopped = "ambiguous";
        break;
      }

      // definite, combination-scoped failure (404/409/422) — record and continue
      await sql`
        UPDATE guesthub.channel_room_rate_mappings
        SET status = 'failed', last_error_code = ${f.category}, last_error = ${f.message},
            updated_by = ${actor.userId}
        WHERE connection_id = ${conn.id} AND room_id = ${row.roomId}
          AND local_rate_plan_id = ${row.localRatePlanId}`;
      await writeAudit(actor, {
        entityType: "channel_room_rate_mapping",
        entityId: null,
        action: "channex_rate_plan_create_failed",
        after: {
          environment: CHANNEX_ENV,
          propertyId,
          roomId: row.roomId,
          roomNumber: row.roomNumber,
          localRatePlanId: row.localRatePlanId,
          category: f.category,
        },
        ip: auditCtx.ip,
        session: auditCtx.session,
      });
      run.failed++;
      // A rejected credential will reject every remaining combination — stop early.
      if (f.category === "unauthorized" || f.category === "forbidden") {
        run.stopped = "ambiguous";
        break;
      }
    }

    // (d) close the parent job + report honestly
    const after = await loadRateMappings(conn.id);
    const mappedNow = new Set(
      after.filter((m) => m.status === "mapped").map((m) => `${m.room_id}:${m.local_rate_plan_id}`),
    );
    run.remaining = plan.rows.filter((r) => !mappedNow.has(`${r.roomId}:${r.localRatePlanId}`)).length;
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
      action: run.partial ? "rate_plan_sync_partially_completed" : "rate_plan_sync_completed",
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
    // 'processing', blocking new runs for the whole stale window.
    if (parentJobId) {
      try {
        await settleJobFailed(parentJobId, "run_error", "הריצה נעצרה עקב שגיאה — ניתן להמשיך");
      } catch (settleErr) {
        console.error("[channex-rate-plans] failed to settle parent job after run error", settleErr);
      }
    }
    return failFrom(e);
  }
}

// Safe, whitelisted snapshot — never a raw upstream body.
function externalSnapshot(rp: ChannexRatePlan): Record<string, unknown> {
  return {
    title: rp.title,
    sell_mode: rp.sellMode,
    rate_mode: rp.rateMode,
    currency: rp.currency,
    options: rp.options.map((o) => ({ occupancy: o.occupancy, is_primary: o.isPrimary, rate: o.rate })),
    room_type_id: rp.roomTypeId,
  };
}

async function settleJobFailed(jobId: string, code: string, message: string): Promise<void> {
  await sql`
    UPDATE guesthub.channel_sync_jobs
    SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL,
        last_error_code = ${code}, last_error_message = ${message}
    WHERE id = ${jobId}`;
}

async function markReconciliation(
  connectionId: string,
  roomId: string,
  planId: string,
  code: string,
  userId: string,
): Promise<void> {
  await sql`
    UPDATE guesthub.channel_room_rate_mappings
    SET status = 'reconciliation_required', last_error_code = ${code},
        last_error = 'תוצאת היצירה אינה חד-משמעית — הריצה הבאה תבדוק מול Channex לפני ניסיון נוסף',
        updated_by = ${userId}
    WHERE connection_id = ${connectionId} AND room_id = ${roomId} AND local_rate_plan_id = ${planId}`;
}

async function auditReconciliation(
  actor: Actor,
  ctx: { ip: string | null; session: string | null },
  connectionId: string,
  propertyId: string,
  row: { roomId: string; roomNumber: string; localRatePlanId: string },
  extra: Record<string, unknown>,
): Promise<void> {
  await writeAudit(actor, {
    entityType: "channel_room_rate_mapping",
    entityId: null,
    action: "channex_rate_plan_reconciliation_required",
    after: {
      environment: CHANNEX_ENV,
      propertyId,
      connectionId,
      roomId: row.roomId,
      roomNumber: row.roomNumber,
      localRatePlanId: row.localRatePlanId,
      ...extra,
    },
    ip: ctx.ip,
    session: ctx.session,
  });
}
