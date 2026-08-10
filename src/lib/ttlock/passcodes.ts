import { randomInt } from "node:crypto";
import type { Sql } from "postgres";
import { ttlockAuthedRequest, TTLockError, TTLOCK_QUOTA_ERRCODES, type TTLockRegion } from "./http";
import { resolveTTLockAccessToken, TTLockNotConfiguredError, type TTLockConnectionRow } from "./token";
import { CLOSED, onCircuitFailure, type CircuitConfig, type CircuitState } from "@/lib/channel/circuit-breaker";

// ============================================================
// TTLock passcodes — sync, rotation and the delete outbox (D124).
// WORKER-GRAPH-SAFE like locks.ts, http.ts and token.ts: no "server-only", no
// next/…, no react, no "use server" module. runTTLockTick puts this file on the
// PM2 worker's tick, so it compiles through tsconfig.worker.json. Rules 2 and
// 12 in scripts/check-ttlock-secrets.mjs fail the build if that is undone.
//
// THREE RULES THIS FILE EXISTS TO OBEY, all machine-checked:
//
//  · SYNC IS READ-ONLY UPSTREAM. syncPasscodes calls exactly one endpoint,
//    /v3/lock/listKeyboardPwd, and never a write. These are live codes on live
//    doors: the only thing in this codebase permitted to change what is ON a
//    door is rotateApartmentCode, invoked by a person who pressed a button.
//    Rule 9.
//  · SYNC NEVER RECLASSIFIES. `role` is decided when a code is first seen and
//    never recomputed — an operator renaming a code upstream must not turn the
//    guest's code into the manager's or vice versa. Rule 10.
//  · A FULL CODE NEVER LEAVES THIS FILE except as a return value to an
//    authorized caller. Not into a log, not into an error message, not into an
//    audit payload. maskCode is the only form allowed anywhere else. Rule 11.
//
// AND THE INVARIANT ALL OF IT SERVES: the door always has a working code. Add
// the new one first, delete the old one last, and if either half fails, fail
// towards "two codes work" rather than "none does".
// ============================================================

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/** TTLock's `keyboardPwdType` for a permanent code. Used ONLY when a door has
 *  no existing apartment code to copy the type from — see resolvePwdType. */
const PERMANENT_PWD_TYPE = 2;
/** addType=2 = "deliver via gateway", which is what lets US choose the digits. */
const ADD_TYPE_GATEWAY = "2";
/** deleteType=2 = "delete via gateway", the mirror of the above. */
const DELETE_TYPE_GATEWAY = "2";

const MAX_CODE_DRAWS = 20;
const MAX_OP_ATTEMPTS = 5;
const BACKOFF_BASE_SEC = 30;

/** Breaker tuning for TTLock: three consecutive failures trip it for 5 minutes,
 *  doubling up to an hour. A quota errcode trips it IMMEDIATELY for a full
 *  hour — the monthly budget is spent and only time fixes that, so the honest
 *  cadence is one probe an hour (~24 wasted calls on the worst day) rather than
 *  modelling TTLock's reset clock. */
const TTLOCK_CIRCUIT: CircuitConfig = {
  failureThreshold: 3,
  baseCooldownMs: 5 * 60_000,
  maxCooldownMs: 60 * 60_000,
};
const TTLOCK_QUOTA_COOLDOWN_MS = 60 * 60_000;

export type PasscodeRole = "manager" | "apartment" | "other";
export type PasscodeState = "active" | "rotating" | "revoking" | "revoked" | "missing";

export type SyncPasscodesResult = {
  locks: number;
  added: number;
  updated: number;
  missing: number;
};

export type RotateResult = {
  newCode: string;
  /** true = the superseded code is STILL on the door; the worker will retry */
  oldStillActive: boolean;
};

export type DrainResult = {
  claimed: number;
  done: number;
  failed: number;
  exhausted: number;
  /** true = the circuit was open and the drain returned without touching TTLock */
  skippedCircuitOpen?: boolean;
};

/** The only representation of a code allowed outside this module's callers. */
export function maskCode(code: string | null | undefined): string {
  if (!code) return "••";
  return `••${code.slice(-2)}`;
}

// ---------------------------------------------------------------
// upstream reads
// ---------------------------------------------------------------

