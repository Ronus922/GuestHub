"use server";

import { revalidatePath } from "next/cache";
import type { TransactionSql } from "postgres";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";
import { getBusinessProfile } from "@/lib/business/store";
import { logoUploadPath } from "@/lib/business/uploads";
import { rm } from "node:fs/promises";
import {
  computeBusinessProfileStatus,
  validateBusinessProfileInput,
  validateLocationInput,
  type BusinessProfile,
  type BusinessProfileStatus,
  type BusinessProfileInput,
  type LocationInput,
  type StoredBusinessProfile,
} from "@/lib/business/profile";

// Business Profile mutations. Same gate as every other settings action —
// requirePermission("settings.edit") — except the Google manual-coordinate
// OVERRIDE, which is super_admin only (§6/§11). Canonical currency/timezone are
// never written here. Audits record changed FIELD NAMES + safe metadata only,
// never full values of contact/address fields beyond what the event needs.

export type BusinessProfileContext = {
  profile: BusinessProfile;
  status: BusinessProfileStatus;
  tenant: { name: string; currency: string; timezone: string };
  isSuperAdmin: boolean;
  googleMapsConfigured: boolean;
};

function fail(e: unknown, tag: string): ActionResult {
  if (e instanceof AuthorizationError) return { success: false, error: e.message };
  console.error(`[business:${tag}]`, e);
  return { success: false, error: "אירעה שגיאה בלתי צפויה" };
}

export async function getBusinessProfileContextAction(): Promise<ActionResult<BusinessProfileContext>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    const profile = await getBusinessProfile(actor.tenantId);
    if (!profile) return { success: false, error: "לא נמצא ארגון (tenant) פעיל" };
    return {
      success: true,
      data: {
        profile,
        status: computeBusinessProfileStatus(profile),
        tenant: { name: profile.publicBusinessName, currency: profile.currency, timezone: profile.timezone },
        isSuperAdmin: actor.roleKey === "super_admin",
        googleMapsConfigured: !!process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY,
      },
    };
  } catch (e) {
    return fail(e, "context");
  }
}

// Read-modify-write the whole business_profile object under a row lock, applying
// only the validated patch keys. updatedAt/updatedBy are stamped server-side.
async function applyPatch(
  tenantId: string,
  userId: string,
  patch: StoredBusinessProfile,
  tx: TransactionSql,
): Promise<{ before: StoredBusinessProfile; after: StoredBusinessProfile }> {
  const [row] = await tx<{ business_profile: StoredBusinessProfile | null }[]>`
    SELECT settings->'business_profile' AS business_profile
    FROM guesthub.tenants WHERE id = ${tenantId} FOR UPDATE`;
  const before = row?.business_profile ?? {};
  const after: StoredBusinessProfile = {
    ...before,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
  await tx`
    UPDATE guesthub.tenants
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{business_profile}', ${sql.json(
      after as never,
    )}::jsonb, true),
        updated_at = now()
    WHERE id = ${tenantId}`;
  return { before, after };
}

export async function saveBusinessProfileAction(input: BusinessProfileInput): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");
    const v = validateBusinessProfileInput(input);
    if (!v.ok) return { success: false, error: v.error };
    if (Object.keys(v.patch).length === 0) return { success: true };

    const auditCtx = await auditRequestContext();
    await sql.begin(async (tx) => {
      const { before } = await applyPatch(actor.tenantId, actor.userId, v.patch, tx);
      const firstTime = !before.businessName && !before.propertyName;
      await writeAudit(
        actor,
        {
          entityType: "tenant",
          entityId: actor.tenantId,
          action: firstTime ? "business_profile_created" : "business_profile_updated",
          after: { fields: Object.keys(v.patch) }, // NAMES only
          ip: auditCtx.ip,
          session: auditCtx.session,
        },
        tx,
      );
    });
    revalidatePath("/settings");
    return { success: true };
  } catch (e) {
    return fail(e, "save");
  }
}

// Save a location resolved from Google (place select / marker adjustment) or a
// super_admin manual override. Coordinates are validated server-side; a manual
// override requires super_admin AND explicit confirmation (§6).
export async function saveBusinessLocationAction(
  input: LocationInput & { confirmed?: boolean },
): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");

    if (input.source === "manual_override") {
      if (actor.roleKey !== "super_admin")
        return { success: false, error: "מיקום ידני מתקדם זמין למנהל-על בלבד" };
      if (!input.confirmed)
        return { success: false, error: "נדרש אישור מפורש לדריסת המיקום ידנית" };
    }
    if ((input.source === "google_marker_adjustment" || input.source === "manual_override") && !input.confirmed)
      return { success: false, error: "נדרש אישור לשינוי המיקום" };

    const v = validateLocationInput(input);
    if (!v.ok) return { success: false, error: v.error };
    v.patch.locationVerifiedAt = new Date().toISOString();

    const action =
      input.source === "manual_override"
        ? "manual_location_override_confirmed"
        : input.source === "google_marker_adjustment"
          ? "google_marker_location_confirmed"
          : "google_location_selected";

    const auditCtx = await auditRequestContext();
    await sql.begin(async (tx) => {
      await applyPatch(actor.tenantId, actor.userId, v.patch, tx);
      await writeAudit(
        actor,
        {
          entityType: "tenant",
          entityId: actor.tenantId,
          action,
          // safe metadata only — a place id + source, never raw Google bodies
          after: { source: input.source, googlePlaceId: v.patch.googlePlaceId ?? null },
          ip: auditCtx.ip,
          session: auditCtx.session,
        },
        tx,
      );
    });
    revalidatePath("/settings");
    return { success: true };
  } catch (e) {
    return fail(e, "location");
  }
}

export async function removeBusinessLogoAction(): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "settings.edit");

    const auditCtx = await auditRequestContext();
    const removed = await sql.begin(async (tx) => {
      const [row] = await tx<{ logo: string | null }[]>`
        SELECT settings->'business_profile'->>'logo' AS logo
        FROM guesthub.tenants WHERE id = ${actor.tenantId} FOR UPDATE`;
      const prev = row?.logo ?? null;
      if (!prev) return null;
      await tx`
        UPDATE guesthub.tenants
        SET settings = jsonb_set(settings, '{business_profile}',
              (COALESCE(settings->'business_profile', '{}'::jsonb) - 'logo'), true),
            updated_at = now()
        WHERE id = ${actor.tenantId}`;
      await writeAudit(
        actor,
        {
          entityType: "tenant",
          entityId: actor.tenantId,
          action: "business_logo_removed",
          ip: auditCtx.ip,
          session: auditCtx.session,
        },
        tx,
      );
      return prev;
    });

    // Best-effort delete of our own file only.
    if (removed && removed.startsWith(`/uploads/logos/${actor.tenantId}/`)) {
      const name = removed.split("/").pop() ?? "";
      if (/^[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(name)) {
        await rm(logoUploadPath(actor.tenantId, name), { force: true });
      }
    }
    revalidatePath("/settings");
    return { success: true };
  } catch (e) {
    return fail(e, "logo-remove");
  }
}
