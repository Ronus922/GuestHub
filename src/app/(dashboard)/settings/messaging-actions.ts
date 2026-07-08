"use server";

import { getActor, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageMessaging } from "@/lib/auth/guards";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import {
  getConnection,
  getResolvedConnection,
  upsertConnection,
  updateConnectionStatus,
  clearConnectionSecret,
  getActiveWhatsAppProvider,
  setActiveWhatsAppProvider,
  maskConnection,
  secretHintsFrom,
  messagingSecretsConfigured,
  generateWebhookToken,
} from "@/lib/messaging/store";
import { buildEmailProvider, buildWhatsAppProvider } from "@/lib/messaging/providers";
import { sendEmailMessage } from "@/lib/messaging/service";
import type {
  GmailConfig,
  GreenApiConfig,
  TwilioConfig,
  TestResult,
  WhatsAppProviderId,
} from "@/lib/messaging/types";
import type { ActionResult } from "../calendar/types";
import type { MessagingSettingsView } from "./types";

// ============================================================
// Messaging-provider settings actions (D53) — super_admin ONLY, enforced
// server-side on every action (UI hiding is not security). Provider CREDENTIALS
// are integration secrets: they are stored encrypted and NEVER returned to a
// client, never placed in an audit payload, an error message or a log.
// ============================================================

const SECRETS_KEY_MISSING = "מפתח ההצפנה MESSAGING_SECRETS_ENCRYPTION_KEY אינו מוגדר בשרת";
const PROVIDER_NOT_CONFIGURED = "הספק טרם הוגדר";

async function requireMessagingAdmin(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AuthorizationError("לא מחובר למערכת");
  const guard = canManageMessaging({ userId: actor.userId, roleKey: actor.roleKey });
  if (!guard.ok) throw new AuthorizationError(guard.error);
  return actor;
}

function failFrom(e: unknown): { success: false; error: string } {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  if (e instanceof Error && e.message.startsWith("ניהול")) return { success: false, error: e.message };
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

async function audit(actor: Actor, action: string, after: Record<string, unknown>): Promise<void> {
  const ctx = await auditRequestContext();
  await writeAudit(actor, {
    entityType: "messaging_provider",
    entityId: null,
    action,
    after,
    ip: ctx.ip,
    session: ctx.session,
  });
}

// One secret field: keep the stored value when the incoming input is blank,
// otherwise take the (trimmed) new value. Blank stays blank when nothing existed.
function mergeSecret(incoming: string | undefined, existing: unknown): string | undefined {
  const next = typeof incoming === "string" ? incoming.trim() : "";
  if (next !== "") return next;
  return typeof existing === "string" && existing ? existing : undefined;
}

function hasIncomingSecret(bag: Record<string, string | undefined>): boolean {
  return Object.values(bag).some((v) => typeof v === "string" && v.trim() !== "");
}

// Drop undefined entries so the encrypted bag carries only real values.
function compact(bag: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) if (v !== undefined) out[k] = v;
  return out;
}

// The opaque webhook token is minted once on first save and preserved on every
// later save (rotating it would silently break a configured provider callback).
function keepOrMintWebhookToken(config: Record<string, unknown> | undefined): string {
  const existing = config?.webhookToken;
  return typeof existing === "string" && existing ? existing : generateWebhookToken();
}

