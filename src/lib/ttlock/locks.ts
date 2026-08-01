import type { Sql } from "postgres";
import { ttlockAuthedRequest, type TTLockRegion } from "./http";
import { resolveTTLockAccessToken, TTLockNotConfiguredError, type TTLockConnectionRow } from "./token";

// ============================================================
// TTLock lock list + sync (D123) — WORKER-GRAPH-SAFE, like http.ts and token.ts.
// No "server-only", no next/…, no react, no "use server" module. The next task
// puts syncLocks on the PM2 worker's tick, which compiles through
// tsconfig.worker.json (plain CommonJS, no React condition), so this file has to
// survive that compile unchanged. Enforced by check-ttlock-secrets.mjs rule 2.
//
// This is also WHY the connection row is read here with the injected `db` rather
// than through store.ts: store.ts carries `import "server-only"` (it is the
// place a secret leaves the database) and importing it would put this module
// out of the worker's reach. Same split token.ts already makes.
//
// TWO RULES THIS FILE EXISTS TO OBEY, both machine-checked:
//
//  · syncLocks NEVER writes room_id. The lock→room binding is operator
//    knowledge that exists nowhere upstream — TTLock knows a door as
//    "דירה 4 כניסה" and has never heard of room 402. An upstream row can
//    therefore never have an opinion about it. Rule 6.
//  · syncLocks NEVER deletes. A lock absent from the response is STAMPED
//    (missing_since) and kept, mapping intact. A gateway hiccup, a paging edge
//    or a temporary fault all produce a shorter list, and deleting on that
//    basis destroys hand-built mappings silently. Rule 7.
//
// Every query is tenant-scoped and every table is qualified guesthub.<table>
// (rule 8).
// ============================================================

/** One upstream device, narrowed to the fields we model. */
export type TTLockDevice = {
  lockId: number;
  alias: string;
  mac: string | null;
  battery: number | null;
  tzOffsetMinutes: number | null;
  /** the upstream row verbatim — no credential is present in it */
  raw: Record<string, unknown>;
};

export type SyncLocksResult = {
  /** locks returned by TTLock in this sync */
  total: number;
  /** rows this sync created */
  added: number;
  /** rows this sync refreshed */
  updated: number;
  /** rows newly stamped missing_since (NOT deleted) */
  missing: number;
};

const PAGE_SIZE = 100;

// A runaway guard, not a page budget: 100 pages is 10,000 locks, far past any
// real account. If upstream ever reports `pages` incoherently (or forgets to
// advance), this THROWS rather than returning a short list — a truncated list
// silently becomes "these locks are missing" on the next sync, which is the one
// outcome this whole module is built to prevent.
const MAX_PAGES = 100;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function toDevice(row: Record<string, unknown>): TTLockDevice | null {
  const lockId = asNumber(row.lockId);
  if (lockId === null) return null; // a row with no id cannot be keyed — skip it
  return {
    lockId,
    // lockAlias is the operator-set name and is what leads on the screen.
    // lockName is TTLock's factory string; the id is the last resort so the
    // column is never an empty string pretending to be a name.
    alias: asText(row.lockAlias) ?? asText(row.lockName) ?? `מנעול ${lockId}`,
    mac: asText(row.lockMac),
    battery: asNumber(row.electricQuantity),
    tzOffsetMinutes: asNumber(row.timezoneRawOffset),
    raw: row,
  };
}

/**
 * Every lock the account can reach, across ALL pages.
 *
 * The settings probe (069) deliberately asks for one page of 100 and reports
 * `total` — enough to prove the credential reaches real hardware. A SYNC cannot
 * stop there: page 2 existing and being skipped would mean every lock on it is
 * absent from the response, and `syncLocks` would stamp all of them missing.
 * The loop is therefore correctness, not capacity planning — this tenant's 12
 * locks fit in a single page today and will for a long time.
 */
export async function fetchLocks(connection: TTLockConnectionRow, db: Sql): Promise<TTLockDevice[]> {
  // Resolved once for the whole walk. The token lives in this frame only: never
  // returned, never logged, never placed in an error message.
  const accessToken = await resolveTTLockAccessToken(db, connection);
  const auth = { clientId: connection.client_id, accessToken };

  const devices: TTLockDevice[] = [];
  let pageNo = 1;
  let pages = 1;

  do {
    const body = await ttlockAuthedRequest(
      connection.region as TTLockRegion,
      "/v3/lock/list",
      auth,
      { pageNo: String(pageNo), pageSize: String(PAGE_SIZE) },
    );

    const list = Array.isArray(body.list) ? body.list : [];
    for (const item of list) {
      if (item && typeof item === "object") {
        const device = toDevice(item as Record<string, unknown>);
        if (device) devices.push(device);
      }
    }

    // `pages` is upstream's own page count. A response that omits it is treated
    // as single-page, which is what a short list means anyway.
    const reported = asNumber(body.pages);
    pages = reported !== null && reported > 0 ? reported : pageNo;

    // An empty page ends the walk regardless of what `pages` claims — otherwise
    // a wrong `pages` spins to MAX_PAGES for nothing.
    if (list.length === 0) break;

    pageNo += 1;
    if (pageNo > MAX_PAGES) {
      throw new Error(`TTLock /v3/lock/list exceeded ${MAX_PAGES} pages — refusing to return a partial list`);
    }
  } while (pageNo <= pages);

  return devices;
}

