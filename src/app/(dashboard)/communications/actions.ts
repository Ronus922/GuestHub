"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import { sql } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { structuredTemplateContentSchema } from "@/lib/communications/schemas";
import { loadPreviewDatasets, propertyOnlyContext } from "@/lib/communications/automation";
import { claimDeliveryById, deliverClaimedEmail } from "@/lib/communications/delivery";
import { renderStructuredCommunication, renderTemplateString } from "@/lib/communications/renderer";

export type CommunicationActionResult = { success: true; id?: string; message?: string } | { success: false; error: string };

function fail(error: unknown): CommunicationActionResult {
  if (error instanceof AuthorizationError) return { success: false, error: error.message };
  if (error instanceof z.ZodError) return { success: false, error: "יש שדות חסרים או לא תקינים" };
  if ((error as { code?: string })?.code === "23505") return { success: false, error: "כבר קיים פריט בשם הזה" };
  return { success: false, error: "לא ניתן לשמור כרגע. נסו שוב." };
}

function refresh(): void {
  for (const route of ["automations", "templates", "history", "channels", "archive"])
    revalidatePath(`/communications/${route}`);
}

const STAGES = [
  "reservation", "pre_arrival", "check_in", "in_stay",
  "check_out", "post_stay", "cancellation", "payment",
] as const;

const templateInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120),
  subject: z.string().trim().min(2).max(240),
  senderDisplayName: z.string().trim().max(120).optional(),
  replyTo: z.string().trim().email().or(z.literal("")).optional(),
  preheader: z.string().trim().max(240).optional(),
  category: z.enum(STAGES).default("reservation"),
  language: z.enum(["he", "en"]).default("he"),
  content: structuredTemplateContentSchema,
});

export async function saveTemplateDraftAction(raw: unknown): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.templates.edit");
    const input = templateInputSchema.parse(raw);
    const id = input.id ?? randomUUID();
    await sql.begin(async (tx) => {
      if (input.id) {
        const rows = await tx<{ id: string }[]>`
          UPDATE guesthub.message_templates SET name = ${input.name}, subject = ${input.subject},
            body = ${input.subject}, draft_content = ${sql.json(input.content as never)},
            draft_sender_display_name = ${input.senderDisplayName || null},
            draft_reply_to = ${input.replyTo || null},
            draft_preheader = ${input.preheader || null},
            category = ${input.category}, language = ${input.language},
            lifecycle_state = CASE WHEN lifecycle_state = 'archived' THEN 'draft' ELSE lifecycle_state END,
            updated_by = ${actor.userId}, archived_at = NULL
          WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} RETURNING id`;
        if (!rows[0]) throw new AuthorizationError("התבנית לא נמצאה");
      } else {
        await tx`
          INSERT INTO guesthub.message_templates
            (id, tenant_id, channel, slug, name, subject, body, category, language,
             lifecycle_state, draft_content, draft_sender_display_name, draft_reply_to,
             draft_preheader, is_active, is_system, created_by, updated_by)
          VALUES (${id}, ${actor.tenantId}, 'email', ${`custom_${id}`}, ${input.name}, ${input.subject},
            ${input.subject}, ${input.category}, ${input.language}, 'draft',
            ${sql.json(input.content as never)}, ${input.senderDisplayName || null},
            ${input.replyTo || null}, ${input.preheader || null},
            true, false, ${actor.userId}, ${actor.userId})`;
      }
      await writeAudit(actor, { entityType: "message_template", entityId: id,
        action: input.id ? "template_draft_updated" : "template_created",
        after: { name: input.name, channel: "email" } }, tx);
    });
    refresh();
    return { success: true, id, message: "הטיוטה נשמרה" };
  } catch (error) { return fail(error); }
}