// 1) Load the masked settings view for all three providers.
export async function getMessagingSettingsAction(): Promise<ActionResult<MessagingSettingsView>> {
  try {
    const actor = await requireMessagingAdmin();
    const [gmailConn, gmailRes, greenConn, greenRes, twilioConn, twilioRes, activeWhatsApp] =
      await Promise.all([
        getConnection(actor.tenantId, "gmail"),
        getResolvedConnection(actor.tenantId, "gmail"),
        getConnection(actor.tenantId, "green_api"),
        getResolvedConnection(actor.tenantId, "green_api"),
        getConnection(actor.tenantId, "twilio"),
        getResolvedConnection(actor.tenantId, "twilio"),
        getActiveWhatsAppProvider(actor.tenantId),
      ]);

    const gmailMasked = maskConnection(gmailConn, gmailRes ? secretHintsFrom(gmailRes.secrets) : {});
    const greenMasked = maskConnection(greenConn, greenRes ? secretHintsFrom(greenRes.secrets) : {});
    const twilioMasked = maskConnection(twilioConn, twilioRes ? secretHintsFrom(twilioRes.secrets) : {});

    const gc = (gmailConn?.config ?? {}) as Partial<GmailConfig>;
    const grc = (greenConn?.config ?? {}) as Partial<GreenApiConfig>;
    const tc = (twilioConn?.config ?? {}) as Partial<TwilioConfig>;

    const view: MessagingSettingsView = {
      secretsKeyConfigured: messagingSecretsConfigured(),
      gmail: {
        configured: gmailMasked.configured,
        status: gmailMasked.status,
        statusDetail: gmailMasked.statusDetail,
        lastTestedAt: gmailMasked.lastTestedAt,
        secretHints: gmailMasked.secretHints,
        mode: gc.mode === "smtp" ? "smtp" : "oauth",
        senderEmail: gc.senderEmail ?? "",
        senderName: gc.senderName ?? "",
        replyTo: gc.replyTo ?? "",
        smtpHost: gc.smtpHost ?? "",
        smtpPort: typeof gc.smtpPort === "number" ? gc.smtpPort : null,
        smtpSecure: gc.smtpSecure ?? true,
      },
      greenApi: {
        configured: greenMasked.configured,
        status: greenMasked.status,
        statusDetail: greenMasked.statusDetail,
        lastTestedAt: greenMasked.lastTestedAt,
        secretHints: greenMasked.secretHints,
        apiHost: grc.apiHost ?? "",
        instanceId: grc.instanceId ?? "",
        senderNumber: grc.senderNumber ?? "",
        webhookToken: grc.webhookToken ?? "",
      },
      twilio: {
        configured: twilioMasked.configured,
        status: twilioMasked.status,
        statusDetail: twilioMasked.statusDetail,
        lastTestedAt: twilioMasked.lastTestedAt,
        secretHints: twilioMasked.secretHints,
        fromNumber: tc.fromNumber ?? "",
        messagingServiceSid: tc.messagingServiceSid ?? "",
        statusCallbackUrl: tc.statusCallbackUrl ?? "",
        webhookToken: tc.webhookToken ?? "",
      },
      activeWhatsApp,
      webhookBaseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    };
    return { success: true, data: view };
  } catch (e) {
    return failFrom(e);
  }
}

