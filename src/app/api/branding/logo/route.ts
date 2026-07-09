import { NextResponse } from "next/server";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, isRealImage } from "@/lib/uploads/image";
import { logoUploadsDir, logoUploadPath, logoUrl } from "@/lib/business/uploads";

// Business logo upload. Session-authenticated + settings.edit (the settings-
// management permission), tenant-scoped. Reuses the shared raster allow-list +
// magic-byte check (lib/uploads/image.ts) and the durable uploads store. The
// served URL is persisted into tenants.settings.business_profile.logo; the file
// bytes never enter the DB. Replacing a logo deletes the previous file.

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    requirePermission(actor, "settings.edit");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "קלט לא תקין" }, { status: 400 });
    const ext = IMAGE_TYPES[file.type];
    if (!ext) return NextResponse.json({ error: "פורמט לא נתמך — JPG, PNG או WEBP" }, { status: 400 });
    if (file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: "קובץ גדול מ-15MB" }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());
    if (!isRealImage(buf, file.type)) return NextResponse.json({ error: "הקובץ אינו תמונה תקינה" }, { status: 400 });

    const name = `${crypto.randomUUID()}${ext}`;
    const filePath = logoUploadPath(actor.tenantId, name);
    await mkdir(logoUploadsDir(actor.tenantId), { recursive: true });
    await writeFile(filePath, buf);
    const url = logoUrl(actor.tenantId, name);

    // Persist the URL onto the profile, capturing the previous logo so we can
    // delete its file and audit replacement vs first upload.
    let previous: string | null = null;
    try {
      previous = await sql.begin(async (tx) => {
        const [row] = await tx<{ logo: string | null }[]>`
          SELECT settings->'business_profile'->>'logo' AS logo
          FROM guesthub.tenants WHERE id = ${actor.tenantId} FOR UPDATE`;
        const prev = row?.logo ?? null;
        await tx`
          UPDATE guesthub.tenants
          SET settings = jsonb_set(
                jsonb_set(COALESCE(settings, '{}'::jsonb), '{business_profile}',
                          COALESCE(settings->'business_profile', '{}'::jsonb), true),
                '{business_profile,logo}', to_jsonb(${url}::text), true),
              updated_at = now()
          WHERE id = ${actor.tenantId}`;
        const ctx = await auditRequestContext();
        await writeAudit(
          actor,
          {
            entityType: "tenant",
            entityId: actor.tenantId,
            action: prev ? "business_logo_replaced" : "business_logo_uploaded",
            after: { logo: url },
            ip: ctx.ip,
            session: ctx.session,
          },
          tx,
        );
        return prev;
      });
    } catch (e) {
      await rm(filePath, { force: true }); // no orphan file if the row write fails
      throw e;
    }

    // Best-effort cleanup of the replaced file (only ours, only in the logos dir).
    if (previous && previous.startsWith(`/uploads/logos/${actor.tenantId}/`)) {
      const prevName = previous.split("/").pop() ?? "";
      if (/^[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(prevName)) {
        await rm(logoUploadPath(actor.tenantId, prevName), { force: true });
      }
    }

    return NextResponse.json({ logo: url });
  } catch (e) {
    if (e instanceof AuthorizationError) return NextResponse.json({ error: e.message }, { status: 403 });
    console.error("[branding:logo-upload]", e);
    return NextResponse.json({ error: "אירעה שגיאה בלתי צפויה" }, { status: 500 });
  }
}
