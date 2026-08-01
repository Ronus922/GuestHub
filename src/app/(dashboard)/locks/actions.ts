"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActor, requirePermission, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { sql } from "@/lib/db";
import { syncLocks } from "@/lib/ttlock/locks";
import {
  syncPasscodes, rotateApartmentCode, maskCode, TTLockNoGatewayError,
} from "@/lib/ttlock/passcodes";
import { TTLockNotConfiguredError } from "@/lib/ttlock/token";
import { TTLockError, hebrewMessageFor } from "@/lib/ttlock/http";
import { ttlockSecretsConfigured } from "@/lib/ttlock/crypto";
import type { ActionResult } from "../calendar/types";
import type {
  LocksScreenView, LockView, LockRoomView, PasscodeView,
  SyncLocksSummary, SyncPasscodesSummary, RotateCodeResult,
} from "./types";

// ============================================================
// /locks Server Actions (D123).
//
// TWO PERMISSIONS, NOT ONE. Reading the board is `locks.view`; changing a
// mapping or pulling from upstream is `locks.map`. They are separate because
// they will diverge: PART 2 adds code issuing behind `locks.rotate`, and a role
// that may watch the board is not automatically a role that may re-point a door
// at a different apartment.
//
// NO CREDENTIAL, NO TOKEN, NO UPSTREAM BODY may enter an audit payload, a log,
// an error message or a return value — the same line 069's actions hold. The
// access token never even appears in this file: syncLocks resolves it inside
// its own frame and it dies there.
// ============================================================

const NOT_CONFIGURED_HE =
  "חיבור TTLock טרם הוגדר. יש להגדיר אותו במסך ההגדרות, בכרטיס “מנעולים חכמים · TTLock”, ואז לחזור לכאן";
const SECRETS_KEY_MISSING = "מפתח ההצפנה TTLOCK_SECRETS_KEY אינו מוגדר בשרת";

const uuid = z.string().uuid("מזהה שגוי");
const mapSchema = z.object({ lockId: uuid, roomId: uuid });

async function requireLocks(permission: "locks.view" | "locks.map" | "locks.rotate"): Promise<Actor> {
  const actor = await getActor();
  requirePermission(actor, permission);
  return actor;
}

/**
 * Error → Hebrew. A TTLockError is translated by CODE ONLY: hebrewMessageFor
 * never echoes the upstream errmsg, which is Chinese and, for 10001, actively
 * misleading about which half of the credential is wrong.
 */
function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  if (e instanceof TTLockNotConfiguredError) return { success: false, error: NOT_CONFIGURED_HE };
  // Already a Hebrew sentence about the hardware, not an upstream string.
  if (e instanceof TTLockNoGatewayError) return { success: false, error: e.message };
  if (e instanceof TTLockError) return { success: false, error: hebrewMessageFor(e.errcode) };
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

// Audit payloads carry ids, aliases and room numbers — the operator's own data.
// Never a secret, never a token, never a fragment of an upstream response, and
// — since D124 — never a full passcode. A rotation audits maskCode(), which is
// two digits: enough to match a row against what the operator was told, useless
// to anybody who reads the audit trail looking for a way in. Rule 11 fails the
// build if a full code ever reaches this function.
async function audit(
  actor: Actor,
  action: string,
  entityId: string | null,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
  entityType: "ttlock_lock" | "ttlock_passcode" = "ttlock_lock",
): Promise<void> {
  const ctx = await auditRequestContext();
  await writeAudit(actor, {
    entityType,
    entityId,
    action,
    before,
    after,
    ip: ctx.ip,
    session: ctx.session,
  });
}

type LockRow = {
  id: string;
  ttlock_lock_id: string;
  alias: string;
  battery: number | null;
  synced_at: string | null;
  missing_since: string | null;
  room_id: string | null;
  room_number: string | null;
  room_name: string | null;
  room_floor: string | null;
  can_rotate: boolean;
};

type PasscodeRow = {
  lock_id: string;
  role: string;
  code: string;
  state: string;
  updated_at: string | null;
  last_error: string | null;
};

/**
 * The whole board in one read: this tenant's locks with their rooms, plus every
 * ACTIVE room so the screen can show which doors are not covered yet.
 *
 * The uncovered-room set is derived on the client from these two lists rather
 * than sent as a third — one source, no chance of the counts disagreeing.
 */
