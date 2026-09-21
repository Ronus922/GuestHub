import "server-only";
import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { BiosBotError, type BiosBotErrorCode } from "./errors";

// ============================================================
// GuestHub-side write idempotency for the BIOS Bot Service API (Phase 5 §11,
// migration 092). Defense in depth: BIOS Bot's own Phase 4 idempotency
// covers its side; this is GuestHub's own durable guarantee, independent of
// it, because GuestHub's reservation writes had NONE before this phase.
//
// See the migration's header for the full semantics. In one sentence: the
// idempotency claim (status='pending'), the business write, and the
// finalize update all commit in ONE transaction, so a row is only ever
// visible to another transaction once it is completely finished — there is
// no way to observe "in progress" from outside, and an incomplete
// execution (crash, unexpected exception) leaves no trace and is safe to
// retry fresh.
//
// The claim itself uses INSERT ... ON CONFLICT DO NOTHING against the
// table's UNIQUE(tenant_id, operation, idempotency_key) index — this is
// the ONLY correct way to make "concurrent same key executes exactly once"
// true even for the very first request with a given key: Postgres blocks a
// second concurrent INSERT on that unique index until the first transaction
// commits or rolls back (a SELECT ... FOR UPDATE would NOT do this, since
// there is nothing to lock before any row exists).
// ============================================================

// Deterministic, recursively key-sorted JSON — the SAME technique the
// pricing engine's quoteFingerprint uses (src/lib/pricing/engine.ts) — so
// field order in the caller's JSON body never produces a false CONFLICT.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

export function hashBiosBotRequest(request: unknown): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

type IdempotencyOutcome<T> =
  | { kind: "conflict" }
  | { kind: "failed"; code: BiosBotErrorCode; message: string }
  | { kind: "succeeded"; response: T };

type IdempotencyRow = {
  request_hash: string;
  status: "pending" | "succeeded" | "failed";
  response: unknown;
  error_code: string | null;
  error_message: string | null;
};

export type BiosBotIdempotencyContext = {
  tenantId: string;
  operation: string;
  idempotencyKey: string;
  request: unknown;
};

// run() receives the SAVEPOINT it must use for its own writes — a savepoint,
// not the outer transaction, so a thrown BiosBotError rolls back ONLY the
// partial business writes and leaves the outer transaction (and the
// idempotency claim already inserted on it) alive to record the failure.
export async function withBiosBotIdempotency<T>(
  db: Sql,
  ctx: BiosBotIdempotencyContext,
  run: (tx: TransactionSql) => Promise<{ resourceId: string | null; response: T }>,
): Promise<T> {
  const requestHash = hashBiosBotRequest(ctx.request);

  const outcome = await db.begin(async (tx): Promise<IdempotencyOutcome<T>> => {
    const claimed = await tx<{ id: string }[]>`
      INSERT INTO guesthub.bios_bot_idempotency_keys (tenant_id, operation, idempotency_key, request_hash)
      VALUES (${ctx.tenantId}, ${ctx.operation}, ${ctx.idempotencyKey}, ${requestHash})
      ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING
      RETURNING id`;

    if (claimed.length === 0) {
      // Lost the race (or this key was used before, possibly long ago) — by
      // the time we can see this row, it is guaranteed to be finished
      // (status 'succeeded' or 'failed'; see the module header).
      const [existing] = await tx<IdempotencyRow[]>`
        SELECT request_hash, status, response, error_code, error_message
        FROM guesthub.bios_bot_idempotency_keys
        WHERE tenant_id = ${ctx.tenantId} AND operation = ${ctx.operation} AND idempotency_key = ${ctx.idempotencyKey}`;
      if (!existing || existing.request_hash !== requestHash) return { kind: "conflict" };
      if (existing.status === "succeeded") return { kind: "succeeded", response: existing.response as T };
      return {
        kind: "failed",
        code: (existing.error_code ?? "INTERNAL_ERROR") as BiosBotErrorCode,
        message: existing.error_message ?? "the previous attempt with this Idempotency-Key failed",
      };
    }

    // We won the claim — run the real business write on a SAVEPOINT so a
    // BiosBotError rolls back only the partial write, never our own claim.
    try {
      const { resourceId, response } = await tx.savepoint((sp) => run(sp));
      await tx`
        UPDATE guesthub.bios_bot_idempotency_keys
        SET status = 'succeeded', resource_id = ${resourceId}, response = ${tx.json(response as never)}, completed_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND operation = ${ctx.operation} AND idempotency_key = ${ctx.idempotencyKey}`;
      return { kind: "succeeded", response };
    } catch (e) {
      if (!(e instanceof BiosBotError)) throw e; // an unexpected defect rolls back EVERYTHING — safe to retry
      await tx`
        UPDATE guesthub.bios_bot_idempotency_keys
        SET status = 'failed', error_code = ${e.code}, error_message = ${e.message}, completed_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND operation = ${ctx.operation} AND idempotency_key = ${ctx.idempotencyKey}`;
      return { kind: "failed", code: e.code, message: e.message };
    }
  });

  if (outcome.kind === "conflict") {
    throw new BiosBotError("IDEMPOTENCY_CONFLICT", "this Idempotency-Key was already used with a different request");
  }
  if (outcome.kind === "failed") throw new BiosBotError(outcome.code, outcome.message);
  return outcome.response;
}
