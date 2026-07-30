import "server-only";
import { sql } from "@/lib/db";
import { getBusinessProfile } from "@/lib/business/store";
import { nightsBetween } from "@/lib/dates";
import { resolveCommunicationStaySchedule } from "./schedule";
import {
  exclusionRulesSchema,
  parseRecipientConfig,
  sourceFiltersSchema,
  timingConfigSchema,
} from "./schemas";
import { describeConditionFailures, evaluateConditions } from "./conditions";
import { renderTemplateContent, renderTemplateString, renderWhatsAppCommunication } from "./renderer";
import { describeRenderIssues } from "./variables";
import { parseTemplateContent, templateContentKind } from "./schemas";
import { applyQuietHours, triggerFor } from "./triggers";
import { normalizePhone } from "@/lib/phone";
import type { CommunicationEvent } from "./outbox";
import type {
  BookingOrigin, CommunicationChannel, CommunicationRenderContext, TemplateContent, WhatsAppTemplateContent,
} from "./types";

type AutomationRow = {
  id: string;
  tenant_id: string;
  channel: CommunicationChannel;
  template_id: string;
  template_version_policy: "latest_published" | "locked";
  locked_template_version_id: string | null;
  timing_config: unknown;
  source_filters: unknown;
  conditions: unknown;
  exclusion_rules: unknown;
  recipient_config: unknown;
};

type VersionRow = {
  id: string;
  template_id: string;
  sender_display_name: string | null;
  reply_to_behavior: "channel_default" | "custom" | "none";
  reply_to_address: string | null;
  subject: string;
  preheader: string | null;
  content: unknown;
};

type EmailChannelSnapshot = {
  sender_name: string | null;
  reply_to: string | null;
};

type ReservationSnapshot = {
  id: string;
  tenant_id: string;
  booking_origin: BookingOrigin;
  status: string;
  is_test: boolean;
  guest_communication_opt_out: boolean;
  external_booking_id: string | null;
  channel_connection_id: string | null;
  ota_name: string | null;
  reservation_number: string;
  created_at: string;
  check_in: string;
  check_out: string;
  adults: number;
  children: number;
  infants: number;
  total_price: number;
  paid_amount: number;
  balance: number;
  currency: string;
  cancellation_policy_snapshot: unknown;
  guest_id: string | null;
  guest_first_name: string | null;
  guest_last_name: string | null;
  guest_full_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  guest_language: string | null;
  source_label: string | null;
  room_numbers: string | null;
  room_types: string | null;
  room_floors: string | null;
};

export type EventPreparation = { created: number; duplicates: number; skipped: number };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTA_ORIGINS = new Set<string>(["ota"]);

function guestComposition(adults: number, children: number, infants: number): string {
  const values = [`${adults} מבוגרים`];
  if (children) values.push(`${children} ילדים`);
  if (infants) values.push(`${infants} תינוקות`);
  return values.join(" · ");
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(`${value}T12:00:00Z`));
}

