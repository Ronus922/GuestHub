import "server-only";
import { sql } from "@/lib/db";
import { getBusinessProfile } from "@/lib/business/store";
import { nightsBetween } from "@/lib/dates";
import { resolveCommunicationStaySchedule } from "./schedule";
import {
  automationConditionsSchema,
  exclusionRulesSchema,
  recipientConfigSchema,
  sourceFiltersSchema,
  timingConfigSchema,
} from "./schemas";
import { renderStructuredCommunication, renderTemplateString } from "./renderer";
import { structuredTemplateContentSchema } from "./schemas";
import type { CommunicationEvent } from "./outbox";
import type { BookingOrigin, CommunicationRenderContext, StructuredTemplateContent } from "./types";

type AutomationRow = {
  id: string;
  tenant_id: string;
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

function conditionValue(field: string, row: ReservationSnapshot): unknown {
  switch (field) {
    case "reservation.status": return row.status;
    case "reservation.is_test": return row.is_test;
    case "reservation.is_cancelled": return row.status === "cancelled";
    case "guest.email": return row.guest_email;
    case "payment.balance": return row.balance;
    case "room.number": return row.room_numbers;
    default: return undefined;
  }
}

function matchesConditions(raw: unknown, row: ReservationSnapshot): boolean {
  const config = automationConditionsSchema.parse(raw);
  const decisions = config.items.map((item) => {
    const actual = conditionValue(item.field, row);
    switch (item.operator) {
      case "equals": return actual === item.value;
      case "not_equals": return actual !== item.value;
      case "exists": return actual !== null && actual !== undefined && String(actual).trim() !== "";
      case "greater_than": return typeof actual === "number" && typeof item.value === "number" && actual > item.value;
    }
  });
  return config.logic === "all" ? decisions.every(Boolean) : decisions.some(Boolean);
}

async function markNeedsAttention(id: string, reason: string): Promise<void> {
  await sql`
    UPDATE guesthub.communication_automations
    SET status = 'needs_attention', attention_reason = ${reason.slice(0, 240)}, updated_at = now()
    WHERE id = ${id} AND status = 'active'`;
}

async function resolveVersion(automation: AutomationRow): Promise<VersionRow | null> {
  const [version] = await sql<VersionRow[]>`
    SELECT v.id, v.template_id, v.sender_display_name, v.reply_to_behavior,
           v.reply_to_address, v.subject, v.preheader, v.content
    FROM guesthub.message_template_versions v
    JOIN guesthub.message_templates t
      ON t.id = v.template_id AND t.tenant_id = v.tenant_id
    WHERE v.tenant_id = ${automation.tenant_id}
      AND v.template_id = ${automation.template_id}
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

async function recordSkippedDelivery(args: {
  event: CommunicationEvent;
  automation: AutomationRow;
  reservation: ReservationSnapshot;
  reason: string;
  version?: VersionRow | null;
}): Promise<"created" | "duplicate"> {
  const reasonLabels: Record<string, string> = {
    source_mismatch: "מקור האירוע אינו תואם להזמנה",
    ota_excluded: "הזמנת ערוץ אינה זכאית למייל האוטומטי",
    reservation_not_confirmed: "ההזמנה אינה במצב מאושר",
    test_reservation: "הזמנת בדיקה אינה נשלחת לאורח",
    guest_opted_out: "האורח הוסר מתקשורת",
    source_filtered: "מקור ההזמנה אינו כלול באוטומציה",
    conditions_not_met: "תנאי האוטומציה לא התקיימו",
    missing_guest_email: "כתובת האימייל של האורח חסרה או אינה תקינה",
    template_version_missing: "לא נמצאה גרסה מפורסמת תואמת",
    provider_not_ready: "ערוץ האימייל אינו מחובר או לא נבדק",
    render_failed: "נתון נדרש לתבנית חסר",
    automation_config_invalid: "הגדרת האוטומציה אינה תקינה",
    invalid_reply_to: "כתובת המענה של התבנית אינה תקינה",
  };
  const idempotencyKey = `automation:${args.automation.id}:event:${args.event.id}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO guesthub.outbound_messages
      (tenant_id, reservation_id, guest_id, channel, provider, template_id,
       automation_id, template_version_id, event_id, idempotency_key,
       to_address, subject, body, status, rendered_html, rendered_plain_text,
       delivery_type, scheduled_at,
       final_error_category, error_code, error_detail, max_attempts)
    VALUES (
      ${args.event.tenant_id}, ${args.reservation.id}, ${args.reservation.guest_id},
      'email', 'gmail', ${args.automation.template_id}, ${args.automation.id},
      ${args.version?.id ?? null}, ${args.event.id}, ${idempotencyKey},
      ${args.reservation.guest_email?.trim() ?? ""}, ${args.version?.subject ?? null},
      '', 'skipped', '', '', 'normal', now(), ${args.reason}, ${args.reason},
      ${reasonLabels[args.reason] ?? "המשלוח דולג"}, 0)
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
): Promise<void> {
  const result = await recordSkippedDelivery({ event, automation, reservation, reason, version });
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
  if (event.event_type !== "reservation.confirmed" || !event.reservation_id) {
    summary.skipped += 1;
    return summary;
  }
  const reservation = await loadReservationSnapshot(event.tenant_id, event.reservation_id);
  if (!reservation) {
    summary.skipped += 1;
    return summary;
  }
  const automations = await sql<AutomationRow[]>`
    SELECT id, tenant_id, template_id, template_version_policy,
           locked_template_version_id, timing_config, source_filters,
           conditions, exclusion_rules, recipient_config
    FROM guesthub.communication_automations
    WHERE tenant_id = ${event.tenant_id} AND trigger_type = ${event.event_type}
      AND status = 'active' AND channel = 'email' AND archived_at IS NULL
    ORDER BY created_at, id`;
  if (!automations.length) return summary;
  // The persisted reservation is authoritative; an event cannot override its
  // provenance. Record one truthful terminal row per matching automation.
  const globalSkipReason = reservation.booking_origin !== event.source
    ? "source_mismatch"
    : OTA_ORIGINS.has(reservation.booking_origin)
      || Boolean(reservation.external_booking_id || reservation.channel_connection_id || reservation.ota_name)
      ? "ota_excluded"
      : reservation.status !== "confirmed"
        ? "reservation_not_confirmed"
        : reservation.is_test
          ? "test_reservation"
          : reservation.guest_communication_opt_out
            ? "guest_opted_out"
            : null;
  if (globalSkipReason) {
    for (const automation of automations) {
      await skipAutomation(summary, event, automation, reservation, globalSkipReason, await resolveVersion(automation));
    }
    return summary;
  }
  const context = await buildRenderContext(reservation);

  for (const automation of automations) {
    try {
      const sources = sourceFiltersSchema.parse(automation.source_filters);
      const exclusions = exclusionRulesSchema.parse(automation.exclusion_rules);
      recipientConfigSchema.parse(automation.recipient_config);
      const timing = timingConfigSchema.parse(automation.timing_config);
      if (!sources.include.includes(reservation.booking_origin)) {
        await skipAutomation(summary, event, automation, reservation, "source_filtered", await resolveVersion(automation)); continue;
      }
      if (exclusions.ota && OTA_ORIGINS.has(reservation.booking_origin)) {
        await skipAutomation(summary, event, automation, reservation, "ota_excluded", await resolveVersion(automation)); continue;
      }
      if (exclusions.guestCommunicationOptOut && reservation.guest_communication_opt_out) {
        await skipAutomation(summary, event, automation, reservation, "guest_opted_out", await resolveVersion(automation)); continue;
      }
      const version = await resolveVersion(automation);
      if (!reservation.guest_email || !EMAIL_RE.test(reservation.guest_email.trim())) {
        await skipAutomation(summary, event, automation, reservation, "missing_guest_email", version); continue;
      }
      if (!matchesConditions(automation.conditions, reservation)) {
        await skipAutomation(summary, event, automation, reservation, "conditions_not_met", version); continue;
      }

      if (!version) {
        await markNeedsAttention(automation.id, "לא נמצאה גרסה מפורסמת תואמת לתבנית");
        await skipAutomation(summary, event, automation, reservation, "template_version_missing");
        continue;
      }
      const emailChannel = await resolveConnectedEmailChannel(event.tenant_id);
      if (!emailChannel) {
        await markNeedsAttention(automation.id, "ערוץ האימייל אינו מחובר או שלא עבר בדיקת חיבור");
        await skipAutomation(summary, event, automation, reservation, "provider_not_ready", version);
        continue;
      }
      const content: StructuredTemplateContent = structuredTemplateContentSchema.parse(version.content);
      const rendered = renderStructuredCommunication(
        content,
        context,
        version.preheader ? { preheader: version.preheader } : undefined,
      );
      const subject = renderTemplateString(version.subject, context);
      const preheader = version.preheader ? renderTemplateString(version.preheader, context) : null;
      if (!rendered.canSend || !subject.canSend || (preheader && !preheader.canSend)) {
        await markNeedsAttention(automation.id, "התבנית מכילה משתנה נדרש שחסר בנתוני ההזמנה");
        await skipAutomation(summary, event, automation, reservation, "render_failed", version);
        continue;
      }
      const scheduledAt = timing.mode === "delay"
        ? new Date(Date.now() + (timing.delayMinutes ?? 0) * 60_000)
        : new Date();
      const idempotencyKey = `automation:${automation.id}:event:${event.id}`;
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
      const rows = await sql<{ id: string }[]>`
        INSERT INTO guesthub.outbound_messages
          (tenant_id, reservation_id, guest_id, channel, provider, template_id,
           automation_id, template_version_id, event_id, idempotency_key,
           to_address, subject, body, status, rendered_sender_name,
           rendered_reply_to, rendered_preheader, rendered_html,
           rendered_plain_text, delivery_type, scheduled_at, max_attempts)
        SELECT ${event.tenant_id}, ${reservation.id}, ${reservation.guest_id},
               'email', 'gmail', ${automation.template_id}, ${automation.id},
               ${version.id}, ${event.id}, ${idempotencyKey},
               ${reservation.guest_email.trim()}, ${subject.value},
               ${rendered.plainText}, 'queued', ${senderName}, ${replyTo},
               ${preheader?.value ?? null}, ${rendered.html},
               ${rendered.plainText}, 'normal', ${scheduledAt},
               GREATEST(1, COALESCE((SELECT (retry_policy->>'maxAttempts')::int
                                     FROM guesthub.communication_settings
                                     WHERE tenant_id = ${event.tenant_id}), 5))
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
          DO NOTHING
        RETURNING id`;
      if (rows[0]) summary.created += 1;
      else summary.duplicates += 1;
    } catch {
      await markNeedsAttention(automation.id, "הגדרת האוטומציה או התבנית אינה תקינה");
      await skipAutomation(summary, event, automation, reservation, "automation_config_invalid");
    }
  }
  return summary;
}