/** Duplicate as a fresh DRAFT — never as a published template, and never carrying version history. */
export async function duplicateTemplateAction(templateId: string): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.templates.edit");
    const source = z.string().uuid().parse(templateId);
    const id = randomUUID();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO guesthub.message_templates
        (id, tenant_id, channel, slug, name, subject, body, category, language,
         lifecycle_state, draft_content, draft_sender_display_name, draft_reply_to,
         draft_preheader, is_active, is_system, created_by, updated_by)
      SELECT ${id}, m.tenant_id, m.channel, ${`custom_${id}`},
             left(m.name || ' — עותק', 120), m.subject, m.body, m.category, m.language,
             'draft', m.draft_content, m.draft_sender_display_name, m.draft_reply_to,
             m.draft_preheader, true, false, ${actor.userId}, ${actor.userId}
      FROM guesthub.message_templates m
      WHERE m.id = ${source} AND m.tenant_id = ${actor.tenantId}
      RETURNING id`;
    if (!rows[0]) return { success: false, error: "התבנית לא נמצאה" };
    await writeAudit(actor, { entityType: "message_template", entityId: id,
      action: "template_duplicated", after: { sourceTemplateId: source } });
    refresh();
    return { success: true, id, message: "התבנית שוכפלה כטיוטה" };
  } catch (error) { return fail(error); }
}

/**
 * Restore a published version INTO the draft. History is immutable (a DB trigger
 * enforces it): restoring never rewrites v2, it re-opens its content for editing,
 * and publishing again produces a new version number.
 */
export async function restoreTemplateVersionAction(versionId: string): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.templates.edit");
    const id = z.string().uuid().parse(versionId);
    const rows = await sql<{ template_id: string; version_number: number }[]>`
      UPDATE guesthub.message_templates m
      SET draft_content = v.content, subject = v.subject, body = v.subject,
          draft_preheader = v.preheader,
          draft_sender_display_name = v.sender_display_name,
          draft_reply_to = CASE WHEN v.reply_to_behavior = 'custom' THEN v.reply_to_address ELSE NULL END,
          updated_by = ${actor.userId}
      FROM guesthub.message_template_versions v
      WHERE v.id = ${id} AND v.tenant_id = ${actor.tenantId}
        AND m.id = v.template_id AND m.tenant_id = v.tenant_id
      RETURNING v.template_id, v.version_number`;
    if (!rows[0]) return { success: false, error: "הגרסה לא נמצאה" };
    await writeAudit(actor, { entityType: "message_template", entityId: rows[0].template_id,
      action: "template_version_restored", after: { version: rows[0].version_number } });
    refresh();
    return { success: true, id: rows[0].template_id,
      message: `תוכן גרסה ${rows[0].version_number} הועתק לטיוטה. פרסמו כדי להפוך אותו לפעיל.` };
  } catch (error) { return fail(error); }
}

export async function publishTemplateAction(raw: unknown): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.templates.publish");
    const input = templateInputSchema.extend({ id: z.string().uuid() }).parse(raw);
    let version = 1;
    await sql.begin(async (tx) => {
      const [locked] = await tx<{ id: string }[]>`
        SELECT id FROM guesthub.message_templates
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId} FOR UPDATE`;
      if (!locked) throw new AuthorizationError("התבנית לא נמצאה");
      const [row] = await tx<{ next_version: number }[]>`
        SELECT COALESCE(MAX(version_number), 0)::int + 1 AS next_version
        FROM guesthub.message_template_versions WHERE template_id = ${input.id}`;
      version = row.next_version;
      const [published] = await tx<{ id: string }[]>`
        INSERT INTO guesthub.message_template_versions
          (tenant_id, template_id, version_number, sender_display_name, reply_to_behavior,
           reply_to_address, subject, preheader, content, published_by)
        VALUES (${actor.tenantId}, ${input.id}, ${version}, ${input.senderDisplayName || null},
          ${input.replyTo ? "custom" : "channel_default"}, ${input.replyTo || null}, ${input.subject},
          ${input.preheader || null}, ${sql.json(input.content as never)}, ${actor.userId}) RETURNING id`;
      await tx`
        UPDATE guesthub.message_templates SET name = ${input.name}, subject = ${input.subject},
          body = ${input.subject}, draft_content = ${sql.json(input.content as never)},
          draft_sender_display_name = ${input.senderDisplayName || null},
          draft_reply_to = ${input.replyTo || null},
          draft_preheader = ${input.preheader || null},
          category = ${input.category}, language = ${input.language},
          current_published_version_id = ${published.id}, lifecycle_state = 'published',
          is_active = true, archived_at = NULL, updated_by = ${actor.userId}
        WHERE id = ${input.id} AND tenant_id = ${actor.tenantId}`;
      await writeAudit(actor, { entityType: "message_template", entityId: input.id,
        action: "template_published", after: { version, name: input.name } }, tx);
    });
    refresh();
    return { success: true, id: input.id, message: `גרסה ${version} פורסמה` };
  } catch (error) { return fail(error); }
}

export async function archiveTemplateAction(templateId: string, restore = false): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.templates.edit");
    const id = z.string().uuid().parse(templateId);
    if (!restore) {
      const [usage] = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM guesthub.communication_automations
        WHERE tenant_id = ${actor.tenantId} AND template_id = ${id}
          AND status IN ('active','needs_attention') AND archived_at IS NULL`;
      if ((usage?.n ?? 0) > 0) return { success: false, error: "התבנית משויכת לאוטומציה פעילה. יש להשבית אותה קודם." };
    }
    let changed = false;
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        UPDATE guesthub.message_templates
        SET lifecycle_state = ${restore ? "draft" : "archived"}, is_active = ${restore},
            archived_at = ${restore ? null : new Date()}, updated_by = ${actor.userId}
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING id`;
      changed = Boolean(rows[0]);
      if (changed) await writeAudit(actor, { entityType: "message_template", entityId: id,
        action: restore ? "template_restored" : "template_archived" }, tx);
    });
    if (!changed) return { success: false, error: "התבנית לא נמצאה" };
    refresh();
    return { success: true, message: restore ? "התבנית שוחזרה כטיוטה" : "התבנית הועברה לארכיון" };
  } catch (error) { return fail(error); }
}

const testSendSchema = templateInputSchema.extend({
  to: z.string().trim().email(),
  reservationId: z.string().uuid().nullable().optional(),
});

/**
 * "שליחת בדיקה" — a real send, through the real provider, with the real renderer.
 *
 * It reuses the worker's delivery path end-to-end (lease → attempt row → provider
 * → error classification), so the operator learns the TRUE outcome rather than a
 * mock success. The row is delivery_type='test': persisted and auditable, but
 * never counted as a message to the guest (data.ts filters it out of history),
 * which is exactly what the dialog promises.
 */
export async function sendTestEmailAction(raw: unknown): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.test.send");
    const input = testSendSchema.parse(raw);

    const context = input.reservationId
      ? (await loadPreviewDatasets(actor.tenantId, 25)).find((d) => d.id === input.reservationId)?.context
        ?? await propertyOnlyContext(actor.tenantId)
      : await propertyOnlyContext(actor.tenantId);

    const rendered = renderStructuredCommunication(input.content, context, { preheader: input.preheader });
    const subject = renderTemplateString(input.subject, context);
    if (!rendered.html.trim() || !subject.value.trim()) {
      return { success: false, error: "התבנית ריקה — אין מה לשלוח" };
    }

    const [row] = await sql<{ id: string }[]>`
      INSERT INTO guesthub.outbound_messages
        (tenant_id, channel, provider, template_id, to_address, subject, body,
         status, rendered_sender_name, rendered_reply_to, rendered_preheader,
         rendered_html, rendered_plain_text, delivery_type, scheduled_at,
         max_attempts, created_by)
      VALUES (${actor.tenantId}, 'email', 'gmail', ${input.id ?? null}, ${input.to},
        ${`[בדיקה] ${subject.value}`}, ${rendered.plainText}, 'queued',
        ${input.senderDisplayName || null}, ${input.replyTo || null},
        ${input.preheader || null}, ${rendered.html}, ${rendered.plainText},
        'test', now(), 1, ${actor.userId})
      RETURNING id`;

    const workerId = `test:${actor.userId}`;
    const claimed = await claimDeliveryById(row.id, actor.tenantId, workerId);
    if (!claimed) return { success: false, error: "לא ניתן להתחיל את שליחת הבדיקה" };
    const outcome = await deliverClaimedEmail(claimed, workerId);

    await writeAudit(actor, { entityType: "message_template", entityId: input.id ?? null,
      action: "template_test_sent", after: { outcome, deliveryId: row.id } });

    if (outcome === "sent") return { success: true, message: `אימייל הבדיקה נשלח אל ${input.to}` };
    const [failure] = await sql<{ error_detail: string | null }[]>`
      SELECT error_detail FROM guesthub.outbound_messages WHERE id = ${row.id}`;
    return { success: false, error: failure?.error_detail || "שליחת הבדיקה נכשלה" };
  } catch (error) { return fail(error); }
}

const automationInputSchema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(), triggerType: z.literal("reservation.confirmed"),
  templateId: z.string().uuid(), sources: z.array(z.enum(["back_office", "direct_website"])).min(1),
  activate: z.boolean().default(false),
});

export async function saveAutomationAction(raw: unknown): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.automations.manage");
    const input = automationInputSchema.parse(raw);
    if (input.activate) requirePermission(actor, "communications.automations.activate");
    const [template] = await sql<{ current_published_version_id: string | null }[]>`
      SELECT current_published_version_id FROM guesthub.message_templates
      WHERE tenant_id = ${actor.tenantId} AND id = ${input.templateId} AND channel = 'email'`;
    if (!template) return { success: false, error: "התבנית שנבחרה אינה זמינה" };
    const [provider] = await sql<{ ready: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM guesthub.messaging_provider_connections
        WHERE tenant_id = ${actor.tenantId} AND provider IN ('gmail','gmail_smtp')
          AND status = 'connected' AND last_tested_at IS NOT NULL AND secret_ciphertext IS NOT NULL) AS ready`;
    const requestedActive = input.activate && Boolean(template.current_published_version_id) && Boolean(provider?.ready);
    const status = input.activate ? (requestedActive ? "active" : "needs_attention") : "draft";
    const attention = input.activate && !requestedActive
      ? (!template.current_published_version_id ? "נדרשת תבנית מפורסמת" : "ערוץ האימייל אינו מחובר או לא עבר בדיקה") : null;
    const id = input.id ?? randomUUID();
    const rows = input.id ? await sql<{ id: string }[]>`
      UPDATE guesthub.communication_automations SET name = ${input.name}, description = ${input.description || null},
        trigger_type = ${input.triggerType}, source_filters = ${sql.json({ include: input.sources } as never)},
        template_id = ${input.templateId}, status = ${status}, attention_reason = ${attention}, updated_by = ${actor.userId}
      WHERE tenant_id = ${actor.tenantId} AND id = ${input.id} RETURNING id`
      : await sql<{ id: string }[]>`
      INSERT INTO guesthub.communication_automations
        (id, tenant_id, name, description, stage, status, attention_reason, trigger_type,
         timing_config, source_filters, conditions, exclusion_rules, recipient_config,
         channel, template_id, template_version_policy, duplicate_policy, manual_activation_enabled,
         created_by, updated_by)
      VALUES (${id}, ${actor.tenantId}, ${input.name}, ${input.description || null}, 'reservation', ${status}, ${attention},
        ${input.triggerType}, ${sql.json({ mode: "immediate", quietHours: "bypass" } as never)},
        ${sql.json({ include: input.sources } as never)},
        ${sql.json({ logic: "all", items: [
          { field: "reservation.status", operator: "equals", value: "confirmed" },
          { field: "guest.email", operator: "exists" },
          { field: "reservation.is_test", operator: "equals", value: false },
          { field: "reservation.is_cancelled", operator: "equals", value: false },
        ] } as never)}, ${sql.json({ guestCommunicationOptOut: true, ota: true } as never)},
        ${sql.json({ type: "primary_guest" } as never)}, 'email', ${input.templateId}, 'latest_published',
        'once_per_event', true, ${actor.userId}, ${actor.userId}) RETURNING id`;
    if (!rows[0]) return { success: false, error: "האוטומציה לא נמצאה" };
    await writeAudit(actor, { entityType: "communication_automation", entityId: id,
      action: input.id ? "automation_updated" : "automation_created", after: { status, triggerType: input.triggerType } });
    refresh();
    return { success: true, id, message: requestedActive ? "האוטומציה הופעלה לאירועים חדשים בלבד" : attention ?? "האוטומציה נשמרה כטיוטה" };
  } catch (error) { return fail(error); }
}