// 2) Save Gmail config + secrets (merge — blank inputs keep the stored secret).
export async function saveGmailSettingsAction(input: {
  mode: "oauth" | "smtp";
  senderEmail: string;
  senderName: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number | null;
  smtpSecure: boolean;
  secrets: { clientId?: string; clientSecret?: string; refreshToken?: string; appPassword?: string };
}): Promise<ActionResult> {
  try {
    const actor = await requireMessagingAdmin();
    if (!messagingSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const existing = await getResolvedConnection(actor.tenantId, "gmail");
    const prev = existing?.secrets ?? {};
    const merged = {
      clientId: mergeSecret(input.secrets.clientId, prev.clientId),
      clientSecret: mergeSecret(input.secrets.clientSecret, prev.clientSecret),
      refreshToken: mergeSecret(input.secrets.refreshToken, prev.refreshToken),
      appPassword: mergeSecret(input.secrets.appPassword, prev.appPassword),
    };
    const secretsArg = hasIncomingSecret(input.secrets) ? compact(merged) : null;

    const config = {
      mode: input.mode,
      senderEmail: input.senderEmail.trim(),
      senderName: input.senderName.trim() || undefined,
      replyTo: input.replyTo.trim() || undefined,
      smtpHost: input.smtpHost.trim() || undefined,
      smtpPort: input.smtpPort ?? undefined,
      smtpSecure: input.smtpSecure,
    } satisfies GmailConfig;

    await upsertConnection({
      tenantId: actor.tenantId,
      provider: "gmail",
      config,
      secrets: secretsArg,
      userId: actor.userId,
    });
    await audit(actor, "messaging_provider_updated", { provider: "gmail", mode: input.mode });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 3) Save GREEN-API config + apiToken (merge apiToken). Mints the opaque webhook
//    token on first save; preserves it afterwards.
export async function saveGreenApiSettingsAction(input: {
  apiHost: string;
  instanceId: string;
  senderNumber: string;
  apiToken: string;
}): Promise<ActionResult> {
  try {
    const actor = await requireMessagingAdmin();
    if (!messagingSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const existing = await getResolvedConnection(actor.tenantId, "green_api");
    const prev = existing?.secrets ?? {};
    const apiToken = mergeSecret(input.apiToken, prev.apiToken);
    const secretsArg = hasIncomingSecret({ apiToken: input.apiToken }) ? compact({ apiToken }) : null;

    const config = {
      apiHost: input.apiHost.trim() || undefined,
      instanceId: input.instanceId.trim(),
      senderNumber: input.senderNumber.trim() || undefined,
      webhookToken: keepOrMintWebhookToken(existing?.config),
    } satisfies GreenApiConfig;

    await upsertConnection({
      tenantId: actor.tenantId,
      provider: "green_api",
      config,
      secrets: secretsArg,
      userId: actor.userId,
    });
    await audit(actor, "messaging_provider_updated", { provider: "green_api" });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 4) Save Twilio config + accountSid/authToken (merge both).
export async function saveTwilioSettingsAction(input: {
  fromNumber: string;
  messagingServiceSid: string;
  statusCallbackUrl: string;
  accountSid: string;
  authToken: string;
}): Promise<ActionResult> {
  try {
    const actor = await requireMessagingAdmin();
    if (!messagingSecretsConfigured()) return { success: false, error: SECRETS_KEY_MISSING };

    const existing = await getResolvedConnection(actor.tenantId, "twilio");
    const prev = existing?.secrets ?? {};
    const merged = {
      accountSid: mergeSecret(input.accountSid, prev.accountSid),
      authToken: mergeSecret(input.authToken, prev.authToken),
    };
    const secretsArg = hasIncomingSecret({ accountSid: input.accountSid, authToken: input.authToken })
      ? compact(merged)
      : null;

    const config = {
      fromNumber: input.fromNumber.trim(),
      messagingServiceSid: input.messagingServiceSid.trim() || undefined,
      statusCallbackUrl: input.statusCallbackUrl.trim() || undefined,
      webhookToken: keepOrMintWebhookToken(existing?.config),
    } satisfies TwilioConfig;

    await upsertConnection({
      tenantId: actor.tenantId,
      provider: "twilio",
      config,
      secrets: secretsArg,
      userId: actor.userId,
    });
    await audit(actor, "messaging_provider_updated", { provider: "twilio" });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 5) Flip the active WhatsApp provider pointer (never deletes inactive creds).
export async function setActiveWhatsAppProviderAction(provider: WhatsAppProviderId): Promise<ActionResult> {
  try {
    const actor = await requireMessagingAdmin();
    if (provider !== "green_api" && provider !== "twilio" && provider !== "disabled") {
      return { success: false, error: "ספק WhatsApp לא תקין" };
    }
    await setActiveWhatsAppProvider(actor.tenantId, provider);
    await audit(actor, "messaging_active_provider_changed", { provider });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 6) Validate stored credentials without sending anything; persist the result.
export async function testProviderConnectionAction(
  provider: "gmail" | "green_api" | "twilio",
): Promise<ActionResult<{ ok: boolean; detail: string; account: string | null }>> {
  try {
    const actor = await requireMessagingAdmin();
    const conn = await getResolvedConnection(actor.tenantId, provider);
    if (!conn || Object.keys(conn.secrets).length === 0) {
      return { success: false, error: PROVIDER_NOT_CONFIGURED };
    }

    let result: TestResult;
    if (provider === "gmail") {
      result = await buildEmailProvider(conn).testConnection();
    } else {
      const wa = buildWhatsAppProvider(provider, conn);
      if (!wa) return { success: false, error: PROVIDER_NOT_CONFIGURED };
      result = await wa.testConnection();
    }

    await updateConnectionStatus({
      tenantId: actor.tenantId,
      provider,
      status: result.ok ? "connected" : "error",
      statusDetail: result.detail,
      tested: true,
    });
    await audit(actor, "messaging_provider_tested", { provider, ok: result.ok });
    return { success: true, data: { ok: result.ok, detail: result.detail, account: result.account ?? null } };
  } catch (e) {
    return failFrom(e);
  }
}

// 7) Send a real test message. Email → shared service; WhatsApp → the SPECIFIC
// provider (not necessarily the active one), built directly from its connection.
export async function sendTestMessageAction(
  provider: "gmail" | "green_api" | "twilio",
  target: string,
): Promise<ActionResult<{ ok: boolean; detail: string }>> {
  try {
    const actor = await requireMessagingAdmin();
    const dest = target.trim();
    if (!dest) return { success: false, error: "יש להזין יעד לשליחת הודעת בדיקה" };

    if (provider === "gmail") {
      const outcome = await sendEmailMessage(actor, {
        reservationId: null,
        guestId: null,
        to: dest,
        subject: "הודעת בדיקה · GuestHub",
        body: "זוהי הודעת בדיקה ממערכת GuestHub.",
        templateId: null,
      });
      await audit(actor, "messaging_test_message", { provider, ok: outcome.ok });
      return {
        success: true,
        data: {
          ok: outcome.ok,
          detail: outcome.ok ? "הודעת הבדיקה נשלחה" : outcome.detail ?? "שליחת הודעת הבדיקה נכשלה",
        },
      };
    }

    const conn = await getResolvedConnection(actor.tenantId, provider);
    if (!conn || Object.keys(conn.secrets).length === 0) {
      return { success: false, error: PROVIDER_NOT_CONFIGURED };
    }
    const wa = buildWhatsAppProvider(provider, conn);
    if (!wa) return { success: false, error: PROVIDER_NOT_CONFIGURED };
    const phone = normalizePhone(dest);
    if (!phone.valid) return { success: false, error: "מספר הטלפון אינו תקין" };

    const result = await wa.sendMessage({ to: phone.e164, body: "זוהי הודעת בדיקה ממערכת GuestHub." });
    const ok = result.status !== "failed" && result.status !== "validation_failed";
    await audit(actor, "messaging_test_message", { provider, ok });
    return {
      success: true,
      data: { ok, detail: ok ? "הודעת הבדיקה נשלחה" : result.errorDetail ?? "שליחת הודעת הבדיקה נכשלה" },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// 8) Disconnect: clear the encrypted secret (config kept). WhatsApp pointer is
// left untouched — a later send honestly reports the provider as not configured.
export async function disconnectProviderAction(
  provider: "gmail" | "green_api" | "twilio",
): Promise<ActionResult> {
  try {
    const actor = await requireMessagingAdmin();
    await clearConnectionSecret(actor.tenantId, provider, actor.userId);
    await audit(actor, "messaging_provider_disconnected", { provider });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}

// 9) Rotate the opaque webhook token WITHOUT touching provider credentials. The
// old callback URL stops working immediately; the operator must repaste the new
// URL into the provider console. Credentials (secret_ciphertext) are preserved.
export async function rotateWebhookTokenAction(
  provider: "green_api" | "twilio",
): Promise<ActionResult> {
  try {
    const actor = await requireMessagingAdmin();
    const conn = await getConnection(actor.tenantId, provider);
    if (!conn) return { success: false, error: PROVIDER_NOT_CONFIGURED };
    const config = { ...conn.config, webhookToken: generateWebhookToken() };
    await upsertConnection({
      tenantId: actor.tenantId,
      provider,
      config,
      secrets: null, // keep the stored credentials untouched
      status: conn.status,
      statusDetail: conn.statusDetail,
      userId: actor.userId,
    });
    await audit(actor, "messaging_webhook_token_rotated", { provider });
    return { success: true };
  } catch (e) {
    return failFrom(e);
  }
}
