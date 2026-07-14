import "server-only";
import { sql } from "@/lib/db";

export type TemplateVersionRow = {
  id: string; version: number; publishedAt: string; publishedBy: string | null;
};

export type CommunicationTemplateRow = {
  id: string; name: string; subject: string; channel: "email" | "whatsapp";
  category: string; language: string; state: "draft" | "published" | "archived";
  version: number | null; usedBy: number;
  updatedAt: string; updatedBy: string | null; isSystem: boolean;
  senderDisplayName: string; replyTo: string; preheader: string;
  draftContent: Record<string, unknown> | null;
  versions: TemplateVersionRow[];
};

export type AutomationRow = {
  id: string; name: string; description: string | null; status: string;
  attentionReason: string | null; triggerType: string; channel: string;
  templateId: string; templateName: string; timing: Record<string, unknown>;
  sources: Record<string, unknown>; conditions: Record<string, unknown>;
  updatedAt: string; successCount: number; failureCount: number;
};

export type DeliveryRow = {
  id: string; reservationId: string | null; reservationNumber: string | null;
  guestName: string | null; toAddress: string; subject: string | null;
  channel: string; provider: string; status: string; errorDetail: string | null;
  createdAt: string; submittedAt: string | null; deliveredAt: string | null;
  automationName: string | null; templateName: string | null; attemptCount: number;
  attempts: { number: number; result: string; startedAt: string; completedAt: string | null; errorCategory: string | null }[];
  renderedSenderName: string | null; renderedReplyTo: string | null; renderedHtml: string | null;
  renderedPlainText: string | null; providerMessageId: string | null; scheduledAt: string | null;
  sentAt: string | null; templateVersionId: string | null; deliveryType: string;
  resendOfDeliveryId: string | null; resendReason: string | null; createdByName: string | null;
};

export type ChannelView = {
  email: { status: string; detail: string | null; lastTestedAt: string | null; sender: string | null };
  whatsappAvailable: false;
  smsAvailable: false;
};

export type CommunicationSettingsView = {
  quietHours: { enabled?: boolean; start?: string; end?: string };
  retryPolicy: { maxAttempts?: number; baseDelaySeconds?: number; maxDelaySeconds?: number };
  failureNotification: { enabled?: boolean; email?: string };
  manualBookingRecipients: string[];
  directBookingRecipients: string[];
};

export type CommunicationsData = {
  templates: CommunicationTemplateRow[];
  automations: AutomationRow[];
  deliveries: DeliveryRow[];
  channel: ChannelView;
  settings: CommunicationSettingsView;
};