function cancellationDescription(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const root = snapshot as Record<string, unknown>;
  const policy = root.policy;
  if (policy && typeof policy === "object" && !Array.isArray(policy)) {
    const value = (policy as Record<string, unknown>).guest_description;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const ota = root.ota;
  if (ota && typeof ota === "object" && !Array.isArray(ota)) {
    const value = (ota as Record<string, unknown>).policy_text;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return null;
}

async function loadReservationSnapshot(
  tenantId: string,
  reservationId: string | null,
): Promise<ReservationSnapshot | null> {
  if (!reservationId) return null;
  const [row] = await sql<ReservationSnapshot[]>`
    SELECT r.id, r.tenant_id, r.booking_origin, r.status, r.is_test,
           r.guest_communication_opt_out, r.external_booking_id,
           r.channel_connection_id, r.ota_name, r.reservation_number,
           r.created_at::text, r.check_in::text, r.check_out::text,
           r.adults, r.children, r.infants,
           r.total_price::float8 AS total_price,
           r.paid_amount::float8 AS paid_amount,
           r.balance::float8 AS balance, r.currency,
           r.cancellation_policy_snapshot,
           g.id AS guest_id, g.first_name AS guest_first_name,
           g.last_name AS guest_last_name, g.full_name AS guest_full_name,
           g.email AS guest_email, g.phone AS guest_phone,
           g.language AS guest_language,
           src.label AS source_label,
           rooms.room_numbers, rooms.room_types, rooms.room_floors
    FROM guesthub.reservations r
    LEFT JOIN guesthub.guests g
      ON g.id = r.primary_guest_id AND g.tenant_id = r.tenant_id
    LEFT JOIN guesthub.lookup_items src
      ON src.id = r.source_id AND src.tenant_id = r.tenant_id
    LEFT JOIN LATERAL (
      SELECT string_agg(DISTINCT rm.room_number, ', ') AS room_numbers,
             string_agg(DISTINCT rt.name, ', ') AS room_types,
             string_agg(DISTINCT rm.floor, ', ') AS room_floors
      FROM guesthub.reservation_rooms rr
      LEFT JOIN guesthub.rooms rm ON rm.id = rr.room_id AND rm.tenant_id = rr.tenant_id
      LEFT JOIN guesthub.room_types rt ON rt.id = rm.room_type_id AND rt.tenant_id = rm.tenant_id
      WHERE rr.reservation_id = r.id AND rr.tenant_id = r.tenant_id
    ) rooms ON true
    WHERE r.id = ${reservationId} AND r.tenant_id = ${tenantId}
    LIMIT 1`;
  return row ?? null;
}

async function buildRenderContext(row: ReservationSnapshot): Promise<CommunicationRenderContext> {
  const [profile, schedule] = await Promise.all([
    getBusinessProfile(row.tenant_id),
    resolveCommunicationStaySchedule(row.tenant_id, row.check_in, row.check_out),
  ]);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const absoluteAsset = (value: string | null | undefined) =>
    value && /^https?:\/\//.test(value) ? value : value && appUrl ? `${appUrl}${value.startsWith("/") ? "" : "/"}${value}` : null;
  const mapUrl = profile?.latitude != null && profile.longitude != null
    ? `https://www.google.com/maps/search/?api=1&query=${profile.latitude},${profile.longitude}`
    : null;
  return {
    bookingOrigin: row.booking_origin,
    values: {
      "guest.first_name": row.guest_first_name,
      "guest.last_name": row.guest_last_name,
      "guest.full_name": row.guest_full_name,
      "guest.email": row.guest_email,
      "guest.phone": row.guest_phone,
      "reservation.number": row.reservation_number,
      "reservation.source": row.source_label ?? row.booking_origin,
      "reservation.status": row.status,
      "reservation.created_at": dateLabel(row.created_at.slice(0, 10)),
      // Phase 1 has no public guest reservation endpoint. Never expose an
      // internal id or fabricate a broken/guessable guest-facing link.
      "reservation.manage_url": null,
      "reservation.cancellation_policy": cancellationDescription(row.cancellation_policy_snapshot),
      "stay.arrival_date": dateLabel(row.check_in),
      "stay.departure_date": dateLabel(row.check_out),
      "stay.nights": nightsBetween(row.check_in, row.check_out),
      "stay.check_in_time": schedule.checkIn,
      "stay.check_out_time": schedule.checkOut,
      "stay.guests": guestComposition(row.adults, row.children, row.infants),
      "room.number": row.room_numbers,
      "room.type": row.room_types,
      "room.floor": row.room_floors,
      "payment.total": row.total_price,
      "payment.paid": row.paid_amount,
      "payment.balance": row.balance,
      "payment.currency": row.currency,
      "payment.payment_url": null,
      "property.name": profile?.publicPropertyName,
      "property.address": profile?.formattedAddress,
      "property.phone": profile?.phone,
      "property.email": profile?.email,
      "property.map_url": mapUrl,
      "property.logo_url": absoluteAsset(profile?.logo),
    },
  };
}

async function markNeedsAttention(id: string, reason: string): Promise<void> {
  await sql`
    UPDATE guesthub.communication_automations
    SET status = 'needs_attention', attention_reason = ${reason.slice(0, 240)}, updated_at = now()
    WHERE id = ${id} AND status = 'active'`;
}

// Map a free-text guests.language value to a supported template language, or null
// when it is unknown/unset (→ no override, use the automation's configured
// template). message_templates.language is constrained to 'he'/'en'.
function normalizeLanguage(raw: string | null): "he" | "en" | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("en") || s.includes("english") || s.includes("אנגלית")) return "en";
  if (s.startsWith("he") || s.startsWith("iw") || s.includes("hebrew") || s.includes("עברית")) return "he";
  return null;
}

