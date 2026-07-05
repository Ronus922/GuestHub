"use server";

import { rm } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";
import { roomOccupancySchema } from "@/lib/validation/commercial";
import { validateRoomOccupancy } from "@/lib/commercial/room-pricing";
import { getExtraGuestDefaults } from "@/lib/commercial/service";
import {
  roomWizardSchema,
  areaSchema,
  roomImageMetaSchema,
  boardStatusSchema,
  areaStatusSchema,
} from "@/lib/validation/rooms";
import { LANGS } from "@/lib/rooms/service";
import { roomUploadsDir, roomUploadPath, IMAGE_NAME_RE } from "@/lib/rooms/uploads";
import { z } from "zod";

// Room occupancy + extra-guest override save (§7/§8). Gated by rooms.edit
// (server-side; hiding a control is not authorization). Validates with the shared
// pure validator against the room's published state and the property's configured
// state, then writes in one transaction with an audit row. In inherit mode the
// override columns are NULLED — property values are never copied into the room.
export async function saveRoomOccupancyAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");

    const parsed = roomOccupancySchema.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const r = parsed.data;

    // load the room (tenant-scoped) for its published state
    const [room] = await sql<{ is_active: boolean; status: string }[]>`
      SELECT is_active, status FROM guesthub.rooms
      WHERE id = ${r.id} AND tenant_id = ${actor.tenantId}`;
    if (!room) return { success: false, error: "החדר לא נמצא" };

    const property = await getExtraGuestDefaults(actor.tenantId);
    const published = room.is_active && room.status === "available";

    // inherit mode → override values are irrelevant; validate against inherited pricing
    const override = r.extra_guest_pricing_mode === "override";
    const { errors } = validateRoomOccupancy({
      maxOccupancy: r.max_occupancy,
      maxAdults: r.max_adults,
      maxChildren: r.max_children,
      maxInfants: r.max_infants,
      defaultOccupancy: r.default_occupancy,
      includedOccupancy: r.included_occupancy,
      mode: r.extra_guest_pricing_mode,
      extra_adult: override ? r.extra_adult_override : null,
      extra_child: override ? r.extra_child_override : null,
      extra_infant: override ? r.extra_infant_override : null,
      published,
      propertyConfigured: property.configured,
    });
    if (errors.length) return { success: false, error: errors[0] };

    // null out overrides in inherit mode — never persist copies of property values
    const oa = override ? r.extra_adult_override : null;
    const oc = override ? r.extra_child_override : null;
    const oi = override ? r.extra_infant_override : null;
    const of = override ? r.charge_frequency_override : null;

    await sql.begin(async (tx) => {
      const [before] = await tx<Record<string, unknown>[]>`
        SELECT max_occupancy, max_adults, max_children, max_infants, default_occupancy,
               included_occupancy, extra_guest_pricing_mode,
               extra_adult_override::float8 AS extra_adult_override,
               extra_child_override::float8 AS extra_child_override,
               extra_infant_override::float8 AS extra_infant_override,
               charge_frequency_override
        FROM guesthub.rooms WHERE id = ${r.id} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      await tx`
        UPDATE guesthub.rooms SET
          max_occupancy = ${r.max_occupancy}, max_adults = ${r.max_adults},
          max_children = ${r.max_children}, max_infants = ${r.max_infants},
          default_occupancy = ${r.default_occupancy}, included_occupancy = ${r.included_occupancy},
          extra_guest_pricing_mode = ${r.extra_guest_pricing_mode},
          extra_adult_override = ${oa}, extra_child_override = ${oc},
          extra_infant_override = ${oi}, charge_frequency_override = ${of}
        WHERE id = ${r.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "room_occupancy",
        entityId: r.id,
        action: "update",
        before: before ?? null,
        after: {
          max_occupancy: r.max_occupancy, included_occupancy: r.included_occupancy,
          extra_guest_pricing_mode: r.extra_guest_pricing_mode,
          extra_adult_override: oa, extra_child_override: oc, extra_infant_override: oi,
        },
      }, tx);
    });

    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:save]", e);
    if ((e as { code?: string })?.code === "23514")
      return { success: false, error: "ערכי תפוסה אינם עקביים (חריגה ממגבלת המסד)" };
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// ============================================================
// Full Rooms module — wizard save, duplicate, delete, areas, image metadata.
// All mutations: permission-gated server-side, tenant-scoped, transactional,
// audited. Slug/room-number uniqueness is enforced by DB unique indexes and
// surfaced as friendly errors (duplicate-slug protection).
// ============================================================

