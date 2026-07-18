"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { canManageChannels } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { decryptSecret, channelSecretsConfigured } from "./crypto";
import { channexBaseUrl } from "./config";
import {
  createStripePaymentMethod,
  installApplication,
  listInstalledApplications,
} from "./channex-bookings";
import type { ChannexReqOpts } from "./channex-http";

// ============================================================
// Channex Stripe Tokenization administration (D77 §E).
//
// HONESTY RULES. Nothing here installs anything on page load or deploy —
// installation is one explicit, confirmed super_admin action. When Stripe is
// not connected/installed the status is shown as BLOCKED, never faked. The
// tokenization call runs only after an authenticated operator click, is
// idempotent per reservation (UNIQUE(reservation_id, provider) — a second
// click returns the existing method), and the returned reference is stored in
// reservation_payment_methods ONLY: it never appears in audit JSON, logs,
// errors or browser props (the client receives brand/last4/expiry alone).
// ============================================================

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
  console.error("[stripe-tokenization]", e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

type ConnRow = {
  id: string;
  state: string;
  environment: "staging" | "production";
  channex_property_id: string | null;
  api_key_ciphertext: string | null;
};

async function loadConnection(tenantId: string): Promise<ConnRow | null> {
  const [row] = await sql<ConnRow[]>`
    SELECT id, state, environment, channex_property_id, api_key_ciphertext
    FROM guesthub.channel_connections
    WHERE tenant_id = ${tenantId} AND provider = 'channex'
    ORDER BY environment LIMIT 1`;
  return row ?? null;
}

function credsOf(conn: ConnRow): ChannexReqOpts {
  return {
    apiKey: decryptSecret(conn.api_key_ciphertext!),
    baseUrl: channexBaseUrl(conn.environment),
  };
}

export type StripeTokenizationStatus = {
  connectionActive: boolean;
  propertyMapped: boolean;
  /** stripe_tokenization app installed on the Channex account */
  installed: boolean;
  environment: "staging" | "production" | null;
  /** honest blocker text when the chain is incomplete */
  blockedReason: string | null;
};

export async function getStripeTokenizationStatusAction(): Promise<Result<StripeTokenizationStatus>> {
  try {
    const actor = await requireChannelAdmin();
    const conn = await loadConnection(actor.tenantId);
    const base: StripeTokenizationStatus = {
      connectionActive: conn?.state === "active",
      propertyMapped: !!conn?.channex_property_id,
      installed: false,
      environment: conn?.environment ?? null,
      blockedReason: null,
    };
    if (!conn || conn.state !== "active" || !conn.channex_property_id || !conn.api_key_ciphertext) {
      return {
        success: true,
        data: { ...base, blockedReason: "אין חיבור Channex פעיל עם נכס ממופה" },
      };
    }
    if (!channelSecretsConfigured()) {
      return { success: true, data: { ...base, blockedReason: "מפתח ההצפנה של הערוצים אינו מוגדר" } };
    }
    const apps = await listInstalledApplications(credsOf(conn));
    if (!apps.ok) return { success: true, data: { ...base, blockedReason: apps.message } };
    const installed = apps.applications.some((a) => a.code === "stripe_tokenization");
    return {
      success: true,
      data: {
        ...base,
        installed,
        blockedReason: installed
          ? null
          : "אפליקציית Stripe Tokenization אינה מותקנת. נדרש גם חשבון Stripe מחובר ברמת בעל החשבון ב-Channex (מתבצע בממשק Channex בלבד).",
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}

// Explicit, confirmed super_admin installation — NEVER automatic.
export async function installStripeTokenizationAction(input: {
  confirmed: boolean;
}): Promise<Result<StripeTokenizationStatus>> {
  try {
    const actor = await requireChannelAdmin();
    if (!input.confirmed) return { success: false, error: "נדרש אישור מפורש להתקנה" };
    const conn = await loadConnection(actor.tenantId);
    if (!conn || conn.state !== "active" || !conn.channex_property_id || !conn.api_key_ciphertext)
      return { success: false, error: "אין חיבור Channex פעיל עם נכס ממופה" };
    const res = await installApplication(credsOf(conn), "stripe_tokenization", conn.channex_property_id);
    if (!res.ok) return { success: false, error: res.message };
    await writeAudit(actor, {
      entityType: "channel_connection",
      entityId: conn.id,
      action: "stripe_tokenization_install",
      after: { property_id: conn.channex_property_id },
    });
    return getStripeTokenizationStatusAction();
  } catch (e) {
    return failFrom(e);
  }
}

export type SecurePaymentMethodView = {
  provider: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  createdAt: string;
  reused: boolean;
};

// "יצירת אמצעי תשלום מאובטח" — booking-level tokenization (explicit click).
// Idempotent: an existing usable method is returned, never duplicated.
export async function createSecurePaymentMethodAction(input: {
  reservationId: string;
}): Promise<Result<SecurePaymentMethodView>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_manage");

    const [res] = await sql<
      { id: string; status: string; channel_connection_id: string | null; external_booking_id: string | null }[]
    >`
      SELECT id, status, channel_connection_id, external_booking_id
      FROM guesthub.reservations
      WHERE id = ${input.reservationId} AND tenant_id = ${actor.tenantId}`;
    if (!res) return { success: false, error: "הזמנה לא נמצאה" };
    if (res.status === "cancelled") return { success: false, error: "ההזמנה מבוטלת" };
    if (!res.channel_connection_id || !res.external_booking_id)
      return { success: false, error: "יצירת אמצעי תשלום מאובטח זמינה כרגע רק להזמנות ערוץ" };

    // idempotency: reuse before any network call
    const [existing] = await sql<
      { provider: string; brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; created_at: string }[]
    >`
      SELECT provider, brand, last4, exp_month, exp_year, created_at::text AS created_at
      FROM guesthub.reservation_payment_methods
      WHERE tenant_id = ${actor.tenantId} AND reservation_id = ${res.id} AND provider = 'stripe'`;
    if (existing) {
      return {
        success: true,
        data: {
          provider: existing.provider,
          brand: existing.brand,
          last4: existing.last4,
          expMonth: existing.exp_month,
          expYear: existing.exp_year,
          createdAt: existing.created_at,
          reused: true,
        },
      };
    }

    const [conn] = await sql<ConnRow[]>`
      SELECT id, state, environment, channex_property_id, api_key_ciphertext
      FROM guesthub.channel_connections
      WHERE id = ${res.channel_connection_id} AND state = 'active'`;
    if (!conn?.api_key_ciphertext) return { success: false, error: "חיבור הערוץ אינו פעיל" };

    const token = await createStripePaymentMethod(credsOf(conn), res.external_booking_id);
    if (!token.ok) return { success: false, error: token.message };

    // display metadata from the imported guarantee (D76) — safe fields only
    const [meta] = await sql<
      { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null }[]
    >`
      SELECT card_meta->>'brand' AS brand, card_meta->>'last4' AS last4,
             (card_meta->>'exp_month')::smallint AS exp_month,
             (card_meta->>'exp_year')::smallint AS exp_year
      FROM guesthub.channel_booking_revisions
      WHERE tenant_id = ${actor.tenantId} AND local_reservation_id = ${res.id}
        AND card_meta IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`;

    const view = await sql.begin(async (tx) => {
      // ON CONFLICT = a concurrent click raced us; keep the FIRST method
      const [row] = await tx<{ created_at: string; inserted: boolean }[]>`
        INSERT INTO guesthub.reservation_payment_methods
          (tenant_id, reservation_id, provider, provider_ref, brand, last4,
           exp_month, exp_year, created_by)
        VALUES (${actor.tenantId}, ${res.id}, 'stripe', ${token.reference},
                ${meta?.brand ?? null}, ${meta?.last4 ?? null},
                ${meta?.exp_month ?? null}, ${meta?.exp_year ?? null}, ${actor.userId})
        ON CONFLICT (reservation_id, provider) DO NOTHING
        RETURNING created_at::text AS created_at, true AS inserted`;
      // audit carries SAFE identifiers only — never the provider reference
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: res.id,
        action: "secure_payment_method_created",
        after: { provider: "stripe", brand: meta?.brand ?? null, last4: meta?.last4 ?? null, reused: !row },
      }, tx);
      return row;
    });

    return {
      success: true,
      data: {
        provider: "stripe",
        brand: meta?.brand ?? null,
        last4: meta?.last4 ?? null,
        expMonth: meta?.exp_month ?? null,
        expYear: meta?.exp_year ?? null,
        createdAt: view?.created_at ?? new Date().toISOString(),
        reused: !view,
      },
    };
  } catch (e) {
    return failFrom(e);
  }
}