type UpstreamPasscode = {
  ttlockPasscodeId: number;
  code: string;
  name: string;
  keyboardPwdType: number | null;
  startsAt: string | null;
  endsAt: string | null;
  raw: Record<string, unknown>;
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// TTLock sends epoch MILLISECONDS, and sends 0 to mean "no bound". 0 is not a
// date: a permanent code stamped 1970 would render and sort as long expired.
function asTimestamp(v: unknown): string | null {
  const n = asNumber(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toUpstream(row: Record<string, unknown>): UpstreamPasscode | null {
  const id = asNumber(row.keyboardPwdId);
  const code = typeof row.keyboardPwd === "string" ? row.keyboardPwd.trim() : "";
  // No id or no digits means nothing we can key or show. Skipping is right:
  // this is a read, and a row we cannot model must not become a row we invent.
  if (id === null || !code) return null;
  const name = typeof row.keyboardPwdName === "string" ? row.keyboardPwdName.trim() : "";
  return {
    ttlockPasscodeId: id,
    code,
    name: name || `קוד ${id}`,
    keyboardPwdType: asNumber(row.keyboardPwdType),
    startsAt: asTimestamp(row.startDate),
    endsAt: asTimestamp(row.endDate),
    raw: row,
  };
}

/** Every passcode on one door, across all pages. READ ONLY. */
async function fetchPasscodes(
  connection: TTLockConnectionRow,
  accessToken: string,
  ttlockLockId: string,
): Promise<UpstreamPasscode[]> {
  const auth = { clientId: connection.client_id, accessToken };
  const out: UpstreamPasscode[] = [];
  let pageNo = 1;
  let pages = 1;

  do {
    const body = await ttlockAuthedRequest(
      connection.region as TTLockRegion,
      "/v3/lock/listKeyboardPwd",
      auth,
      { lockId: ttlockLockId, pageNo: String(pageNo), pageSize: String(PAGE_SIZE) },
    );

    const list = Array.isArray(body.list) ? body.list : [];
    for (const item of list) {
      if (item && typeof item === "object") {
        const parsed = toUpstream(item as Record<string, unknown>);
        if (parsed) out.push(parsed);
      }
    }

    const reported = asNumber(body.pages);
    pages = reported !== null && reported > 0 ? reported : pageNo;
    if (list.length === 0) break;

    pageNo += 1;
    // A partial list here is worse than an error: the codes it omitted would be
    // marked 'missing' and the screen would tell the operator a live code was
    // deleted. Refuse rather than mislead — same rule fetchLocks follows.
    if (pageNo > MAX_PAGES) {
      throw new Error(`TTLock /v3/lock/listKeyboardPwd exceeded ${MAX_PAGES} pages — refusing to return a partial list`);
    }
  } while (pageNo <= pages);

  return out;
}

// ---------------------------------------------------------------
// local reads
// ---------------------------------------------------------------

/** The connection slice a sync needs. Read with the injected `db`, not through
 *  store.ts — that file is "server-only" and would break the worker graph. */
async function readConnection(tenantId: string, db: Sql): Promise<TTLockConnectionRow> {
  const [row] = await db<TTLockConnectionRow[]>`
    SELECT id, region, client_id, username, secret_ciphertext,
           access_token_ciphertext,
           access_token_expires_at::text AS access_token_expires_at,
           refresh_token_ciphertext
    FROM guesthub.ttlock_connections
    WHERE tenant_id = ${tenantId}`;
  if (!row || !row.secret_ciphertext) throw new TTLockNotConfiguredError();
  return row;
}

type LockRow = {
  id: string;
  ttlock_lock_id: string;
  alias: string;
  room_number: string | null;
  has_gateway: boolean;
};

async function readLocks(
  tenantId: string,
  db: Sql,
  lockRowId?: string,
  lockIds?: readonly string[],
): Promise<LockRow[]> {
  // hasGateway comes out of the stored payload rather than a column of its own:
  // it is upstream's fact about the hardware, it changes when a gateway is
  // added, and re-deriving it on read means a sync is all it takes to correct.
  return db<LockRow[]>`
    SELECT l.id,
           l.ttlock_lock_id::text AS ttlock_lock_id,
           l.alias,
           r.room_number AS room_number,
           COALESCE((l.raw->>'hasGateway')::int, 0) = 1 AS has_gateway
    FROM guesthub.ttlock_locks l
    LEFT JOIN guesthub.rooms r ON r.id = l.room_id AND r.tenant_id = l.tenant_id
    WHERE l.tenant_id = ${tenantId}
      ${lockRowId ? db`AND l.id = ${lockRowId}` : db``}
      ${lockIds ? db`AND l.id = ANY(${lockIds as string[]}::uuid[])` : db``}
    ORDER BY l.alias ASC`;
}

// ---------------------------------------------------------------
// classification — INSERT time only (rule 10)
// ---------------------------------------------------------------

/**
 * Which kind of code this is, decided ONCE from the name it had when we first
 * saw it. Never re-run against an existing row: see 071's header for the two
 * ways a rename would otherwise corrupt a live door.
 */
export function classifyPasscode(name: string, roomNumber: string | null): PasscodeRole {
  const n = name.trim();
  if (n.includes("מנהל")) return "manager";
  if (n.includes("דירה")) return "apartment";
  if (roomNumber && n === roomNumber.trim()) return "apartment";
  return "other";
}

// ---------------------------------------------------------------
// sync
// ---------------------------------------------------------------

/**
 * Reconcile this tenant's passcode rows against what each door actually holds.
 *
 * READ-ONLY UPSTREAM (rule 9). Locally: upsert what came back, and mark what
 * did not come back as 'missing' — the same non-destructive doctrine 070 uses
 * for locks, for the same reason. A code removed in the TTLock app is a real
 * event the operator needs to see; a code we simply failed to fetch must not
 * look like one, so 'missing' is a state and never a DELETE.
 */
export async function syncPasscodes(
  tenantId: string,
  db: Sql,
  /**
   * Narrow the sync to specific lock rows (D125). The filter is pushed into the
   * SQL — a fetch-all-then-drop would still make one upstream call per door,
   * which is the entire cost this option exists to avoid. Undefined = all.
   */
  lockIds?: readonly string[],
): Promise<SyncPasscodesResult> {
  // An explicit EMPTY selection means "nothing", never "everything". Falling
  // through to a tenant-wide sync here would turn a UI edge case into 12
  // upstream calls nobody asked for.
  if (lockIds && lockIds.length === 0) return { locks: 0, added: 0, updated: 0, missing: 0 };

  const connection = await readConnection(tenantId, db);
  const locks = await readLocks(tenantId, db, undefined, lockIds);
  if (locks.length === 0) return { locks: 0, added: 0, updated: 0, missing: 0 };

  const accessToken = await resolveTTLockAccessToken(db, connection);
  const syncedAt = new Date();
  const result: SyncPasscodesResult = { locks: locks.length, added: 0, updated: 0, missing: 0 };

  for (const lock of locks) {
    const upstream = await fetchPasscodes(connection, accessToken, lock.ttlock_lock_id);

    if (upstream.length > 0) {
      const payload = upstream.map((p) => ({
        ttlock_passcode_id: p.ttlockPasscodeId,
        code: p.code,
        name: p.name,
        role: classifyPasscode(p.name, lock.room_number),
        keyboard_pwd_type: p.keyboardPwdType,
        starts_at: p.startsAt,
        ends_at: p.endsAt,
        raw: p.raw,
      }));

      // ONE batch statement per door. `role` appears in the INSERT column list
      // and NOWHERE in the DO UPDATE SET — that omission is the protection rule
      // 10 exists to keep. `state` is likewise only advanced for rows that are
      // not mid-operation: an in-flight rotation is newer than this read.
      const rows = await db<{ inserted: boolean }[]>`
        INSERT INTO guesthub.ttlock_passcodes
          (tenant_id, lock_id, ttlock_passcode_id, code, name, role,
           keyboard_pwd_type, starts_at, ends_at, raw, origin, state, synced_at)
        SELECT ${tenantId}, ${lock.id}, d.ttlock_passcode_id, d.code, d.name, d.role,
               d.keyboard_pwd_type, d.starts_at, d.ends_at, d.raw, 'ttlock', 'active', ${syncedAt}
        FROM jsonb_to_recordset(${db.json(payload as never)}::jsonb) AS d(
          ttlock_passcode_id bigint,
          code               text,
          name               text,
          role               text,
          keyboard_pwd_type  integer,
          starts_at          timestamptz,
          ends_at            timestamptz,
          raw                jsonb
        )
        ON CONFLICT (tenant_id, lock_id, ttlock_passcode_id)
          WHERE ttlock_passcode_id IS NOT NULL
        DO UPDATE SET
          code              = EXCLUDED.code,
          name              = EXCLUDED.name,
          keyboard_pwd_type = EXCLUDED.keyboard_pwd_type,
          starts_at         = EXCLUDED.starts_at,
          ends_at           = EXCLUDED.ends_at,
          raw               = EXCLUDED.raw,
          synced_at         = EXCLUDED.synced_at,
          -- a code we can see upstream is active again UNLESS a local operation
          -- is mid-flight, in which case our own state is the fresher fact
          state = CASE
                    WHEN guesthub.ttlock_passcodes.state IN ('rotating', 'revoking')
                      THEN guesthub.ttlock_passcodes.state
                    ELSE 'active'
                  END,
          updated_at = now()
        RETURNING (xmax = 0) AS inserted`;

      for (const r of rows) {
        if (r.inserted) result.added += 1;
        else result.updated += 1;
      }
    }

    // Absent upstream → 'missing'. Never a DELETE, and never applied to a row
    // that is mid-operation: a 'rotating' code has no upstream id yet by
    // definition, and a 'revoking' one is absent because we are removing it.
    const seen = upstream.map((p) => String(p.ttlockPasscodeId));
    const stamped = seen.length
      ? await db<{ id: string }[]>`
          UPDATE guesthub.ttlock_passcodes
          SET state = 'missing', updated_at = now()
          WHERE tenant_id = ${tenantId}
            AND lock_id = ${lock.id}
            AND state = 'active'
            AND ttlock_passcode_id IS NOT NULL
            AND ttlock_passcode_id <> ALL(${seen}::bigint[])
          RETURNING id`
      : await db<{ id: string }[]>`
          UPDATE guesthub.ttlock_passcodes
          SET state = 'missing', updated_at = now()
          WHERE tenant_id = ${tenantId}
            AND lock_id = ${lock.id}
            AND state = 'active'
            AND ttlock_passcode_id IS NOT NULL
          RETURNING id`;
    result.missing += stamped.length;
  }

  return result;
}

// ---------------------------------------------------------------
// rotation
// ---------------------------------------------------------------

/**
 * A five-digit code a human can read out over the phone and type at a door.
 *
 * The rejections are not superstition: a leading zero is dropped by half the
 * keypads and every spreadsheet the operator will paste it into, and a run or a
 * repeat is the first thing anyone tries on a keypad. `randomInt` is the CSPRNG
 * — Math.random would make the day's codes guessable from one of them.
 */
export function generateCode(forbidden: readonly string[]): string {
  const banned = new Set(forbidden.filter(Boolean));
  for (let i = 0; i < MAX_CODE_DRAWS; i += 1) {
    const candidate = String(randomInt(10000, 100000)); // 10000-99999, no leading zero
    if (banned.has(candidate)) continue;
    if (codeRejection(candidate, banned)) continue;
    return candidate;
  }
  throw new Error(`could not generate a passcode in ${MAX_CODE_DRAWS} draws`);
}

/**
 * THE ONE PLACE A CODE IS JUDGED (D125).
 *
 * A random draw and an operator-typed code must clear exactly the same bar.
 * Before the bulk drawer existed there was only the draw, and its checks lived
 * inline in generateCode; a second entry point that re-implemented "4-6 digits,
 * no runs" would drift from this one the first time either changed. So the
 * rules moved here, both callers use it, and guard rule 17 fails the build if
 * the operator's path stops going through it.
 *
 * Returns a Hebrew reason, or null when the code is acceptable.
 */
export function codeRejection(code: string, forbidden: ReadonlySet<string> | readonly string[]): string | null {
  const banned = forbidden instanceof Set ? forbidden : new Set(forbidden);
  if (!/^\d{4,6}$/.test(code)) return "הקוד חייב להיות 4–6 ספרות";
  if (code.startsWith("0")) return "קוד לא יכול להתחיל באפס";
  if (/^(\d)\1*$/.test(code)) return "קוד לא יכול להיות ספרה אחת חוזרת";
  if (isRun(code)) return "קוד לא יכול להיות רצף עולה או יורד";
  if (banned.has(code)) return "הקוד כבר בשימוש על המנעול הזה";
  return null;
}

function isRun(code: string): boolean {
  let up = true;
  let down = true;
  for (let i = 1; i < code.length; i += 1) {
    const delta = code.charCodeAt(i) - code.charCodeAt(i - 1);
    if (delta !== 1) up = false;
    if (delta !== -1) down = false;
  }
  return up || down;
}

type PasscodeRow = {
  id: string;
  ttlock_passcode_id: string | null;
  code: string;
  keyboard_pwd_type: number | null;
};

/**
 * The type number a new code should carry. We do NOT translate TTLock's type
 * vocabulary — we copy whatever the door's existing apartment code already has,
 * so a rotation produces the same KIND of code the operator has been using. The
 * constant is the fallback for a door that has never had one, and it is the
 * only place in this codebase that asserts what a type number means.
 */
function resolvePwdType(current: PasscodeRow | undefined): number {
  return current?.keyboard_pwd_type ?? PERMANENT_PWD_TYPE;
}

export class TTLockNoGatewayError extends Error {
  constructor() {
    super("למנעול זה אין שער (Gateway) מחובר, ולכן לא ניתן להחליף לו קוד מרחוק");
    this.name = "TTLockNoGatewayError";
  }
}

/** An operator-typed code that failed codeRejection. The message is already
 *  Hebrew and is safe to surface — it describes the CODE, not the upstream. */
export class TTLockCodeRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TTLockCodeRejectedError";
  }
}

/**
 * Replace a door's apartment code with a fresh five-digit one.
 *
 * ORDER IS THE SAFETY PROPERTY. The new code goes ON the door before the old
 * one comes off, so every failure mode leaves at least one working code:
 *
 *   add fails      → nothing reached the door; the old code still works, the
 *                    new row is marked revoked and the operator sees an error.
 *   add ok, del ok → clean swap.
 *   add ok, del !  → BOTH codes work; the outbox retries the delete and the
 *                    screen says so until it lands.
 *
 * There is no path in which the door ends up with no code.
 */
export async function rotateApartmentCode({
  tenantId,
  lockRowId,
  db,
  requestedCode,
}: {
  tenantId: string;
  lockRowId: string;
  db: Sql;
  /**
   * A code the OPERATOR typed, instead of a random draw (D125). It is judged by
   * codeRejection — the same function, with the same banned patterns and the
   * same live-code set — before it can reach the hardware. There is no path
   * that skips that: the bulk action does not build its own payload, it calls
   * this function, and guard rule 17 fails the build if the check is bypassed.
   */
  requestedCode?: string;
}): Promise<RotateResult> {
  const connection = await readConnection(tenantId, db);
  const [lock] = await readLocks(tenantId, db, lockRowId);
  if (!lock) throw new Error("lock not found");
  // Checked BEFORE anything is written: addType=2 delivers through a gateway,
  // and a door without one cannot receive a code we chose. Failing here gives
  // the operator a sentence; failing upstream would give them errcode noise.
  if (!lock.has_gateway) throw new TTLockNoGatewayError();

  // Every code the door currently answers to, whatever its role. The new code
  // must collide with none of them — above all not with the MANAGER code, which
  // this feature may never rotate and must therefore never accidentally mint.
  const live = await db<{ code: string }[]>`
    SELECT code
    FROM guesthub.ttlock_passcodes
    WHERE tenant_id = ${tenantId} AND lock_id = ${lockRowId}
      AND state IN ('active', 'rotating', 'revoking')`;

  const currentApartment = await readCurrentApartment(tenantId, lockRowId, db);

  // Operator-chosen or drawn — both end up judged by codeRejection. The
  // rejection is thrown BEFORE any row is written, so a bad code costs nothing.
  const bannedHere = new Set(live.map((r) => r.code));
  let code: string;
  if (requestedCode !== undefined) {
    const reason = codeRejection(requestedCode, bannedHere);
    if (reason) throw new TTLockCodeRejectedError(reason);
    code = requestedCode;
  } else {
    code = generateCode([...bannedHere]);
  }
  const pwdType = resolvePwdType(currentApartment);
  const name = lock.room_number ? `דירה ${lock.room_number}` : lock.alias;

  // Local row first, in 'rotating': if the process dies between here and the
  // upstream call, the row is visibly stuck rather than invisibly lost, and it
  // holds no upstream id so nothing believes it is on the door.
  const [pending] = await db<{ id: string }[]>`
    INSERT INTO guesthub.ttlock_passcodes
      (tenant_id, lock_id, ttlock_passcode_id, code, name, role,
       keyboard_pwd_type, state, origin, rotated_reason)
    VALUES (${tenantId}, ${lockRowId}, NULL, ${code}, ${name}, 'apartment',
            ${pwdType}, 'rotating', 'local', 'manual')
    RETURNING id`;

  const auth = { clientId: connection.client_id, accessToken: await resolveTTLockAccessToken(db, connection) };

  let upstreamId: number;
  try {
    const body = await ttlockAuthedRequest(
      connection.region as TTLockRegion,
      "/v3/keyboardPwd/add",
      auth,
      {
        lockId: lock.ttlock_lock_id,
        keyboardPwd: code,
        keyboardPwdName: name,
        keyboardPwdType: String(pwdType),
        startDate: "0",
        endDate: "0",
        addType: ADD_TYPE_GATEWAY,
      },
    );
    const id = asNumber(body.keyboardPwdId);
    if (id === null) throw new TTLockError("/v3/keyboardPwd/add", -1, "no keyboardPwdId in response");
    upstreamId = id;
  } catch (e) {
    // It never reached the door. The old code is untouched and still works —
    // which is why this is a failed rotation and not an outage. last_error
    // carries a CATEGORY, never the upstream body and never a code value.
    await db`
      UPDATE guesthub.ttlock_passcodes
      SET state = 'revoked', last_error = ${errorCategory(e)}, updated_at = now()
      WHERE id = ${pending.id} AND tenant_id = ${tenantId}`;
    throw e;
  }

  await db`
    UPDATE guesthub.ttlock_passcodes
    SET ttlock_passcode_id = ${upstreamId}, state = 'active', synced_at = now(), updated_at = now()
    WHERE id = ${pending.id} AND tenant_id = ${tenantId}`;

  // From here the operator HAS the new code and the door accepts it. Everything
  // below is cleanup that must not be lost — hence the outbox.
  if (!currentApartment) return { newCode: code, oldStillActive: false };

  await db`
    UPDATE guesthub.ttlock_passcodes
    SET state = 'revoking', updated_at = now()
    WHERE id = ${currentApartment.id} AND tenant_id = ${tenantId}`;

  const [op] = await db<{ id: string }[]>`
    INSERT INTO guesthub.ttlock_ops (tenant_id, passcode_id, op)
    VALUES (${tenantId}, ${currentApartment.id}, 'delete_remote')
    RETURNING id::text AS id`;

  // One inline attempt so the common case completes before the operator has
  // finished reading the new code. Failure is not an error here — it is exactly
  // what the outbox is for, and the caller is told the old code still works.
  try {
    await deleteRemote(connection, auth.accessToken, lock.ttlock_lock_id, currentApartment.ttlock_passcode_id);
    await markOpDone(db, tenantId, op.id, currentApartment.id);
    return { newCode: code, oldStillActive: false };
  } catch (e) {
    await db`
      UPDATE guesthub.ttlock_ops
      SET attempts = attempts + 1,
          run_after = now() + make_interval(secs => ${BACKOFF_BASE_SEC}),
          last_error = ${errorCategory(e)}
      WHERE id = ${op.id}::bigint AND tenant_id = ${tenantId}`;
    return { newCode: code, oldStillActive: true };
  }
}

/** The one row a rotation replaces: this door's live apartment code. */
async function readCurrentApartment(
  tenantId: string,
  lockRowId: string,
  db: Sql,
): Promise<PasscodeRow | undefined> {
  const [row] = await db<PasscodeRow[]>`
    SELECT id, ttlock_passcode_id::text AS ttlock_passcode_id, code, keyboard_pwd_type
    FROM guesthub.ttlock_passcodes
    WHERE tenant_id = ${tenantId} AND lock_id = ${lockRowId}
      AND role = 'apartment' AND state = 'active'
      AND ttlock_passcode_id IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1`;
  return row;
}

/** A safe category for `last_error`. Never the upstream body, never the Chinese
 *  errmsg, never a code value. */
function errorCategory(e: unknown): string {
  if (e instanceof TTLockError) return `ttlock_errcode_${e.errcode}`;
  if (e instanceof Error) return e.name;
  return "unknown_error";
}

async function deleteRemote(
  connection: TTLockConnectionRow,
  accessToken: string,
  ttlockLockId: string,
  ttlockPasscodeId: string | null,
): Promise<void> {
  if (!ttlockPasscodeId) return; // never reached the door; nothing to remove
  await ttlockAuthedRequest(
    connection.region as TTLockRegion,
    "/v3/keyboardPwd/delete",
    { clientId: connection.client_id, accessToken },
    {
      lockId: ttlockLockId,
      keyboardPwdId: ttlockPasscodeId,
      deleteType: DELETE_TYPE_GATEWAY,
    },
  );
}

async function markOpDone(db: Sql, tenantId: string, opId: string, passcodeId: string): Promise<void> {
  await db`
    UPDATE guesthub.ttlock_ops
    SET done_at = now(), attempts = attempts + 1, last_error = NULL
    WHERE id = ${opId}::bigint AND tenant_id = ${tenantId}`;
  await db`
    UPDATE guesthub.ttlock_passcodes
    SET state = 'revoked', updated_at = now()
    WHERE id = ${passcodeId} AND tenant_id = ${tenantId}`;
}

// ---------------------------------------------------------------
// circuit breaker bookkeeping
// ---------------------------------------------------------------

/**
 * Record one TTLock outcome on the connection row — the breaker state shared by
 * the PM2 worker (drain) and the Next.js server actions (manual sync / rotate),
 * and what the /locks amber banner reads. `e === null` means success and fully
 * closes the breaker. Errors that are not TTLockError (our own config, a
 * missing key) are not the circuit's business and are ignored.
 *
 * Bookkeeping only: it never throws, so it can never fail an operation that
 * succeeded. Read-modify-write in two statements is fine here — one worker
 * instance plus rare manual actions, and the worst race costs one probe.
 */
export async function recordTTLockCircuitOutcome(
  tenantId: string,
  db: Sql,
  e: unknown,
): Promise<CircuitState | null> {
  try {
    if (e === null) {
      await db`
        UPDATE guesthub.ttlock_connections
        SET circuit_open_until = NULL, circuit_failures = 0, last_errcode = NULL, updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND (circuit_failures > 0 OR circuit_open_until IS NOT NULL OR last_errcode IS NOT NULL)`;
      return CLOSED;
    }
    if (!(e instanceof TTLockError)) return null;

    const [row] = await db<{ circuit_failures: number; circuit_open_until: string | null }[]>`
      SELECT circuit_failures, circuit_open_until::text AS circuit_open_until
      FROM guesthub.ttlock_connections
      WHERE tenant_id = ${tenantId}`;
    const prev: CircuitState = {
      consecutiveFailures: row?.circuit_failures ?? 0,
      openUntil: row?.circuit_open_until ? new Date(row.circuit_open_until).getTime() : null,
    };
    const next = onCircuitFailure(
      prev,
      TTLOCK_QUOTA_ERRCODES.has(e.errcode) ? "rate_limited" : "other",
      Date.now(),
      { retryAfterMs: TTLOCK_QUOTA_COOLDOWN_MS, config: TTLOCK_CIRCUIT },
    );
    await db`
      UPDATE guesthub.ttlock_connections
      SET circuit_failures = ${next.consecutiveFailures},
          circuit_open_until = ${next.openUntil === null ? null : new Date(next.openUntil)},
          last_errcode = ${e.errcode},
          last_failure_at = now(),
          updated_at = now()
      WHERE tenant_id = ${tenantId}`;
    return next;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// outbox drain
// ---------------------------------------------------------------

type OpRow = {
  id: string;
  passcode_id: string | null;
  attempts: number;
  ttlock_passcode_id: string | null;
  ttlock_lock_id: string | null;
};

/**
 * Retry the deletes that did not land inline.
 *
 * SKIP LOCKED so a second worker (a rolling restart, a stray start) can never
 * process the same op. When the attempts are exhausted the passcode goes BACK
 * to 'active' rather than to 'revoked': it is still physically on the door, and
 * a row claiming otherwise would tell the operator a live code was retired.
 */
export async function drainTTLockOps(
  tenantId: string,
  db: Sql,
  { budgetMs = 10_000 }: { budgetMs?: number } = {},
): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, done: 0, failed: 0, exhausted: 0 };
  const startedAt = Date.now();

  const ops = await db<OpRow[]>`
    SELECT o.id::text AS id,
           o.passcode_id,
           o.attempts,
           p.ttlock_passcode_id::text AS ttlock_passcode_id,
           l.ttlock_lock_id::text     AS ttlock_lock_id
    FROM guesthub.ttlock_ops o
    LEFT JOIN guesthub.ttlock_passcodes p ON p.id = o.passcode_id
    LEFT JOIN guesthub.ttlock_locks l ON l.id = p.lock_id
    WHERE o.tenant_id = ${tenantId}
      AND o.done_at IS NULL
      AND o.run_after <= now()
    ORDER BY o.run_after ASC
    LIMIT 25
    FOR UPDATE OF o SKIP LOCKED`;

  if (ops.length === 0) return result;

  // Circuit gate: an exhausted quota is probed once the cooldown lapses, not
  // hammered every 20s cycle. The waiting ops are left exactly as they are —
  // run_after and attempts untouched — so sitting out the breaker costs them
  // nothing; they simply run when the circuit closes. Checked only when ops
  // exist: the idle path stays at zero extra queries.
  const [cb] = await db<{ open: boolean }[]>`
    SELECT (circuit_open_until IS NOT NULL AND circuit_open_until > now()) AS open
    FROM guesthub.ttlock_connections
    WHERE tenant_id = ${tenantId}`;
  if (cb?.open) {
    result.skippedCircuitOpen = true;
    return result;
  }

  let connection: TTLockConnectionRow;
  let accessToken: string;
  try {
    connection = await readConnection(tenantId, db);
    accessToken = await resolveTTLockAccessToken(db, connection);
  } catch (e) {
    // A failed token mint is an upstream failure too (quota applies to it).
    await recordTTLockCircuitOutcome(tenantId, db, e);
    throw e;
  }
  result.claimed = ops.length;
  let recordedSuccess = false;

  for (const op of ops) {
    if (Date.now() - startedAt > budgetMs) break;

    // The passcode (or its lock) is gone — the op has nothing left to do and
    // must not spin forever against a row that no longer exists.
    if (!op.passcode_id || !op.ttlock_lock_id) {
      await db`UPDATE guesthub.ttlock_ops SET done_at = now(), last_error = 'orphaned' WHERE id = ${op.id}::bigint`;
      result.done += 1;
      continue;
    }

    try {
      await deleteRemote(connection, accessToken, op.ttlock_lock_id, op.ttlock_passcode_id);
      await markOpDone(db, tenantId, op.id, op.passcode_id);
      result.done += 1;
      if (!recordedSuccess) {
        recordedSuccess = true;
        await recordTTLockCircuitOutcome(tenantId, db, null);
      }
    } catch (e) {
      const attempts = op.attempts + 1;
      const category = errorCategory(e);
      if (attempts >= MAX_OP_ATTEMPTS) {
        // Give up on the delete, and SAY SO on the code: it is still on the
        // door. 'active' is the truthful state, last_error is why.
        await db`
          UPDATE guesthub.ttlock_ops
          SET attempts = ${attempts}, done_at = now(), last_error = ${category}
          WHERE id = ${op.id}::bigint AND tenant_id = ${tenantId}`;
        await db`
          UPDATE guesthub.ttlock_passcodes
          SET state = 'active', last_error = ${category}, updated_at = now()
          WHERE id = ${op.passcode_id} AND tenant_id = ${tenantId}`;
        result.exhausted += 1;
      } else {
        await db`
          UPDATE guesthub.ttlock_ops
          SET attempts = ${attempts},
              run_after = now() + make_interval(secs => ${BACKOFF_BASE_SEC * 2 ** op.attempts}),
              last_error = ${category}
          WHERE id = ${op.id}::bigint AND tenant_id = ${tenantId}`;
        result.failed += 1;
      }
      // One outage is one failure: the moment the breaker opens, stop the
      // loop instead of counting the same dead upstream 25 times.
      const state = await recordTTLockCircuitOutcome(tenantId, db, e);
      if (state?.openUntil != null && state.openUntil > Date.now()) break;
    }
  }

  return result;
}