// §15/§21 — resolve the template version to send. Under the "latest_published"
// policy, prefer a PUBLISHED sibling template in the guest's language (same tenant
// + same category), falling back to the automation's configured template when no
// such sibling exists. A "locked" policy is an explicit operator choice and is
// NEVER language-overridden. Selection is honest: it only ever picks a real
// published version, and never fabricates a translation.
async function resolveVersion(
  automation: AutomationRow,
  guestLanguage?: string | null,
): Promise<VersionRow | null> {
  const target = automation.template_version_policy === "locked" ? null : normalizeLanguage(guestLanguage ?? null);
  if (target) {
    const [sibling] = await sql<VersionRow[]>`
      SELECT v.id, v.template_id, v.sender_display_name, v.reply_to_behavior,
             v.reply_to_address, v.subject, v.preheader, v.content
      FROM guesthub.message_templates cfg
      JOIN guesthub.message_templates t
        ON t.tenant_id = cfg.tenant_id AND t.category = cfg.category
        AND t.channel = cfg.channel AND t.language = ${target}
      JOIN guesthub.message_template_versions v
        ON v.id = t.current_published_version_id AND v.tenant_id = t.tenant_id
      WHERE cfg.id = ${automation.template_id} AND cfg.tenant_id = ${automation.tenant_id}
        AND t.archived_at IS NULL AND t.lifecycle_state <> 'archived'
      LIMIT 1`;
    if (sibling) return sibling;
    // no published sibling in the guest's language → fall through to configured
  }

  const [version] = await sql<VersionRow[]>`
    SELECT v.id, v.template_id, v.sender_display_name, v.reply_to_behavior,
           v.reply_to_address, v.subject, v.preheader, v.content
    FROM guesthub.message_template_versions v
    JOIN guesthub.message_templates t
      ON t.id = v.template_id AND t.tenant_id = v.tenant_id
    WHERE v.tenant_id = ${automation.tenant_id}
      AND v.template_id = ${automation.template_id}
      -- an archived template is out of service: it must not keep reaching guests
      -- through an automation that was merely disabled and later switched back on
      AND t.archived_at IS NULL AND t.lifecycle_state <> 'archived'
      AND v.id = ${automation.template_version_policy === "locked"
        ? automation.locked_template_version_id
        : sql`t.current_published_version_id`}
    LIMIT 1`;
  return version ?? null;
}

async function resolveConnectedEmailChannel(tenantId: string): Promise<EmailChannelSnapshot | null> {
  const [row] = await sql<EmailChannelSnapshot[]>`
    SELECT NULLIF(btrim(config->>'senderName'), '') AS sender_name,
           NULLIF(btrim(config->>'replyTo'), '') AS reply_to
    FROM guesthub.messaging_provider_connections
    WHERE tenant_id = ${tenantId} AND provider = 'gmail'
      AND status = 'connected' AND last_tested_at IS NOT NULL
      AND secret_ciphertext IS NOT NULL
    LIMIT 1`;
  return row ?? null;
}

export type WhatsAppChannelSnapshot = { provider: "green_api" | "twilio" };

/**
 * The tenant's ACTIVE WhatsApp provider, but only when its connection is
 * connected + tested + holds a secret — the same readiness bar the email
 * channel is held to.
 */
export async function resolveConnectedWhatsAppChannel(tenantId: string): Promise<WhatsAppChannelSnapshot | null> {
  const [row] = await sql<{ provider: "green_api" | "twilio" }[]>`
    SELECT c.provider
    FROM guesthub.tenants t
    JOIN guesthub.messaging_provider_connections c
      ON c.tenant_id = t.id
     AND c.provider = t.settings->'messaging'->>'whatsappProvider'
    WHERE t.id = ${tenantId}
      AND t.settings->'messaging'->>'whatsappProvider' IN ('green_api','twilio')
      AND c.status = 'connected' AND c.last_tested_at IS NOT NULL
      AND c.secret_ciphertext IS NOT NULL
    LIMIT 1`;
  return row ? { provider: row.provider } : null;
}

/**
 * The displayed address of an automation-wide skip row. The default row keeps
 * the pre-065 dedupe identity (legacy idempotency_key + recipient_key 'guest' —
 * BOTH participate in unique indexes and must stay byte-identical), but
 * to_address sits in no unique index and is what the panel shows. An owner-only
 * automation must not display the guest's address as if it were the intended
 * recipient (the +972500000000 confusion behind D114).
 */
