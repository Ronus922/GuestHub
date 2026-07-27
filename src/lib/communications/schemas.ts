import { z } from "zod";
import {
  BLOCK_CONDITIONS,
  BOOKING_ORIGINS,
  COMMUNICATION_CHANNELS,
  TEMPLATE_BLOCK_TYPES,
} from "./types";
import type { TemplateContent, TemplateContentKind } from "./types";
import { TRIGGERS, TRIGGER_IDS } from "./triggers";

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const templateBlockSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: z.enum(TEMPLATE_BLOCK_TYPES),
  enabled: z.boolean(),
  condition: z.enum(BLOCK_CONDITIONS),
  data: z.object({
    text: z.string().max(10_000).optional(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    label: z.string().trim().max(160).optional(),
    urlVariable: z.string().trim().max(120).optional(),
    url: z.string().trim().max(400).optional(),
    align: z.enum(["start", "center", "end"]).optional(),
    fontSize: z.enum(["sm", "base", "md", "lg", "xl", "xxl"]).optional(),
    fontWeight: z.enum(["normal", "medium", "semibold", "bold", "black"]).optional(),
    lineHeight: z.enum(["tight", "snug", "normal", "loose"]).optional(),
    textColor: z.enum(["ink", "muted", "brand", "brandDark", "ok", "danger"]).optional(),
    background: z.enum(["none", "subtle", "brandSoft", "brand"]).optional(),
    padding: z.enum(["none", "sm", "md", "lg"]).optional(),
    buttonWidth: z.enum(["auto", "full"]).optional(),
    buttonRadius: z.enum(["md", "lg", "pill"]).optional(),
    buttonBg: z.enum(["brand", "ink", "ok"]).optional(),
    buttonText: z.enum(["white", "ink"]).optional(),
    showTimes: z.boolean().optional(),
    showNights: z.boolean().optional(),
    showGuests: z.boolean().optional(),
    showSource: z.boolean().optional(),
    showCreatedAt: z.boolean().optional(),
    showTotal: z.boolean().optional(),
    showPaid: z.boolean().optional(),
    showBalance: z.boolean().optional(),
  }).strict(),
}).strict();

export const structuredTemplateContentSchema = z.object({
  schemaVersion: z.literal(1),
  blocks: z.array(templateBlockSchema).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const [index, block] of value.blocks.entries()) {
    if (ids.has(block.id)) {
      ctx.addIssue({ code: "custom", path: ["blocks", index, "id"], message: "Block IDs must be unique" });
    }
    ids.add(block.id);
    if (block.type === "action_button" && (!block.data.label || !(block.data.url?.trim() || block.data.urlVariable))) {
      ctx.addIssue({ code: "custom", path: ["blocks", index, "data"], message: "Action buttons require a label and a destination" });
    }
  }
});

export const htmlTemplateContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("html"),
  // Empty is a legal DRAFT state; publish enforces non-empty content.
  html: z.string().max(200_000),
}).strict().superRefine((value, ctx) => {
  // Mail clients strip scripts anyway; rejecting them here catches the honest
  // paste mistake without a sanitizer that would mangle email-builder markup.
  if (/<script\b/i.test(value.html)) {
    ctx.addIssue({ code: "custom", path: ["html"], message: "תגיות script אינן מותרות בתבנית HTML" });
  }
});

export const whatsappTemplateContentSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("whatsapp_text"),
  // Empty is a legal DRAFT state; publish enforces non-empty content.
  text: z.string().max(4096),
}).strict();

/**
 * Parse any stored template content. Dispatches on the `kind` property so each
 * shape reports its own zod errors; ABSENCE of `kind` means a legacy block tree
 * — mandatory leniency, because message_template_versions rows are immutable
 * and pre-kind content must keep parsing forever.
 */
export function parseTemplateContent(value: unknown): TemplateContent {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "html") return htmlTemplateContentSchema.parse(value);
  if (kind === "whatsapp_text") return whatsappTemplateContentSchema.parse(value);
  return structuredTemplateContentSchema.parse(value);
}