function pgUniqueMessage(e: unknown): string | null {
  const err = e as { code?: string; constraint_name?: string; constraint?: string };
  if (err?.code !== "23505") return null;
  const c = err.constraint_name ?? err.constraint ?? "";
  if (c.includes("room_translations_slug")) return "כתובת ה-URL (slug) כבר בשימוש בשפה זו";
  if (c.includes("rooms_tenant_number")) return "מספר החדר כבר קיים";
  if (c.includes("operational_areas_code")) return "קוד האזור כבר קיים";
  return "ערך כפול — הרשומה כבר קיימת";
}

// Create/update a room from the wizard. Only the languages present in
// input.translations are written — other languages are never overwritten.
export async function saveRoomAction(raw: unknown): Promise<ActionResult & { id?: string }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");

    const parsed = roomWizardSchema.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const r = parsed.data;
    if (r.id === undefined) requirePermission(actor, "rooms.create");

    const property = await getExtraGuestDefaults(actor.tenantId);
    const published = r.is_active && r.status === "available";
    const override = r.extra_guest_pricing_mode === "override";
    const { errors } = validateRoomOccupancy({
      maxOccupancy: r.max_occupancy,
      maxAdults: r.max_adults,
      maxChildren: r.max_children,
      maxInfants: r.max_infants,
      minOccupancy: r.min_occupancy,
      defaultOccupancy: r.default_occupancy,
      includedOccupancy: r.included_occupancy,
      mode: r.extra_guest_pricing_mode,
      extra_adult: override ? r.extra_adult_override : null,
      extra_child: override ? r.extra_child_override : null,
      extra_infant: override ? r.extra_infant_override : null,
      published,
      propertyConfigured: property.configured,
    });
    if (errors.length) return { success: false, error: errors[0] };

    // never persist copies of property values in inherit mode
    const oa = override ? r.extra_adult_override : null;
    const oc = override ? r.extra_child_override : null;
    const oi = override ? r.extra_infant_override : null;
    const of = override ? r.charge_frequency_override : null;
    // operational room name follows the Hebrew translation
    const heName = r.translations.he?.name?.trim() || null;

    const id = await sql.begin(async (tx) => {
      let roomId = r.id;
      if (roomId) {
        const [exists] = await tx<{ id: string }[]>`
          SELECT id FROM guesthub.rooms WHERE id = ${roomId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
        if (!exists) throw new AuthorizationError("החדר לא נמצא");
        await tx`
          UPDATE guesthub.rooms SET
            room_number = ${r.room_number}, room_type_id = ${r.room_type_id},
            area_id = ${r.area_id}, floor = ${r.floor},
            status = ${r.status}, is_active = ${r.is_active},
            show_on_website = ${r.show_on_website}, sort_order = ${r.sort_order},
            size_sqm = ${r.size_sqm},
            max_occupancy = ${r.max_occupancy}, max_adults = ${r.max_adults},
            max_children = ${r.max_children}, max_infants = ${r.max_infants},
            min_occupancy = ${r.min_occupancy},
            default_occupancy = ${r.default_occupancy}, included_occupancy = ${r.included_occupancy},
            extra_guest_pricing_mode = ${r.extra_guest_pricing_mode},
            extra_adult_override = ${oa}, extra_child_override = ${oc},
            extra_infant_override = ${oi}, charge_frequency_override = ${of},
            single_beds = ${r.single_beds}, double_beds = ${r.double_beds},
            queen_beds = ${r.queen_beds}, sofa_beds = ${r.sofa_beds}, cribs = ${r.cribs},
            notes = ${r.notes ?? null},
            name = COALESCE(${heName}, name)
          WHERE id = ${roomId} AND tenant_id = ${actor.tenantId}`;
      } else {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO guesthub.rooms (
            tenant_id, room_number, room_type_id, area_id, floor, status, is_active,
            show_on_website, sort_order, size_sqm,
            max_occupancy, max_adults, max_children, max_infants,
            min_occupancy, default_occupancy, included_occupancy, extra_guest_pricing_mode,
            extra_adult_override, extra_child_override, extra_infant_override,
            charge_frequency_override,
            single_beds, double_beds, queen_beds, sofa_beds, cribs, name, notes)
          VALUES (
            ${actor.tenantId}, ${r.room_number}, ${r.room_type_id}, ${r.area_id},
            ${r.floor}, ${r.status}, ${r.is_active},
            ${r.show_on_website}, ${r.sort_order}, ${r.size_sqm},
            ${r.max_occupancy}, ${r.max_adults}, ${r.max_children}, ${r.max_infants},
            ${r.min_occupancy}, ${r.default_occupancy}, ${r.included_occupancy}, ${r.extra_guest_pricing_mode},
            ${oa}, ${oc}, ${oi}, ${of},
            ${r.single_beds}, ${r.double_beds}, ${r.queen_beds}, ${r.sofa_beds},
            ${r.cribs}, ${heName}, ${r.notes ?? null})
          RETURNING id`;
        roomId = row.id;
      }

      // upsert ONLY the provided languages (protects the rest from overwrite)
      for (const lang of LANGS) {
        const t = r.translations[lang];
        if (!t) continue;
        await tx`
          INSERT INTO guesthub.room_translations (
            tenant_id, room_id, lang, name, description, summary, slug,
            seo_title, meta_description, og_title, og_description, noindex)
          VALUES (
            ${actor.tenantId}, ${roomId}, ${lang}, ${t.name ?? null},
            ${t.description ?? null}, ${t.summary ?? null}, ${t.slug ?? null},
            ${t.seo_title ?? null}, ${t.meta_description ?? null},
            ${t.og_title ?? null}, ${t.og_description ?? null}, ${t.noindex})
          ON CONFLICT (room_id, lang) DO UPDATE SET
            name = EXCLUDED.name, description = EXCLUDED.description,
            summary = EXCLUDED.summary, slug = EXCLUDED.slug,
            seo_title = EXCLUDED.seo_title, meta_description = EXCLUDED.meta_description,
            og_title = EXCLUDED.og_title, og_description = EXCLUDED.og_description,
            noindex = EXCLUDED.noindex`;
      }

      // replace the amenity set
      await tx`DELETE FROM guesthub.room_amenities WHERE room_id = ${roomId} AND tenant_id = ${actor.tenantId}`;
      if (r.amenity_ids.length) {
        await tx`
          INSERT INTO guesthub.room_amenities (tenant_id, room_id, amenity_id)
          SELECT ${actor.tenantId}, ${roomId}, li.id
          FROM guesthub.lookup_items li
          WHERE li.tenant_id = ${actor.tenantId} AND li.category = 'amenities'
            AND li.id = ANY(${r.amenity_ids})`;
      }

      await writeAudit(actor, {
        entityType: "room",
        entityId: roomId,
        action: r.id ? "update" : "create",
        before: null,
        after: { room_number: r.room_number, status: r.status, langs: Object.keys(r.translations) },
      }, tx);
      return roomId;
    });

    revalidatePath("/rooms");
    return { success: true, id };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    const dup = pgUniqueMessage(e);
    if (dup) return { success: false, error: dup };
    console.error("[rooms:wizard-save]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// Duplicate a room: copies the room row (new number + " (עותק)" name), its
// translations (slug NOT copied — slugs are unique per language), amenities and
// image metadata + files. Never copies reservations/rates.
export async function duplicateRoomAction(roomId: string): Promise<ActionResult & { id?: string }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.create");
    if (!z.uuid().safeParse(roomId).success) return { success: false, error: "קלט לא תקין" };

    const id = await sql.begin(async (tx) => {
      const [src] = await tx<{ id: string; room_number: string }[]>`
        SELECT id, room_number FROM guesthub.rooms
        WHERE id = ${roomId} AND tenant_id = ${actor.tenantId}`;
      if (!src) throw new AuthorizationError("החדר לא נמצא");

      // first free "<number>-N" suffix
      const [{ n }] = await tx<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM guesthub.rooms
        WHERE tenant_id = ${actor.tenantId} AND room_number LIKE ${src.room_number + "-%"}`;
      const newNumber = `${src.room_number}-${n + 1}`;

      const [row] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.rooms (
          tenant_id, room_number, room_type_id, area_id, floor, status, is_active,
          show_on_website, sort_order, size_sqm, max_occupancy, max_adults,
          max_children, max_infants, min_occupancy, default_occupancy, included_occupancy,
          extra_guest_pricing_mode, extra_adult_override, extra_child_override,
          extra_infant_override, charge_frequency_override,
          single_beds, double_beds, queen_beds, sofa_beds, cribs, name, notes)
        SELECT tenant_id, ${newNumber}, room_type_id, area_id, floor, status, false,
               false, sort_order, size_sqm, max_occupancy, max_adults,
               max_children, max_infants, min_occupancy, default_occupancy, included_occupancy,
               extra_guest_pricing_mode, extra_adult_override, extra_child_override,
               extra_infant_override, charge_frequency_override,
               single_beds, double_beds, queen_beds, sofa_beds, cribs,
               CASE WHEN name IS NULL THEN NULL ELSE name || ' (עותק)' END, notes
        FROM guesthub.rooms WHERE id = ${roomId}
        RETURNING id`;
      const newId = row.id;

      await tx`
        INSERT INTO guesthub.room_translations (
          tenant_id, room_id, lang, name, description, summary, slug,
          seo_title, meta_description, og_title, og_description, noindex)
        SELECT tenant_id, ${newId}, lang,
               CASE WHEN name IS NULL THEN NULL ELSE name || ' (עותק)' END,
               description, summary, NULL, seo_title, meta_description,
               og_title, og_description, noindex
        FROM guesthub.room_translations WHERE room_id = ${roomId}`;

      await tx`
        INSERT INTO guesthub.room_amenities (tenant_id, room_id, amenity_id)
        SELECT tenant_id, ${newId}, amenity_id
        FROM guesthub.room_amenities WHERE room_id = ${roomId}`;

      // duplicated rows get their own copies in the durable uploads store
      const images = await tx<{ id: string; url: string; alt_text: string | null; is_main: boolean; sort_order: number }[]>`
        SELECT id, url, alt_text, is_main, sort_order
        FROM guesthub.room_images WHERE room_id = ${roomId}`;
      const { copyFile, mkdir } = await import("node:fs/promises");
      for (const img of images) {
        const srcName = path.basename(img.url);
        if (!IMAGE_NAME_RE.test(srcName)) continue;
        const newName = `${crypto.randomUUID()}${path.extname(srcName)}`;
        const newUrl = `/uploads/rooms/${newId}/${newName}`;
        try {
          await mkdir(roomUploadsDir(newId), { recursive: true });
          await copyFile(roomUploadPath(roomId, srcName), roomUploadPath(newId, newName));
        } catch {
          continue; // missing source file — skip rather than fail the duplicate
        }
        await tx`
          INSERT INTO guesthub.room_images (tenant_id, room_id, url, alt_text, is_main, sort_order)
          VALUES (${actor.tenantId}, ${newId}, ${newUrl}, ${img.alt_text}, ${img.is_main}, ${img.sort_order})`;
      }

      await writeAudit(actor, {
        entityType: "room",
        entityId: newId,
        action: "create",
        before: null,
        after: { duplicated_from: roomId, room_number: newNumber },
      }, tx);
      return newId;
    });

    revalidatePath("/rooms");
    return { success: true, id };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:duplicate]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// History-integrity delete rule (D49 closure): a room may be HARD-deleted only