async function skippedDisplayAddress(args: {
  automation: AutomationRow;
  reservation: ReservationSnapshot;
}): Promise<string> {
  const channel = args.automation.channel;
  const guestAddress = channel === "whatsapp"
    ? normalizePhone(args.reservation.guest_phone).e164
    : args.reservation.guest_email?.trim() ?? "";
  try {
    const config = parseRecipientConfig(args.automation.recipient_config);
    if (config.guest || !config.owner) return guestAddress;
    const display = (address: string) => channel === "whatsapp"
      ? (normalizePhone(address).valid ? normalizePhone(address).e164 : address.trim())
      : address.trim();
    if (config.owner.mode === "selected") {
      return config.owner.addresses.map(display).join(", ");
    }
    const [row] = await sql<{ addresses: string[] | null }[]>`
      SELECT ${channel === "whatsapp" ? sql`owner_notification_phones` : sql`owner_notification_emails`} AS addresses
      FROM guesthub.communication_settings
      WHERE tenant_id = ${args.automation.tenant_id}`;
    return (row?.addresses ?? []).map(display).filter(Boolean).join(", ");
  } catch {
    // Unparseable recipient_config — the guest default is the only honest guess.
    return guestAddress;
  }
}

async function recordSkippedDelivery(args: {
  event: CommunicationEvent;
  automation: AutomationRow;
  reservation: ReservationSnapshot;
  reason: string;
  version?: VersionRow | null;
  provider?: string;
  /** Omitted = the pre-065 guest-keyed skip row (byte-identical dedupe). */
  recipient?: { key: string; recipientKey: string; address: string };
  /** Overrides the generic reason label with specific evidence (D112). */
  detail?: string;
}): Promise<"created" | "duplicate"> {
  const reasonLabels: Record<string, string> = {
    source_mismatch: "מקור האירוע אינו תואם להזמנה",
    ota_excluded: "הזמנת ערוץ אינה זכאית להודעה האוטומטית",
    reservation_not_confirmed: "ההזמנה אינה במצב מאושר",
    reservation_not_eligible: "ההזמנה אינה במצב המתאים לשליחה הזו",
    test_reservation: "הזמנת בדיקה אינה נשלחת לאורח",
    guest_opted_out: "האורח הוסר מתקשורת",
    source_filtered: "מקור ההזמנה אינו כלול באוטומציה",
    conditions_not_met: "תנאי האוטומציה לא התקיימו",
    missing_guest_email: "כתובת האימייל של האורח חסרה או אינה תקינה",
    missing_guest_phone: "מספר הטלפון של האורח חסר או אינו תקין",
    template_version_missing: "לא נמצאה גרסה מפורסמת תואמת",
    provider_not_ready: "הערוץ אינו מחובר או לא נבדק",
    render_failed: "נתון נדרש לתבנית חסר בהזמנה הזו",
    render_context_failed: "לא ניתן להרכיב את נתוני ההודעה",
    automation_config_invalid: "הגדרת האוטומציה אינה תקינה",
    invalid_reply_to: "כתובת המענה של התבנית אינה תקינה",
    template_channel_mismatch: "התבנית אינה תואמת לערוץ האוטומציה",
    no_owner_recipients: "לא הוגדרו כתובות של בעל העסק לערוץ הזה",
  };
  const channel = args.automation.channel;
  const provider = args.provider ?? (channel === "whatsapp" ? "whatsapp" : "gmail");
  const toAddress = args.recipient?.address ?? await skippedDisplayAddress(args);
  const idempotencyKey = args.recipient?.key ?? `automation:${args.automation.id}:event:${args.event.id}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO guesthub.outbound_messages
      (tenant_id, reservation_id, guest_id, channel, provider, template_id,
       automation_id, template_version_id, event_id, idempotency_key, recipient_key,
       to_address, subject, body, status, rendered_html, rendered_plain_text,
       delivery_type, scheduled_at,
       final_error_category, error_code, error_detail, max_attempts)
    VALUES (
      ${args.event.tenant_id}, ${args.reservation.id}, ${args.reservation.guest_id},
      ${channel}, ${provider}, ${args.automation.template_id}, ${args.automation.id},
      ${args.version?.id ?? null}, ${args.event.id}, ${idempotencyKey}, ${args.recipient?.recipientKey ?? "guest"},
      ${toAddress}, ${args.version?.subject ?? null},
      '', 'skipped', '', '', 'normal', now(), ${args.reason}, ${args.reason},
      ${args.detail ?? reasonLabels[args.reason] ?? "המשלוח דולג"}, 0)
    ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
    RETURNING id`;
  return rows[0] ? "created" : "duplicate";
}