export async function listLocksAction(): Promise<ActionResult<LocksScreenView>> {
  try {
    const actor = await requireLocks("locks.view");

    const [connection] = await sql<{ configured: boolean }[]>`
      SELECT (secret_ciphertext IS NOT NULL) AS configured
      FROM guesthub.ttlock_connections
      WHERE tenant_id = ${actor.tenantId}`;

    const [lockRows, roomRows, codeRows] = await Promise.all([
      sql<LockRow[]>`
        SELECT l.id,
               l.ttlock_lock_id::text AS ttlock_lock_id,
               l.alias,
               l.battery,
               l.synced_at::text     AS synced_at,
               l.missing_since::text AS missing_since,
               l.room_id,
               r.room_number AS room_number,
               r.name        AS room_name,
               r.floor       AS room_floor,
               -- no gateway, no remote code push: the button is disabled with a
               -- sentence rather than left to fail against the hardware.
               COALESCE((l.raw->>'hasGateway')::int, 0) = 1 AS can_rotate
        FROM guesthub.ttlock_locks l
        LEFT JOIN guesthub.rooms r ON r.id = l.room_id AND r.tenant_id = l.tenant_id
        WHERE l.tenant_id = ${actor.tenantId}
        ORDER BY l.alias ASC`,
      sql<{ id: string; room_number: string; name: string | null; floor: string | null }[]>`
        SELECT id, room_number, name, floor
        FROM guesthub.rooms
        WHERE tenant_id = ${actor.tenantId} AND is_active = true
        ORDER BY sort_order ASC, room_number ASC`,
      // EVERY live code, not one per role — the picking happens below in TS.
      //
      // A DISTINCT ON here looked equivalent and was not. It returns the
      // newest ACTIVE code and drops the rest, so a rotation whose delete
      // failed — the exact case the outbox exists for — would show the new
      // code and silently hide the superseded one that still opens the door.
      // The real-DB exercise produced that state and caught it.
      sql<PasscodeRow[]>`
        SELECT lock_id, role, code, state,
               updated_at::text AS updated_at,
               last_error
        FROM guesthub.ttlock_passcodes
        WHERE tenant_id = ${actor.tenantId}
          AND role IN ('apartment', 'manager')
          AND state IN ('active', 'rotating', 'revoking', 'missing')
        ORDER BY lock_id, role,
                 CASE state WHEN 'active' THEN 0 WHEN 'rotating' THEN 1 WHEN 'revoking' THEN 2 ELSE 3 END,
                 updated_at DESC`,
    ]);

    const toPasscode = (r: PasscodeRow | undefined): PasscodeView | null =>
      r ? { code: r.code, state: r.state, updatedAt: r.updated_at, lastError: r.last_error } : null;

    // A code the guest could type in RIGHT NOW. 'revoking' counts: the delete
    // has not landed, so the digits still work.
    const isLive = (r: PasscodeRow) => r.state === "active" || r.state === "revoking";

    const locks: LockView[] = lockRows.map((l) => {
      const mine = codeRows.filter((c) => c.lock_id === l.id);
      // The query's ORDER BY already puts the current one first.
      const apartment = mine.find((c) => c.role === "apartment");
      const superseded = mine
        .filter((c) => c.role === "apartment" && c !== apartment && isLive(c))
        .map((c) => c.code.slice(-2));

      return {
        id: l.id,
        ttlockLockId: l.ttlock_lock_id,
        alias: l.alias,
        battery: l.battery,
        room:
          l.room_id && l.room_number
            ? { roomId: l.room_id, roomNumber: l.room_number, name: l.room_name, floor: l.room_floor }
            : null,
        syncedAt: l.synced_at,
        missingSince: l.missing_since,
        apartmentCode: toPasscode(apartment),
        managerCode: toPasscode(mine.find((c) => c.role === "manager")),
        // Only the last two digits: the screen needs to NAME the stale code,
        // not to hand it out a second time.
        supersededCodes: superseded,
        canRotate: l.can_rotate,
      };
    });

    const rooms: LockRoomView[] = roomRows.map((r) => ({
      roomId: r.id,
      roomNumber: r.room_number,
      name: r.name,
      floor: r.floor,
    }));

    // The freshest stamp any lock carries. Null until the first sync — which is
    // what the empty state keys off.
    const lastSyncedAt =
      locks.reduce<string | null>((acc, l) => (l.syncedAt && (!acc || l.syncedAt > acc) ? l.syncedAt : acc), null);

    return {
      success: true,
      data: { connectionConfigured: Boolean(connection?.configured), locks, rooms, lastSyncedAt },
    };
  } catch (e) {
    return failFrom(e);
  }
}