export function templateContentKind(content: TemplateContent): TemplateContentKind {
  return "kind" in content ? content.kind : "blocks";
}

// Event triggers keep the original shape untouched — every stored
// {"mode":"immediate"|"delay"} row must keep parsing byte-for-byte. Scheduled
// triggers add their own arm.
const eventTimingSchema = z.object({
  mode: z.enum(["immediate", "delay"]),
  delayMinutes: z.number().int().min(0).max(525_600).optional(),
  quietHours: z.enum(["respect", "bypass"]),
}).strict().superRefine((value, ctx) => {
  if (value.mode === "delay" && value.delayMinutes === undefined) {
    ctx.addIssue({ code: "custom", path: ["delayMinutes"], message: "Delayed timing requires delayMinutes" });
  }
});

export const scheduledTimingSchema = z.object({
  mode: z.literal("scheduled"),
  offsetDays: z.number().int().min(0).max(60),
  sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  quietHours: z.enum(["respect", "bypass"]),
}).strict();

export const timingConfigSchema = z.union([eventTimingSchema, scheduledTimingSchema]);

export const sourceFiltersSchema = z.object({
  include: z.array(z.enum(BOOKING_ORIGINS)).min(1),
}).strict();

export const automationConditionSchema = z.object({
  field: z.enum([
    "reservation.status",
    "reservation.is_test",
    "reservation.is_cancelled",
    "guest.email",
    "payment.balance",
    "room.number",
  ]),
  operator: z.enum(["equals", "not_equals", "exists", "greater_than"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();

export const automationConditionsSchema = z.object({
  logic: z.enum(["all", "any"]),
  items: z.array(automationConditionSchema).max(25),
}).strict();

export const exclusionRulesSchema = z.object({
  guestCommunicationOptOut: z.boolean().optional(),
  ota: z.boolean().optional(),
}).strict();

export const recipientConfigSchema = z.object({
  type: z.literal("primary_guest"),
}).strict();

export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  start: timeSchema,
  end: timeSchema,
}).strict();

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(0).max(10),
  baseDelaySeconds: z.number().int().min(30).max(86_400),
  maxDelaySeconds: z.number().int().min(60).max(604_800),
}).strict().refine((value) => value.maxDelaySeconds >= value.baseDelaySeconds, {
  message: "maxDelaySeconds must not be lower than baseDelaySeconds",
  path: ["maxDelaySeconds"],
});

export const failureNotificationSchema = z.object({
  enabled: z.boolean(),
  email: z.email().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.email) {
    ctx.addIssue({ code: "custom", path: ["email"], message: "Enabled failure notifications require an email" });
  }
});

export const communicationSettingsSchema = z.object({
  defaultLanguage: z.literal("he"),
  quietHours: quietHoursSchema,
  retryPolicy: retryPolicySchema,
  failureNotification: failureNotificationSchema,
  manualBookingRecipients: z.array(z.email()).max(50),
  directBookingRecipients: z.array(z.email()).max(50),
}).strict();

export const automationConfigSchema = z.object({
  triggerType: z.enum(TRIGGER_IDS),
  timing: timingConfigSchema,
  sources: sourceFiltersSchema,
  conditions: automationConditionsSchema,
  exclusions: exclusionRulesSchema,
  recipient: recipientConfigSchema,
  channel: z.enum(COMMUNICATION_CHANNELS),
}).strict().superRefine((value, ctx) => {
  const scheduled = TRIGGERS[value.triggerType].kind === "scheduled";
  if (scheduled !== (value.timing.mode === "scheduled")) {
    ctx.addIssue({
      code: "custom", path: ["timing"],
      message: scheduled ? "Scheduled triggers require scheduled timing" : "Event triggers cannot use scheduled timing",
    });
  }
});

export type CommunicationSettingsInput = z.infer<typeof communicationSettingsSchema>;
export type AutomationConfigInput = z.infer<typeof automationConfigSchema>;