async function skipAutomation(
  summary: EventPreparation,
  event: CommunicationEvent,
  automation: AutomationRow,
  reservation: ReservationSnapshot,
  reason: string,
  version?: VersionRow | null,
  provider?: string,
  recipient?: { key: string; recipientKey: string; address: string },
  detail?: string,
): Promise<void> {
  const result = await recordSkippedDelivery({ event, automation, reservation, reason, version, provider, recipient, detail });
  if (result === "duplicate") summary.duplicates += 1;
  summary.skipped += 1;
}

export type PreviewDataset = {
  id: string;
  label: string;
  context: CommunicationRenderContext;
};

/**
 * The datasets the editor previews against, and that "שליחת בדיקה" sends with.
 *
 * They are REAL reservations run through the very same buildRenderContext the
 * worker uses — so a preview cannot look correct while the live send would not.
 * A synthetic dataset would be exactly the lie this module exists to avoid.
 */
export async function loadPreviewDatasets(tenantId: string, limit = 3): Promise<PreviewDataset[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM guesthub.reservations
    WHERE tenant_id = ${tenantId} AND status <> 'cancelled'
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  const snapshots = await Promise.all(
    rows.map((row) => loadReservationSnapshot(tenantId, row.id)),
  );
  const present = snapshots.filter((row): row is ReservationSnapshot => row !== null);
  return Promise.all(
    present.map(async (row) => ({
      id: row.id,
      label: `${row.reservation_number} · ${row.guest_full_name ?? "אורח"}${row.source_label ? ` (${row.source_label})` : ""}`,
      context: await buildRenderContext(row),
    })),
  );
}

/** The property-only context — what a preview falls back to when the tenant has no reservations yet. */
export async function propertyOnlyContext(tenantId: string): Promise<CommunicationRenderContext> {
  const profile = await getBusinessProfile(tenantId);
  return {
    bookingOrigin: "back_office",
    values: {
      "property.name": profile?.publicPropertyName,
      "property.address": profile?.formattedAddress,
      "property.phone": profile?.phone,
      "property.email": profile?.email,
    },
  };
}