export async function loadCommunicationsData(tenantId: string, access: { templates: boolean; automations: boolean; deliveries: boolean; channels: boolean }): Promise<CommunicationsData> {
  const [templates, automations, deliveries, emailConnection, settings] = await Promise.all([
    access.templates ? sql<{
      id: string; name: string; subject: string | null; channel: string; category: string;
      language: string; lifecycle_state: string; version_number: number | null; used_by: number;
      updated_at: string; updated_by_name: string | null;
      is_system: boolean; draft_sender_display_name: string | null; draft_reply_to: string | null;
      draft_preheader: string | null; draft_content: Record<string, unknown> | null;
      versions: TemplateVersionRow[];
    }[]>`
      SELECT m.id, m.name, m.subject, m.channel, m.category, m.language,
             m.lifecycle_state, v.version_number,
             (SELECT COUNT(*)::int FROM guesthub.communication_automations a
               WHERE a.tenant_id = m.tenant_id AND a.template_id = m.id
                 AND a.archived_at IS NULL) AS used_by,
             m.updated_at::text AS updated_at, u.full_name AS updated_by_name,
             m.is_system, m.draft_sender_display_name, m.draft_reply_to,
             m.draft_preheader, m.draft_content,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                 'id', mv.id, 'version', mv.version_number,
                 'publishedAt', mv.published_at::text, 'publishedBy', pu.full_name
               ) ORDER BY mv.version_number DESC)
               FROM guesthub.message_template_versions mv
               LEFT JOIN guesthub.users pu ON pu.id = mv.published_by AND pu.tenant_id = mv.tenant_id
               WHERE mv.tenant_id = m.tenant_id AND mv.template_id = m.id
             ), '[]'::jsonb) AS versions
      FROM guesthub.message_templates m
      LEFT JOIN guesthub.message_template_versions v ON v.id = m.current_published_version_id
      LEFT JOIN guesthub.users u ON u.id = m.updated_by AND u.tenant_id = m.tenant_id
      WHERE m.tenant_id = ${tenantId}
      ORDER BY m.archived_at NULLS FIRST, m.updated_at DESC` : Promise.resolve([]),
    access.automations ? sql<{
      id: string; name: string; description: string | null; status: string;
      attention_reason: string | null; trigger_type: string; channel: string;
      template_id: string; template_name: string; timing_config: Record<string, unknown>;
      source_filters: Record<string, unknown>; conditions: Record<string, unknown>;
      updated_at: string; success_count: number; failure_count: number;
    }[]>`
      SELECT a.id, a.name, a.description, a.status, a.attention_reason, a.trigger_type,
             a.channel, a.template_id, m.name AS template_name, a.timing_config,
             a.source_filters, a.conditions, a.updated_at::text AS updated_at,
             COUNT(o.id) FILTER (WHERE o.status IN ('submitted','sent','delivered','read'))::int AS success_count,
             COUNT(o.id) FILTER (WHERE o.status IN ('failed','undelivered','provider_not_configured','validation_failed'))::int AS failure_count
      FROM guesthub.communication_automations a
      JOIN guesthub.message_templates m ON m.id = a.template_id AND m.tenant_id = a.tenant_id
      LEFT JOIN guesthub.outbound_messages o ON o.automation_id = a.id AND o.tenant_id = a.tenant_id
      WHERE a.tenant_id = ${tenantId} AND a.archived_at IS NULL
      GROUP BY a.id, m.name
      ORDER BY a.updated_at DESC` : Promise.resolve([]),
    access.deliveries ? sql<{
      id: string; reservation_id: string | null; reservation_number: string | null;
      guest_name: string | null; to_address: string; subject: string | null; channel: string;
      provider: string; status: string; error_detail: string | null; created_at: string;
      submitted_at: string | null; delivered_at: string | null; automation_name: string | null;
      template_name: string | null; attempt_count: number;
      attempts: { number: number; result: string; startedAt: string; completedAt: string | null; errorCategory: string | null }[];
      rendered_sender_name: string | null; rendered_reply_to: string | null; rendered_html: string | null;
      rendered_plain_text: string | null; provider_message_id: string | null; scheduled_at: string | null;
      sent_at: string | null; template_version_id: string | null; delivery_type: string;
      resend_of_delivery_id: string | null; resend_reason: string | null; created_by_name: string | null;
    }[]>`
      SELECT o.id, o.reservation_id, r.reservation_number, g.full_name AS guest_name,
             o.to_address, o.subject, o.channel, o.provider, o.status, o.error_detail,
             o.created_at::text AS created_at, o.submitted_at::text AS submitted_at,
             o.delivered_at::text AS delivered_at, a.name AS automation_name,
             m.name AS template_name, o.attempt_count, o.rendered_sender_name, o.rendered_reply_to,
             o.rendered_html, o.rendered_plain_text, o.provider_message_id,
             o.scheduled_at::text AS scheduled_at, o.sent_at::text AS sent_at,
             o.template_version_id, o.delivery_type, o.resend_of_delivery_id, o.resend_reason,
             u.full_name AS created_by_name,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'number', da.attempt_number, 'result', da.result, 'startedAt', da.started_at::text,
               'completedAt', da.completed_at::text, 'errorCategory', da.error_category
             ) ORDER BY da.attempt_number)
             FROM guesthub.communication_delivery_attempts da
             WHERE da.tenant_id = o.tenant_id AND da.delivery_id = o.id), '[]'::jsonb) AS attempts
      FROM guesthub.outbound_messages o
      LEFT JOIN guesthub.reservations r ON r.id = o.reservation_id AND r.tenant_id = o.tenant_id
      LEFT JOIN guesthub.guests g ON g.id = o.guest_id AND g.tenant_id = o.tenant_id
      LEFT JOIN guesthub.communication_automations a ON a.id = o.automation_id AND a.tenant_id = o.tenant_id
      LEFT JOIN guesthub.message_templates m ON m.id = o.template_id AND m.tenant_id = o.tenant_id
      LEFT JOIN guesthub.users u ON u.id = o.created_by AND u.tenant_id = o.tenant_id
      -- A "שליחת בדיקה" is not a message to the guest, and the reference says so
      -- out loud in the test dialog. It is still persisted (it really was sent,
      -- and its attempts are auditable) but it never counts as guest history.
      WHERE o.tenant_id = ${tenantId} AND o.delivery_type <> 'test'
      ORDER BY o.created_at DESC LIMIT 250` : Promise.resolve([]),
    access.channels ? sql<{ status: string; status_detail: string | null; last_tested_at: string | null; config: Record<string, unknown> }[]>`
      SELECT status, status_detail, last_tested_at::text AS last_tested_at, config
      FROM guesthub.messaging_provider_connections
      WHERE tenant_id = ${tenantId} AND provider IN ('gmail','gmail_smtp')
      ORDER BY provider = 'gmail' DESC LIMIT 1` : Promise.resolve([]),
    access.channels ? sql<{
      quiet_hours: CommunicationSettingsView["quietHours"];
      retry_policy: CommunicationSettingsView["retryPolicy"];
      failure_notification: CommunicationSettingsView["failureNotification"];
      manual_booking_recipients: string[]; direct_booking_recipients: string[];
    }[]>`
      SELECT quiet_hours, retry_policy, failure_notification,
             manual_booking_recipients, direct_booking_recipients
      FROM guesthub.communication_settings WHERE tenant_id = ${tenantId}` : Promise.resolve([]),
  ]);

  const conn = emailConnection[0];
  const connectionConfig = conn?.config ?? {};
  return {
    templates: templates.map((r) => ({
      id: r.id, name: r.name, subject: r.subject ?? "", channel: r.channel as "email" | "whatsapp",
      category: r.category, language: r.language, state: r.lifecycle_state as CommunicationTemplateRow["state"],
      version: r.version_number, usedBy: r.used_by,
      updatedAt: r.updated_at, updatedBy: r.updated_by_name, isSystem: r.is_system,
      senderDisplayName: r.draft_sender_display_name ?? "",
      replyTo: r.draft_reply_to ?? "",
      preheader: r.draft_preheader ?? "",
      draftContent: r.draft_content,
      versions: r.versions ?? [],
    })),
    automations: automations.map((r) => ({
      id: r.id, name: r.name, description: r.description, status: r.status,
      attentionReason: r.attention_reason, triggerType: r.trigger_type, channel: r.channel,
      templateId: r.template_id, templateName: r.template_name, timing: r.timing_config,
      sources: r.source_filters, conditions: r.conditions, updatedAt: r.updated_at,
      successCount: r.success_count, failureCount: r.failure_count,
    })),
    deliveries: deliveries.map((r) => ({
      id: r.id, reservationId: r.reservation_id, reservationNumber: r.reservation_number,
      guestName: r.guest_name, toAddress: r.to_address, subject: r.subject, channel: r.channel,
      provider: r.provider, status: r.status, errorDetail: r.error_detail, createdAt: r.created_at,
      submittedAt: r.submitted_at, deliveredAt: r.delivered_at, automationName: r.automation_name,
      templateName: r.template_name, attemptCount: r.attempt_count, attempts: r.attempts ?? [],
      renderedSenderName: r.rendered_sender_name, renderedReplyTo: r.rendered_reply_to,
      renderedHtml: r.rendered_html, renderedPlainText: r.rendered_plain_text,
      providerMessageId: r.provider_message_id, scheduledAt: r.scheduled_at, sentAt: r.sent_at,
      templateVersionId: r.template_version_id, deliveryType: r.delivery_type,
      resendOfDeliveryId: r.resend_of_delivery_id, resendReason: r.resend_reason,
      createdByName: r.created_by_name,
    })),
    channel: {
      email: {
        status: conn?.status ?? "not_configured", detail: conn?.status_detail ?? null,
        lastTestedAt: conn?.last_tested_at ?? null,
        sender: typeof connectionConfig.senderEmail === "string" ? connectionConfig.senderEmail : null,
      },
      whatsappAvailable: false,
      smsAvailable: false,
    },
    settings: settings[0] ? {
      quietHours: settings[0].quiet_hours ?? {}, retryPolicy: settings[0].retry_policy ?? {},
      failureNotification: settings[0].failure_notification ?? {},
      manualBookingRecipients: settings[0].manual_booking_recipients ?? [],
      directBookingRecipients: settings[0].direct_booking_recipients ?? [],
    } : {
      quietHours: { enabled: false, start: "22:00", end: "07:00" },
      retryPolicy: { maxAttempts: 5, baseDelaySeconds: 60, maxDelaySeconds: 3600 },
      failureNotification: { enabled: false }, manualBookingRecipients: [], directBookingRecipients: [],
    },
  };
}