export async function setAutomationStatusAction(idRaw: string, operation: "activate" | "disable" | "delete"): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, operation === "delete" ? "communications.automations.manage" : "communications.automations.activate");
    const id = z.string().uuid().parse(idRaw);
    if (operation === "activate") {
      const [ready] = await sql<{ template_ready: boolean; provider_ready: boolean }[]>`
        SELECT (m.current_published_version_id IS NOT NULL
                -- an archived template must not reach a guest through an automation
                -- that was merely disabled and is now being switched back on
                AND m.archived_at IS NULL AND m.lifecycle_state <> 'archived') AS template_ready,
          EXISTS(SELECT 1 FROM guesthub.messaging_provider_connections p
            WHERE p.tenant_id = a.tenant_id AND p.provider IN ('gmail','gmail_smtp')
              AND p.status = 'connected' AND p.last_tested_at IS NOT NULL AND p.secret_ciphertext IS NOT NULL) AS provider_ready
        FROM guesthub.communication_automations a
        JOIN guesthub.message_templates m ON m.id = a.template_id AND m.tenant_id = a.tenant_id
        WHERE a.id = ${id} AND a.tenant_id = ${actor.tenantId}`;
      if (!ready) return { success: false, error: "האוטומציה לא נמצאה" };
      if (!ready.template_ready || !ready.provider_ready)
        return { success: false, error: !ready.template_ready
          ? "יש לפרסם תבנית פעילה (לא בארכיון) לפני הפעלה"
          : "יש לחבר ולבדוק את ערוץ האימייל לפני הפעלה" };
    }
    let changed = false;
    await sql.begin(async (tx) => {
      const result = operation === "delete" ? await tx<{ id: string }[]>`
        UPDATE guesthub.communication_automations SET status = 'archived', archived_at = now(), updated_by = ${actor.userId}
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} AND status IN ('draft','disabled') RETURNING id`
        : await tx<{ id: string }[]>`
        UPDATE guesthub.communication_automations SET status = ${operation === "activate" ? "active" : "disabled"},
          attention_reason = NULL, updated_by = ${actor.userId}
        WHERE tenant_id = ${actor.tenantId} AND id = ${id} RETURNING id`;
      changed = Boolean(result[0]);
      if (changed) await writeAudit(actor, { entityType: "communication_automation", entityId: id, action: `automation_${operation}` }, tx);
    });
    if (!changed) return { success: false, error: operation === "delete" ? "ניתן למחוק רק טיוטה או אוטומציה מושבתת" : "האוטומציה לא נמצאה" };
    refresh();
    return { success: true, message: operation === "activate" ? "האוטומציה הופעלה לאירועים חדשים בלבד" : operation === "disable" ? "האוטומציה הושבתה" : "האוטומציה נמחקה; היסטוריית השליחה נשמרה" };
  } catch (error) { return fail(error); }
}