// if it has never been used — zero rows in every dependency table. Any history
// (reservations incl. past, housekeeping, closures, rates, sellable-unit links,
// bulk-update history) blocks deletion with a category breakdown; such rooms are
// archived instead (חדר פעיל → כבוי). The room's own content (translations,
// images, amenities) is not usage history and cascades on a legitimate delete.
// reservation_rooms.room_id is additionally ON DELETE RESTRICT (migration 015),
// so reservation history can never lose its room even if this guard is bypassed.
export async function deleteRoomAction(roomId: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.delete");
    if (!z.uuid().safeParse(roomId).success) return { success: false, error: "קלט לא תקין" };

    const [deps] = await sql<
      { reservations: number; housekeeping: number; closures: number; rates: number; sellable: number; bulk: number }[]
    >`
      SELECT
        (SELECT COUNT(*)::int FROM guesthub.reservation_rooms WHERE room_id = ${roomId}) AS reservations,
        (SELECT COUNT(*)::int FROM guesthub.housekeeping_tasks WHERE room_id = ${roomId}) AS housekeeping,
        (SELECT COUNT(*)::int FROM guesthub.room_closures WHERE room_id = ${roomId}) AS closures,
        (SELECT COUNT(*)::int FROM guesthub.rates WHERE room_id = ${roomId}) AS rates,
        (SELECT COUNT(*)::int FROM guesthub.sellable_unit_rooms WHERE room_id = ${roomId}) AS sellable,
        (SELECT COUNT(*)::int FROM guesthub.bulk_rate_update_items WHERE room_id = ${roomId}) AS bulk`;
    const blockers = [
      [deps.reservations, "הזמנות (כולל היסטוריה)"],
      [deps.housekeeping, "היסטוריית ניקיון"],
      [deps.closures, "חסימות זמינות"],
      [deps.rates, "היסטוריית תעריפים"],
      [deps.sellable, "שיוך ליחידת מכירה"],
      [deps.bulk, "היסטוריית עדכונים קבוצתיים"],
    ].filter(([n]) => Number(n) > 0);
    if (blockers.length > 0) {
      const detail = blockers.map(([n, label]) => `${label} (${n})`).join(", ");
      return {
        success: false,
        error: `לא ניתן למחוק חדר עם היסטוריה — ${detail}. במקום מחיקה, השביתו את החדר (חדר פעיל → כבוי): ההיסטוריה וההזמנות נשמרות והחדר יוצא מהמלאי.`,
      };
    }

    await sql.begin(async (tx) => {
      const [room] = await tx<{ room_number: string }[]>`
        SELECT room_number FROM guesthub.rooms
        WHERE id = ${roomId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!room) throw new AuthorizationError("החדר לא נמצא");
      await tx`DELETE FROM guesthub.rooms WHERE id = ${roomId} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "room",
        entityId: roomId,
        action: "delete",
        before: { room_number: room.room_number },
        after: null,
      }, tx);
    });
    await rm(roomUploadsDir(roomId), { recursive: true, force: true });

    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:delete]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// ---- operational areas ----