export async function prepareDeliveriesForEvent(event: CommunicationEvent): Promise<EventPreparation> {
  const summary: EventPreparation = { created: 0, duplicates: 0, skipped: 0 };
  const trigger = triggerFor(event.event_type);
  if (!trigger || !event.reservation_id) {
    summary.skipped += 1;
    return summary;
  }
  const reservation = await loadReservationSnapshot(event.tenant_id, event.reservation_id);
  if (!reservation) {
    summary.skipped += 1;
    return summary;
  }
  // A SCHEDULED event was emitted FOR one automation (its id is in the
  // occurrence key and payload) — two pre-arrival automations with different
  // offsets each get their own event. An event-kind fact fans out to every
  // matching automation.
  const scheduledAutomationId = trigger.kind === "scheduled"
    ? (event.payload as { automationId?: string } | null)?.automationId ?? null
    : null;
  if (trigger.kind === "scheduled" && !scheduledAutomationId) {
    summary.skipped += 1;
    return summary;
  }
  const automations = await sql<AutomationRow[]>`
    SELECT id, tenant_id, channel, template_id, template_version_policy,
           locked_template_version_id, timing_config, source_filters,
           conditions, exclusion_rules, recipient_config
    FROM guesthub.communication_automations
    WHERE tenant_id = ${event.tenant_id} AND trigger_type = ${event.event_type}
      AND status = 'active' AND archived_at IS NULL
      AND (${scheduledAutomationId}::uuid IS NULL OR id = ${scheduledAutomationId}::uuid)
    ORDER BY created_at, id`;
  if (!automations.length) return summary;
  // The persisted reservation is authoritative; an event cannot override its
  // provenance. Record one truthful terminal row per matching automation.
  // Trigger-parameterized eligibility: a cancellation message REQUIRES
  // status='cancelled'; the OTA hard-skip applies only where the registry says
  // (reservation.confirmed — the OTA already sends its own confirmation).
  const globalSkipReason = reservation.booking_origin !== event.source
    ? "source_mismatch"
    : trigger.otaHardSkip
      && (OTA_ORIGINS.has(reservation.booking_origin)
        || Boolean(reservation.external_booking_id || reservation.channel_connection_id || reservation.ota_name))
      ? "ota_excluded"
      : !trigger.eligibleStatuses.includes(reservation.status)
        ? trigger.id === "reservation.confirmed" ? "reservation_not_confirmed" : "reservation_not_eligible"
        : reservation.is_test
          ? "test_reservation"
          : reservation.guest_communication_opt_out
            ? "guest_opted_out"
            : null;
  if (globalSkipReason) {
    for (const automation of automations) {
      await skipAutomation(summary, event, automation, reservation, globalSkipReason, await resolveVersion(automation, reservation.guest_language));
    }
    return summary;
  }

  // Building the render context needs the tenant's business profile and the
  // Israel check-in/out calendar. If that throws, the event would be retried and
  // then quietly buried in communication_events — which no screen shows — so the
  // guest never gets their confirmation and NOBODY can find out. Make it loud:
  // a terminal skipped row in the history and the automation flagged.
  let context: CommunicationRenderContext;
  try {
    context = await buildRenderContext(reservation);
  } catch {
    for (const automation of automations) {
      await markNeedsAttention(automation.id, "לא ניתן להרכיב את נתוני ההודעה (פרופיל העסק או לוח השעות)");
      await skipAutomation(summary, event, automation, reservation, "render_context_failed", await resolveVersion(automation, reservation.guest_language));
    }
    return summary;
  }

  // Quiet hours apply at delivery creation (scheduled_at), once per event.
  const [settingsRow] = await sql<{
    quiet_hours: unknown;
    owner_notification_emails: string[] | null;
    owner_notification_phones: string[] | null;
  }[]>`
    SELECT quiet_hours, owner_notification_emails, owner_notification_phones
    FROM guesthub.communication_settings
    WHERE tenant_id = ${event.tenant_id}`;
  const quietHours = (settingsRow?.quiet_hours ?? null) as { enabled?: boolean; start?: string; end?: string } | null;
  const ownerEmails = settingsRow?.owner_notification_emails ?? [];
  const ownerPhones = settingsRow?.owner_notification_phones ?? [];

  for (const automation of automations) {
    try {
      const sources = sourceFiltersSchema.parse(automation.source_filters);
      const exclusions = exclusionRulesSchema.parse(automation.exclusion_rules);
      const recipientConfig = parseRecipientConfig(automation.recipient_config);
      const timing = timingConfigSchema.parse(automation.timing_config);
      if (!sources.include.includes(reservation.booking_origin)) {
        await skipAutomation(summary, event, automation, reservation, "source_filtered", await resolveVersion(automation, reservation.guest_language)); continue;
      }
      if (exclusions.ota && OTA_ORIGINS.has(reservation.booking_origin)) {
        await skipAutomation(summary, event, automation, reservation, "ota_excluded", await resolveVersion(automation, reservation.guest_language)); continue;
      }
      if (exclusions.guestCommunicationOptOut && reservation.guest_communication_opt_out) {
        await skipAutomation(summary, event, automation, reservation, "guest_opted_out", await resolveVersion(automation, reservation.guest_language)); continue;
      }
      const version = await resolveVersion(automation, reservation.guest_language);
      // One outbound row per resolved recipient. The guest keeps the pre-065
      // key format — changing it would un-dedupe every historical event and
      // re-send old messages; only owner rows carry a suffixed key.
      const legacyKey = `automation:${automation.id}:event:${event.id}`;
      const recipients: { key: string; recipientKey: string; address: string }[] = [];
      const guestAddress = automation.channel === "whatsapp"
        ? (normalizePhone(reservation.guest_phone).valid ? normalizePhone(reservation.guest_phone).e164 : null)
        : reservation.guest_email && EMAIL_RE.test(reservation.guest_email.trim())
          ? reservation.guest_email.trim() : null;
      if (recipientConfig.guest) {
        if (guestAddress) {
          recipients.push({ key: legacyKey, recipientKey: "guest", address: guestAddress });
        } else {
          // The guest leg alone is unreachable — owner legs still go out.
          await skipAutomation(summary, event, automation, reservation,
            automation.channel === "whatsapp" ? "missing_guest_phone" : "missing_guest_email", version);
        }
      }
      if (recipientConfig.owner) {
        const configured = automation.channel === "whatsapp" ? ownerPhones : ownerEmails;
        const normalize = (a: string) => automation.channel === "whatsapp"
          ? (normalizePhone(a).valid ? normalizePhone(a).e164 : "")
          : (EMAIL_RE.test(a.trim()) ? a.trim().toLowerCase() : "");
        let pool = [...new Set(configured.map(normalize).filter(Boolean))];
        if (recipientConfig.owner.mode === "selected") {
          const picked = new Set(recipientConfig.owner.addresses.map(normalize));
          // Selections deleted from settings since the automation was saved
          // silently drop — the settings list is the live source of truth.
          pool = pool.filter((a) => picked.has(a)).slice(0, 3);
        }
        if (pool.length === 0) {
          await skipAutomation(summary, event, automation, reservation, "no_owner_recipients", version, undefined,
            { key: `${legacyKey}:owner:none`, recipientKey: "owner:none", address: "" });
        }
        // An owner address identical to the guest's is already covered by the
        // guest leg — one message, not two.
        const guestNorm = guestAddress && recipientConfig.guest
          ? (automation.channel === "whatsapp" ? guestAddress : guestAddress.toLowerCase()) : null;
        pool = pool.filter((a) => a !== guestNorm);
        for (const address of pool) {
          recipients.push({ key: `${legacyKey}:owner:${address}`, recipientKey: `owner:${address}`, address });
        }
      }
      if (recipients.length === 0) continue;
      // D114 — conditions are recipient- and channel-scoped: a guest-contact
      // condition follows the channel (email→guest.email, whatsapp→guest.phone)
      // and is evaluated only when the guest leg is actually deliverable. A
      // party who receives nothing (guest not selected, or their leg already
      // skipped for a bad address) must never block the remaining recipients.
      const verdict = evaluateConditions(automation.conditions, reservation, {
        channel: automation.channel,
        guestIsRecipient: recipientConfig.guest && guestAddress !== null,
      });
      if (!verdict.pass) {
        await skipAutomation(summary, event, automation, reservation, "conditions_not_met", version,
          undefined, undefined, describeConditionFailures(verdict.failed) ?? undefined);
        continue;
      }

      if (!version) {
        await markNeedsAttention(automation.id, "לא נמצאה גרסה מפורסמת תואמת לתבנית");
        await skipAutomation(summary, event, automation, reservation, "template_version_missing");
        continue;
      }

      const content: TemplateContent = parseTemplateContent(version.content);
      const contentKind = templateContentKind(content);
      // The picker only offers same-channel templates, but a body must never
      // leave through the wrong channel — belt-and-braces on both sides.
      if (automation.channel === "whatsapp" ? contentKind !== "whatsapp_text" : contentKind === "whatsapp_text") {
        await markNeedsAttention(automation.id, "התבנית אינה תואמת לערוץ האוטומציה");
        await skipAutomation(summary, event, automation, reservation, "template_channel_mismatch", version);
        continue;
      }

      let scheduledAt = timing.mode === "delay"
        ? new Date(Date.now() + (timing.delayMinutes ?? 0) * 60_000)
        : new Date();
      if (timing.quietHours === "respect") scheduledAt = applyQuietHours(scheduledAt, quietHours);

      if (automation.channel === "whatsapp") {
        const waChannel = await resolveConnectedWhatsAppChannel(event.tenant_id);
        if (!waChannel) {
          await markNeedsAttention(automation.id, "ספק ה-WhatsApp אינו מחובר או לא נבדק");
          await skipAutomation(summary, event, automation, reservation, "provider_not_ready", version);
          continue;
        }
        const rendered = renderWhatsAppCommunication(content as WhatsAppTemplateContent, context);
        if (!rendered.canSend || !rendered.text.trim()) {
          // D112/D115 — the skip names the variable that blocked it.
          await skipAutomation(summary, event, automation, reservation, "render_failed", version,
            waChannel.provider, undefined,
            describeRenderIssues(rendered.issues)
              ?? (rendered.text.trim() ? undefined : "ההודעה ריקה לאחר מילוי המשתנים"));
          continue;
        }
        for (const r of recipients) {
          const rows = await sql<{ id: string }[]>`
            INSERT INTO guesthub.outbound_messages
              (tenant_id, reservation_id, guest_id, channel, provider, template_id,
               automation_id, template_version_id, event_id, idempotency_key, recipient_key,
               to_address, subject, body, status, rendered_html,
               rendered_plain_text, delivery_type, scheduled_at, eligible_statuses, max_attempts)
            SELECT ${event.tenant_id}, ${reservation.id}, ${reservation.guest_id},
                   'whatsapp', ${waChannel.provider}, ${automation.template_id}, ${automation.id},
                   ${version.id}, ${event.id}, ${r.key}, ${r.recipientKey},
                   ${r.address}, NULL,
                   ${rendered.text}, 'queued', '',
                   ${rendered.text}, 'normal', ${scheduledAt}, ${trigger.eligibleStatuses},
                   GREATEST(1, COALESCE((SELECT (retry_policy->>'maxAttempts')::int
                                         FROM guesthub.communication_settings
                                         WHERE tenant_id = ${event.tenant_id}), 5))
            ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
              DO NOTHING
            RETURNING id`;
          if (rows[0]) summary.created += 1;
          else summary.duplicates += 1;
        }
        continue;
      }

      const emailChannel = await resolveConnectedEmailChannel(event.tenant_id);
      if (!emailChannel) {
        await markNeedsAttention(automation.id, "ערוץ האימייל אינו מחובר או שלא עבר בדיקת חיבור");
        await skipAutomation(summary, event, automation, reservation, "provider_not_ready", version);
        continue;
      }
      const rendered = renderTemplateContent(
        content,
        context,
        version.preheader ? { preheader: version.preheader } : undefined,
      );
      const subject = renderTemplateString(version.subject, context);
      const preheader = version.preheader ? renderTemplateString(version.preheader, context) : null;
      if (!rendered.canSend || !subject.canSend || (preheader && !preheader.canSend)) {
        // A missing variable is a fact about THIS reservation (a guest with no
        // first name, an unassigned room), not about the automation. Disabling
        // the automation here would silently stop every OTHER guest's
        // confirmation too. Record the skip — naming the variable that blocked
        // it (D112/D115) — and carry on.
        await skipAutomation(summary, event, automation, reservation, "render_failed", version,
          undefined, undefined,
          describeRenderIssues([
            ...rendered.issues, ...subject.issues, ...(preheader?.issues ?? []),
          ]) ?? undefined);
        continue;
      }
      const senderName = version.sender_display_name ?? emailChannel.sender_name;
      const replyTo = version.reply_to_behavior === "custom"
        ? version.reply_to_address
        : version.reply_to_behavior === "channel_default"
          ? emailChannel.reply_to
          : null;
      if (replyTo && !EMAIL_RE.test(replyTo)) {
        await markNeedsAttention(automation.id, "כתובת המענה של התבנית או הערוץ אינה תקינה");
        await skipAutomation(summary, event, automation, reservation, "invalid_reply_to", version);
        continue;
      }
      for (const r of recipients) {
        const rows = await sql<{ id: string }[]>`
          INSERT INTO guesthub.outbound_messages
            (tenant_id, reservation_id, guest_id, channel, provider, template_id,
             automation_id, template_version_id, event_id, idempotency_key, recipient_key,
             to_address, subject, body, status, rendered_sender_name,
             rendered_reply_to, rendered_preheader, rendered_html,
             rendered_plain_text, delivery_type, scheduled_at, eligible_statuses, max_attempts)
          SELECT ${event.tenant_id}, ${reservation.id}, ${reservation.guest_id},
                 'email', 'gmail', ${automation.template_id}, ${automation.id},
                 ${version.id}, ${event.id}, ${r.key}, ${r.recipientKey},
                 ${r.address}, ${subject.value},
                 ${rendered.plainText}, 'queued', ${senderName}, ${replyTo},
                 ${preheader?.value ?? null}, ${rendered.html},
                 ${rendered.plainText}, 'normal', ${scheduledAt}, ${trigger.eligibleStatuses},
                 GREATEST(1, COALESCE((SELECT (retry_policy->>'maxAttempts')::int
                                       FROM guesthub.communication_settings
                                       WHERE tenant_id = ${event.tenant_id}), 5))
          ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
            DO NOTHING
          RETURNING id`;
        if (rows[0]) summary.created += 1;
        else summary.duplicates += 1;
      }
    } catch {
      await markNeedsAttention(automation.id, "הגדרת האוטומציה או התבנית אינה תקינה");
      await skipAutomation(summary, event, automation, reservation, "automation_config_invalid");
    }
  }
  return summary;
}