// Only what the send path actually OBEYS. Quiet hours and failure notifications
// have columns (and Zod schemas) ready for the day an automation can be delayed
// or alerted on — but nothing reads them yet, and a switch that silently does
// nothing is worse than no switch, so the UI does not offer them.
const settingsSchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
});

export async function saveCommunicationSettingsAction(raw: unknown): Promise<CommunicationActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "communications.channels.manage");
    const input = settingsSchema.parse(raw);
    await sql.begin(async (tx) => {
      await tx`
      INSERT INTO guesthub.communication_settings (tenant_id, retry_policy, created_by, updated_by)
      VALUES (${actor.tenantId},
        ${sql.json({ maxAttempts: input.maxAttempts, baseDelaySeconds: 60, maxDelaySeconds: 3600 } as never)},
        ${actor.userId}, ${actor.userId})
      ON CONFLICT (tenant_id) DO UPDATE SET retry_policy = EXCLUDED.retry_policy,
        updated_by = EXCLUDED.updated_by`;
      await writeAudit(actor, { entityType: "communication_settings", entityId: actor.tenantId,
        action: "communication_settings_updated", after: { maxAttempts: input.maxAttempts } }, tx);
    });
    refresh();
    return { success: true, message: "כללי התקשורת נשמרו" };
  } catch (error) { return fail(error); }
}