/** The connection slice a sync needs. Read here, not via store.ts (see header). */
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

/**
 * Fetch every lock and reconcile this tenant's rows against it.
 *
 * Reconcile, not replace: the upstream list decides what EXISTS, never what a
 * lock is FOR. room_id is absent from both the insert column list and the
 * DO UPDATE SET, so there is no statement here that could overwrite a mapping
 * even by accident.
 */
export async function syncLocks(tenantId: string, db: Sql): Promise<SyncLocksResult> {
  const connection = await readConnection(tenantId, db);
  const devices = await fetchLocks(connection, db);

  // One stamp for the whole sync, so every row it touched carries the same
  // instant and "when did we last see this lock" is answerable by comparison.
  const syncedAt = new Date();

  let added = 0;
  let updated = 0;

  if (devices.length > 0) {
    const payload = devices.map((d) => ({
      ttlock_lock_id: d.lockId,
      alias: d.alias,
      mac: d.mac,
      battery: d.battery,
      tz_offset_minutes: d.tzOffsetMinutes,
      raw: d.raw,
    }));

    // ONE batch statement, whatever the lock count: the devices ride in as a
    // single jsonb document and jsonb_to_recordset turns them back into rows.
    // tenant_id and synced_at are bound ONCE here rather than repeated per
    // device — a per-row tenant_id is a per-row opportunity to get it wrong.
    //
    // room_id appears in NEITHER the column list nor the DO UPDATE SET. That
    // omission IS the protection, and rule 6 fails the build if it is undone.
    // `xmax = 0` is Postgres' own way of telling an upsert's inserts from its
    // updates, so the operator gets real counts and not an estimate.
    const rows = await db<{ inserted: boolean }[]>`
      INSERT INTO guesthub.ttlock_locks
        (tenant_id, ttlock_lock_id, alias, mac, battery, tz_offset_minutes, raw, synced_at)
      SELECT ${tenantId}, d.ttlock_lock_id, d.alias, d.mac, d.battery,
             d.tz_offset_minutes, d.raw, ${syncedAt}
      FROM jsonb_to_recordset(${db.json(payload as never)}::jsonb) AS d(
        ttlock_lock_id    bigint,
        alias             text,
        mac               text,
        battery           smallint,
        tz_offset_minutes integer,
        raw               jsonb
      )
      ON CONFLICT (tenant_id, ttlock_lock_id) DO UPDATE SET
        alias             = EXCLUDED.alias,
        mac               = EXCLUDED.mac,
        battery           = EXCLUDED.battery,
        tz_offset_minutes = EXCLUDED.tz_offset_minutes,
        raw               = EXCLUDED.raw,
        synced_at         = EXCLUDED.synced_at,
        missing_since     = NULL,
        updated_at        = now()
      RETURNING (xmax = 0) AS inserted`;

    for (const r of rows) {
      if (r.inserted) added += 1;
      else updated += 1;
    }
  }

  // Anything this tenant has that the response did not carry gets STAMPED.
  // `missing_since IS NULL` keeps the FIRST absence as the recorded date — a
  // lock missing for a week must not read as missing since this morning.
  // Carried as text[] and cast: ttlock_lock_id is a bigint and a JS number
  // array would be inferred as int4[], which silently stops matching past
  // 2^31. TTLock ids are already 9 digits.
  const seen = devices.map((d) => String(d.lockId));
  const stamped = seen.length
    ? await db<{ id: string }[]>`
        UPDATE guesthub.ttlock_locks
        SET missing_since = ${syncedAt}, updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND missing_since IS NULL
          AND ttlock_lock_id <> ALL(${seen}::bigint[])
        RETURNING id`
    : await db<{ id: string }[]>`
        UPDATE guesthub.ttlock_locks
        SET missing_since = ${syncedAt}, updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND missing_since IS NULL
        RETURNING id`;

  return { total: devices.length, added, updated, missing: stamped.length };
}