export async function saveAreaAction(raw: unknown): Promise<ActionResult & { id?: string }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const parsed = areaSchema.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
    }
    const a = parsed.data;
    // auto code from type when omitted: LOBBY-1, POOL-2 …
    const code =
      a.code ??
      (await (async () => {
        const [{ n }] = await sql<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM guesthub.operational_areas
          WHERE tenant_id = ${actor.tenantId} AND area_type = ${a.area_type}`;
        return `${a.area_type.toUpperCase()}-${n + 1}`;
      })());

    const id = await sql.begin(async (tx) => {
      let areaId = a.id;
      if (areaId) {
        const [exists] = await tx<{ id: string }[]>`
          SELECT id FROM guesthub.operational_areas
          WHERE id = ${areaId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
        if (!exists) throw new AuthorizationError("האזור לא נמצא");
        await tx`
          UPDATE guesthub.operational_areas SET
            name = ${a.name}, code = ${code}, area_type = ${a.area_type},
            building_area_id = ${a.building_area_id}, floor = ${a.floor},
            is_active = ${a.is_active}, relevant_cleaning = ${a.relevant_cleaning},
            relevant_maintenance = ${a.relevant_maintenance}, status = ${a.status},
            status_note = ${a.status_note ?? null}, sort_order = ${a.sort_order},
            notes = ${a.notes ?? null}
          WHERE id = ${areaId} AND tenant_id = ${actor.tenantId}`;
      } else {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO guesthub.operational_areas (
            tenant_id, name, code, area_type, building_area_id, floor, is_active,
            relevant_cleaning, relevant_maintenance, status, status_note, sort_order, notes)
          VALUES (
            ${actor.tenantId}, ${a.name}, ${code}, ${a.area_type},
            ${a.building_area_id}, ${a.floor}, ${a.is_active},
            ${a.relevant_cleaning}, ${a.relevant_maintenance}, ${a.status},
            ${a.status_note ?? null}, ${a.sort_order}, ${a.notes ?? null})
          RETURNING id`;
        areaId = row.id;
      }
      await writeAudit(actor, {
        entityType: "operational_area",
        entityId: areaId,
        action: a.id ? "update" : "create",
        before: null,
        after: { name: a.name, area_type: a.area_type },
      }, tx);
      return areaId;
    });

    revalidatePath("/rooms");
    return { success: true, id };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    const dup = pgUniqueMessage(e);
    if (dup) return { success: false, error: dup };
    console.error("[rooms:area-save]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

export async function deleteAreaAction(areaId: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.delete");
    if (!z.uuid().safeParse(areaId).success) return { success: false, error: "קלט לא תקין" };
    await sql.begin(async (tx) => {
      const [area] = await tx<{ name: string }[]>`
        SELECT name FROM guesthub.operational_areas
        WHERE id = ${areaId} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!area) throw new AuthorizationError("האזור לא נמצא");
      await tx`DELETE FROM guesthub.operational_areas WHERE id = ${areaId} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "operational_area",
        entityId: areaId,
        action: "delete",
        before: { name: area.name },
        after: null,
      }, tx);
    });
    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:area-delete]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// ---- image metadata: alt text, main flag, order (upload/delete = API route) ----
export async function updateRoomImagesAction(roomId: string, raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const parsed = z.array(roomImageMetaSchema).max(50).safeParse(raw);
    if (!parsed.success || !z.uuid().safeParse(roomId).success) {
      return { success: false, error: "קלט לא תקין" };
    }
    await sql.begin(async (tx) => {
      // clear mains first so the partial unique index accepts the new main
      await tx`
        UPDATE guesthub.room_images SET is_main = false
        WHERE room_id = ${roomId} AND tenant_id = ${actor.tenantId}`;
      for (const img of parsed.data) {
        await tx`
          UPDATE guesthub.room_images
          SET alt_text = ${img.alt_text}, is_main = ${img.is_main}, sort_order = ${img.sort_order}
          WHERE id = ${img.id} AND room_id = ${roomId} AND tenant_id = ${actor.tenantId}`;
      }
    });
    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:image-meta]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

export async function deleteRoomImageAction(imageId: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    if (!z.uuid().safeParse(imageId).success) return { success: false, error: "קלט לא תקין" };
    const [img] = await sql<{ url: string; room_id: string }[]>`
      DELETE FROM guesthub.room_images
      WHERE id = ${imageId} AND tenant_id = ${actor.tenantId}
      RETURNING url, room_id`;
    if (!img) return { success: false, error: "התמונה לא נמצאה" };
    const name = path.basename(img.url);
    if (img.url.startsWith("/uploads/rooms/") && IMAGE_NAME_RE.test(name)) {
      await rm(roomUploadPath(img.room_id, name), { force: true });
    }
    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:image-delete]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// Board status popover (approved RoomsAndAreas interaction). Honest mapping to
// the canonical model — the popover never invents state the system can't hold:
//   פנוי     → rooms.status='available' + open housekeeping tasks completed
//   מלוכלך   → open housekeeping task set 'pending'   (created if none)
//   בניקיון  → open housekeeping task set 'in_progress' (created if none)
//   חסום     → rooms.status='out_of_order'
//   תחזוקה   → rooms.status='inactive'
// "תפוס" is derived from reservations and is not settable (schema rejects it).
export async function updateRoomBoardStatusAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const parsed = boardStatusSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: "קלט לא תקין" };
    const { room_id, target } = parsed.data;

    await sql.begin(async (tx) => {
      const [room] = await tx<{ status: string }[]>`
        SELECT status FROM guesthub.rooms
        WHERE id = ${room_id} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!room) throw new AuthorizationError("החדר לא נמצא");

      if (target === "blocked" || target === "maintenance") {
        await tx`
          UPDATE guesthub.rooms SET status = ${target === "blocked" ? "out_of_order" : "inactive"}
          WHERE id = ${room_id} AND tenant_id = ${actor.tenantId}`;
      } else {
        // free / dirty / cleaning all mean the room itself is operational
        await tx`
          UPDATE guesthub.rooms SET status = 'available'
          WHERE id = ${room_id} AND tenant_id = ${actor.tenantId}`;
        if (target === "free") {
          await tx`
            UPDATE guesthub.housekeeping_tasks
            SET status = 'completed', completed_at = now()
            WHERE tenant_id = ${actor.tenantId} AND room_id = ${room_id}
              AND status IN ('pending', 'in_progress')`;
        } else {
          const hk = target === "dirty" ? "pending" : "in_progress";
          const updated = await tx`
            UPDATE guesthub.housekeeping_tasks SET status = ${hk}
            WHERE tenant_id = ${actor.tenantId} AND room_id = ${room_id}
              AND status IN ('pending', 'in_progress')
            RETURNING id`;
          if (updated.length === 0) {
            await tx`
              INSERT INTO guesthub.housekeeping_tasks (tenant_id, room_id, status, notes)
              VALUES (${actor.tenantId}, ${room_id}, ${hk}, 'נוצר מלוח חדרים ואזורים')`;
          }
        }
      }

      await writeAudit(actor, {
        entityType: "room_board_status",
        entityId: room_id,
        action: "update",
        before: { status: room.status },
        after: { target },
      }, tx);
    });

    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:board-status]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

