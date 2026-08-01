"use server";

import { z } from "zod";
import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageTTLock } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { sql } from "@/lib/db";
import {
  getConnection,
  getResolvedConnection,
  upsertConnection,
  updateConnectionStatus,
  clearConnection,
  ttlockSecretsConfigured,
} from "@/lib/ttlock/store";
import { resolveTTLockAccessToken, TTLockNotConfiguredError } from "@/lib/ttlock/token";
import { ttlockAuthedRequest, TTLockError, hebrewMessageFor } from "@/lib/ttlock/http";
import type { ActionResult } from "../calendar/types";
import type { TTLockSettingsView } from "./types";

// ============================================================
// TTLock connection settings actions (D120) — super_admin ONLY, enforced
// server-side on EVERY action (hiding the section in the UI is not security).
// The clientSecret and the account password are integration credentials: they
// are stored encrypted and NEVER returned to a client, never written to an
// audit payload, an error message or a log. Neither is the access token.
// ============================================================

const SECRETS_KEY_MISSING = "מפתח ההצפנה TTLOCK_SECRETS_KEY אינו מוגדר בשרת";
const NOT_CONFIGURED = "חיבור TTLock טרם הוגדר";

const saveSchema = z.object({
  region: z.enum(["eu", "global"]),
  clientId: z.string().trim().min(1, "יש להזין מזהה אפליקציה"),
  username: z.string().trim().min(1, "יש להזין שם משתמש"),
  // Blank = keep the stored value. The UI never renders a secret back into an
  // input, so "unchanged" legitimately arrives as an empty string.
  clientSecret: z.string().optional(),
  password: z.string().optional(),
});

export type SaveTTLockInput = z.infer<typeof saveSchema>;

async function requireTTLockAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  const guard = canManageTTLock({ userId: actor.userId, roleKey: actor.roleKey });
  if (!guard.ok) throw new AuthorizationError(guard.error);
  return actor;
}

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  if (e instanceof TTLockNotConfiguredError) return { success: false, error: NOT_CONFIGURED };
  // A TTLockError is translated by CODE only. hebrewMessageFor never echoes the
  // upstream errmsg — it is Chinese, and for 10001 it actively misleads about
  // which half of the credential is wrong.
  if (e instanceof TTLockError) return { success: false, error: hebrewMessageFor(e.errcode) };
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

// Audit payloads carry the NON-secret identifiers only. No clientSecret, no
// password, no token, no upstream body — ever.
async function audit(actor: Actor, action: string, after: Record<string, unknown>): Promise<void> {
  const ctx = await auditRequestContext();
  await writeAudit(actor, {
    entityType: "ttlock_connection",
    entityId: null,
    action,
    after,
    ip: ctx.ip,
    session: ctx.session,
  });
}

/** Masked view for the settings screen. Never carries a secret or a token. */
export async function getTTLockSettingsAction(): Promise<ActionResult<TTLockSettingsView>> {
  try {
    const actor = await requireTTLockAdmin();
    const connection = await getConnection(actor.tenantId);
    return { success: true, data: { secretsKeyConfigured: ttlockSecretsConfigured(), connection } };
  } catch (e) {
    return failFrom(e);
  }
}

export async function saveTTLockConnectionAction(input: SaveTTLockInput): Promise<ActionResult> {
  try {
    const actor = await requireTTLockAdmin();
    if (!ttlockSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "נתונים שגויים" };
    }
    const v = parsed.data;

    await upsertConnection(actor.tenantId, {
      region: v.region,
      clientId: v.clientId,
      username: v.username,
      clientSecret: v.clientSecret,
      password: v.password,
    });

    await audit(actor, "ttlock.connection.save", {
      region: v.region,
      clientId: v.clientId,
      username: v.username,
      // WHETHER a secret was supplied, never the secret itself.
      clientSecretProvided: Boolean(v.clientSecret?.trim()),
      passwordProvided: Boolean(v.password?.trim()),
    });

    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

/**
 * Prove the connection end to end.
 *
 * WHY /v3/lock/list AND NOT THE TOKEN CALL ALONE. A token proves the
 * credentials parse and the account exists. It does not prove the account can
 * actually REACH any lock — a fresh TTLock account with no locks shared to it
 * mints a perfectly valid token and controls nothing. The lock list is the
 * first call that touches the thing the operator cares about, and the count it
 * returns is the number they can compare against the apartments they know they
 * have. A token-only probe would report "תקין" on an account that can never
 * open a door.
 */
export async function testTTLockConnectionAction(): Promise<
  ActionResult<{ ok: boolean; message: string; lockCount: number | null }>
> {
  try {
    const actor = await requireTTLockAdmin();
    if (!ttlockSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const resolved = await getResolvedConnection(actor.tenantId);
    if (!resolved) {
      await updateConnectionStatus(actor.tenantId, "not_configured", NOT_CONFIGURED);
      return { success: true, data: { ok: false, message: NOT_CONFIGURED, lockCount: null } };
    }

    let lockCount: number;
    try {
      // The token lives in this frame and nowhere else.
      const accessToken = await resolveTTLockAccessToken(sql, resolved);
      const body = await ttlockAuthedRequest(
        resolved.region,
        "/v3/lock/list",
        { clientId: resolved.client_id, accessToken },
        { pageNo: "1", pageSize: "100" },
      );
      const list = Array.isArray(body.list) ? body.list : [];
      const total = typeof body.total === "number" ? body.total : list.length;
      lockCount = total;
    } catch (e) {
      // Failure path: a Hebrew message derived from the CODE, persisted and
      // returned. The upstream body never reaches the operator or the row.
      const message =
        e instanceof TTLockError
          ? hebrewMessageFor(e.errcode)
          : e instanceof TTLockNotConfiguredError
            ? NOT_CONFIGURED
            : "החיבור נכשל — לא ניתן להגיע ל-TTLock";
      await updateConnectionStatus(actor.tenantId, "error", message);
      await audit(actor, "ttlock.connection.test", { result: "error", detail: message });
      return { success: true, data: { ok: false, message, lockCount: null } };
    }

    const message = `החיבור תקין — נמצאו ${lockCount} מנעולים`;
    await updateConnectionStatus(actor.tenantId, "connected", message);
    await audit(actor, "ttlock.connection.test", { result: "connected", lockCount });

    return { success: true, data: { ok: true, message, lockCount } };
  } catch (e) {
    return failFrom(e);
  }
}

export async function clearTTLockConnectionAction(): Promise<ActionResult> {
  try {
    const actor = await requireTTLockAdmin();
    await clearConnection(actor.tenantId);
    await audit(actor, "ttlock.connection.clear", { cleared: true });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}