/** Pull the lock list from TTLock and reconcile. Never deletes, never maps. */
export async function syncLocksAction(): Promise<ActionResult<SyncLocksSummary>> {
  try {
    const actor = await requireLocks("locks.map");
    if (!ttlockSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const result = await syncLocks(actor.tenantId, sql);

    await audit(actor, "ttlock.locks.sync", null, {
      total: result.total,
      added: result.added,
      updated: result.updated,
      missing: result.missing,
    });

    revalidatePath("/locks");
    return { success: true, data: result };
  } catch (e) {
    return failFrom(e);
  }
}

/**
 * Pull every door's code list from TTLock and reconcile.
 *
 * READ-ONLY UPSTREAM: syncPasscodes calls one endpoint, /v3/lock/listKeyboardPwd,
 * and no write endpoint exists on that path (guard rule 9). `locks.view` is
 * therefore the right gate — a role that may READ the codes may refresh them,
 * and nothing here can change what is on a door.
 */
export async function syncPasscodesAction(): Promise<ActionResult<SyncPasscodesSummary>> {
  try {
    const actor = await requireLocks("locks.view");
    if (!ttlockSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const result = await syncPasscodes(actor.tenantId, sql);

    await audit(actor, "ttlock.passcodes.sync", null, {
      locks: result.locks,
      added: result.added,
      updated: result.updated,
      missing: result.missing,
    }, undefined, "ttlock_passcode");

    revalidatePath("/locks");
    return { success: true, data: result };
  } catch (e) {
    return failFrom(e);
  }
}

/**
 * Replace one door's apartment code with a fresh five-digit one.
 *
 * `locks.rotate` — the permission 069 seeded two migrations ago and that has
 * had no screen behind it until now. It is a strictly stronger act than viewing
 * or mapping: it changes what a physical door accepts.
 *
 * THE FULL CODE IS RETURNED TO THIS CALLER AND NOWHERE ELSE. The operator who
 * pressed the button is the person who has to read it out; the audit row gets
 * maskCode() and so does every other sink.
 */
export async function rotateApartmentCodeAction(lockId: string): Promise<ActionResult<RotateCodeResult>> {
  try {
    const actor = await requireLocks("locks.rotate");
    if (!ttlockSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const parsed = uuid.safeParse(lockId);
    if (!parsed.success) return { success: false, error: "מזהה שגוי" };

    // Re-read under this tenant before touching hardware: the client supplies a
    // uuid and is trusted for nothing. A lock id from another tenant must not
    // reach TTLock at all.
    const [lock] = await sql<{ id: string; alias: string; room_id: string | null }[]>`
      SELECT id, alias, room_id
      FROM guesthub.ttlock_locks
      WHERE id = ${parsed.data} AND tenant_id = ${actor.tenantId}`;
    if (!lock) return { success: false, error: "המנעול לא נמצא" };
    if (!lock.room_id) return { success: false, error: "יש לשייך את המנעול לחדר לפני החלפת קוד" };

    // Read for the audit BEFORE the change, and masked at the point of read so
    // no full code is ever held in a variable that an audit payload can see.
    const [previous] = await sql<{ code: string }[]>`
      SELECT code FROM guesthub.ttlock_passcodes
      WHERE tenant_id = ${actor.tenantId} AND lock_id = ${parsed.data}
        AND role = 'apartment' AND state = 'active'
      ORDER BY updated_at DESC LIMIT 1`;
    const previousMasked = previous ? maskCode(previous.code) : null;

    const result = await rotateApartmentCode({ tenantId: actor.tenantId, lockRowId: parsed.data, db: sql });

    await audit(
      actor,
      "ttlock.passcode.rotate",
      lock.id,
      { alias: lock.alias, code: maskCode(result.newCode), oldStillActive: result.oldStillActive },
      { code: previousMasked },
      "ttlock_passcode",
    );

    revalidatePath("/locks");
    return { success: true, data: { newCode: result.newCode, oldStillActive: result.oldStillActive } };
  } catch (e) {
    return failFrom(e);
  }
}

/**
 * Bind one lock to one room.
 *
 * BOTH ids are re-read under this tenant before anything is written. The client
 * supplies two uuids and is trusted for neither: a lock id from another tenant
 * must not be writable, and a room id from another tenant must not be bindable.
 * The WHERE clause on the UPDATE carries tenant_id as well, so even a race that
 * changed ownership between the check and the write cannot land.
 */
export async function mapLockToRoomAction(lockId: string, roomId: string): Promise<ActionResult> {
  try {
    const actor = await requireLocks("locks.map");

    const parsed = mapSchema.safeParse({ lockId, roomId });
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "נתונים שגויים" };

    const [lock] = await sql<{ id: string; alias: string; room_id: string | null }[]>`
      SELECT id, alias, room_id
      FROM guesthub.ttlock_locks
      WHERE id = ${parsed.data.lockId} AND tenant_id = ${actor.tenantId}`;
    if (!lock) return { success: false, error: "המנעול לא נמצא" };

    const [room] = await sql<{ id: string; room_number: string }[]>`
      SELECT id, room_number
      FROM guesthub.rooms
      WHERE id = ${parsed.data.roomId} AND tenant_id = ${actor.tenantId} AND is_active = true`;
    if (!room) return { success: false, error: "החדר לא נמצא או אינו פעיל" };

    // One room, one lock — the partial unique index in 070 is the real
    // enforcement; this read exists only so the operator gets a sentence
    // naming the other lock instead of a constraint violation.
    const [taken] = await sql<{ alias: string }[]>`
      SELECT alias
      FROM guesthub.ttlock_locks
      WHERE tenant_id = ${actor.tenantId}
        AND room_id = ${parsed.data.roomId}
        AND id <> ${parsed.data.lockId}`;
    if (taken) {
      return { success: false, error: `החדר כבר משויך למנעול “${taken.alias}”` };
    }

    const [prevRoom] = lock.room_id
      ? await sql<{ room_number: string }[]>`
          SELECT room_number FROM guesthub.rooms
          WHERE id = ${lock.room_id} AND tenant_id = ${actor.tenantId}`
      : [];

    await sql`
      UPDATE guesthub.ttlock_locks
      SET room_id = ${parsed.data.roomId}, updated_at = now()
      WHERE id = ${parsed.data.lockId} AND tenant_id = ${actor.tenantId}`;

    await audit(
      actor,
      "ttlock.lock.map",
      lock.id,
      { alias: lock.alias, roomId: room.id, roomNumber: room.room_number },
      { roomId: lock.room_id, roomNumber: prevRoom?.room_number ?? null },
    );

    revalidatePath("/locks");
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

/** Release a lock's room. The lock row survives — only the binding is cleared. */
export async function unmapLockAction(lockId: string): Promise<ActionResult> {
  try {
    const actor = await requireLocks("locks.map");

    const parsed = uuid.safeParse(lockId);
    if (!parsed.success) return { success: false, error: "מזהה שגוי" };

    const [lock] = await sql<{ id: string; alias: string; room_id: string | null }[]>`
      SELECT id, alias, room_id
      FROM guesthub.ttlock_locks
      WHERE id = ${parsed.data} AND tenant_id = ${actor.tenantId}`;
    if (!lock) return { success: false, error: "המנעול לא נמצא" };
    if (!lock.room_id) return { success: true };

    const [prevRoom] = await sql<{ room_number: string }[]>`
      SELECT room_number FROM guesthub.rooms
      WHERE id = ${lock.room_id} AND tenant_id = ${actor.tenantId}`;

    await sql`
      UPDATE guesthub.ttlock_locks
      SET room_id = NULL, updated_at = now()
      WHERE id = ${parsed.data} AND tenant_id = ${actor.tenantId}`;

    await audit(
      actor,
      "ttlock.lock.unmap",
      lock.id,
      { alias: lock.alias, roomId: null },
      { roomId: lock.room_id, roomNumber: prevRoom?.room_number ?? null },
    );

    revalidatePath("/locks");
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}