export async function updateAreaStatusAction(raw: unknown): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const parsed = areaStatusSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: "קלט לא תקין" };
    const { area_id, status } = parsed.data;

    await sql.begin(async (tx) => {
      const [area] = await tx<{ status: string }[]>`
        SELECT status FROM guesthub.operational_areas
        WHERE id = ${area_id} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!area) throw new AuthorizationError("האזור לא נמצא");
      await tx`
        UPDATE guesthub.operational_areas
        SET status = ${status}, status_note = CASE WHEN ${status} = 'ok' THEN NULL ELSE status_note END
        WHERE id = ${area_id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, {
        entityType: "operational_area",
        entityId: area_id,
        action: "update",
        before: { status: area.status },
        after: { status },
      }, tx);
    });

    revalidatePath("/rooms");
    return { success: true };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:area-status]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}

// Add a custom amenity to the tenant catalog (the wizard's "הוסף" button).
export async function addAmenityAction(label: string): Promise<ActionResult & { id?: string }> {
  try {
    const actor = await getActor();
    requirePermission(actor, "rooms.edit");
    const name = z.string().trim().min(1).max(60).safeParse(label);
    if (!name.success) return { success: false, error: "שם איבזור לא תקין" };
    const key = `custom_${Date.now().toString(36)}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.lookup_items (tenant_id, category, key, label, sort_order)
      VALUES (${actor.tenantId}, 'amenities', ${key}, ${name.data}, 100)
      RETURNING id`;
    revalidatePath("/rooms");
    return { success: true, id: row.id };
  } catch (e) {
    if (e instanceof AuthorizationError) return { success: false, error: e.message };
    console.error("[rooms:amenity-add]", e);
    return { success: false, error: "אירעה שגיאה בלתי צפויה" };
  }
}
