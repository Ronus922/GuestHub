import { z } from "zod";
import { dateOnlySchema } from "./reservation";

// Zod schemas for the Rate Plans module. The wizard UI mirrors these; every
// Server Action re-parses with them (Hebrew messages authored here).

export const planKindSchema = z.enum([
  "base",
  "derived_percentage",
  "derived_fixed",
  "independent",
]);

const nullableDate = dateOnlySchema.nullable();
const advanceField = z.number().int("ערך ימים חייב להיות שלם").min(0).max(3650).nullable();
const stayField = z.number().int().min(1, "מינימום לילה אחד").max(3650).nullable();

const assignmentSchema = z.object({
  sellableUnitId: z.uuid("יחידת מכירה לא תקינה"),
  isActive: z.boolean().default(true),
  adjustmentValue: z.number().min(-1_000_000).max(1_000_000).nullable().default(null),
  validFrom: nullableDate.default(null),
  validUntil: nullableDate.default(null),
});

export const ratePlanSaveSchema = z
  .object({
    id: z.uuid().optional(), // present = update
    name: z.string().trim().min(1, "נדרש שם לתוכנית").max(120, "שם ארוך מדי"),
    code: z
      .string()
      .trim()
      .min(1, "נדרש קוד לתוכנית")
      .max(40, "קוד ארוך מדי")
      .regex(/^[a-zA-Z0-9_-]+$/, "קוד יכול להכיל אותיות באנגלית, ספרות, מקף וקו תחתון בלבד"),
    publicName: z.string().trim().max(120).nullable().default(null),
    description: z.string().trim().max(2000).nullable().default(null),
    publicDescription: z.string().trim().max(2000).nullable().default(null),
    planKind: planKindSchema,
    parentPlanId: z.uuid().nullable().default(null),
    adjustmentValue: z.number().min(-1_000_000).max(1_000_000).nullable().default(null),
    isActive: z.boolean().default(true),
    isRefundable: z.boolean().default(true),
    cancellationPolicyId: z.uuid().nullable().default(null),
    paymentPolicyId: z.uuid().nullable().default(null),
    mealPlan: z.string().trim().max(120).nullable().default(null),
    validFrom: nullableDate.default(null),
    validUntil: nullableDate.default(null),
    minAdvanceDays: advanceField.default(null),
    maxAdvanceDays: advanceField.default(null),
    allowedCheckinDays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "יש לבחור לפחות יום אחד")
      .max(7)
      .nullable()
      .default(null),
    defaultMinStay: stayField.default(null),
    defaultMaxStay: stayField.default(null),
    defaultClosedToArrival: z.boolean().default(false),
    defaultClosedToDeparture: z.boolean().default(false),
    isVisibleWebsite: z.boolean().default(false),
    isVisibleChannels: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
    assignments: z.array(assignmentSchema).max(500).default([]),
  })
  .superRefine((p, ctx) => {
    const derived = p.planKind === "derived_percentage" || p.planKind === "derived_fixed";
    if (derived) {
      if (!p.parentPlanId)
        ctx.addIssue({ code: "custom", path: ["parentPlanId"], message: "תוכנית נגזרת חייבת תוכנית אב" });
      if (p.adjustmentValue == null)
        ctx.addIssue({ code: "custom", path: ["adjustmentValue"], message: "תוכנית נגזרת חייבת ערך התאמה" });
      if (p.planKind === "derived_percentage" && p.adjustmentValue != null && p.adjustmentValue <= -100)
        ctx.addIssue({ code: "custom", path: ["adjustmentValue"], message: "הנחה באחוזים חייבת להיות קטנה מ-100%" });
    } else {
      if (p.parentPlanId)
        ctx.addIssue({ code: "custom", path: ["parentPlanId"], message: "רק תוכנית נגזרת יכולה להגדיר תוכנית אב" });
      if (p.adjustmentValue != null)
        ctx.addIssue({ code: "custom", path: ["adjustmentValue"], message: "ערך התאמה מוגדר רק בתוכנית נגזרת" });
    }
    if (p.validFrom && p.validUntil && p.validUntil < p.validFrom)
      ctx.addIssue({ code: "custom", path: ["validUntil"], message: "תאריך סיום התוקף קודם לתאריך ההתחלה" });
    if (p.minAdvanceDays != null && p.maxAdvanceDays != null && p.maxAdvanceDays < p.minAdvanceDays)
      ctx.addIssue({ code: "custom", path: ["maxAdvanceDays"], message: "חלון ההזמנה המקסימלי קטן מהמינימלי" });
    if (p.defaultMinStay != null && p.defaultMaxStay != null && p.defaultMaxStay < p.defaultMinStay)
      ctx.addIssue({ code: "custom", path: ["defaultMaxStay"], message: "מקסימום הלילות קטן מהמינימום" });
    for (const a of p.assignments) {
      if (a.validFrom && a.validUntil && a.validUntil < a.validFrom)
        ctx.addIssue({ code: "custom", path: ["assignments"], message: "טווח תוקף שיוך לא תקין" });
      if (a.adjustmentValue != null && !derived)
        ctx.addIssue({ code: "custom", path: ["assignments"], message: "התאמת מחיר ליחידה זמינה רק בתוכנית נגזרת" });
      if (a.adjustmentValue != null && p.planKind === "derived_percentage" && a.adjustmentValue <= -100)
        ctx.addIssue({ code: "custom", path: ["assignments"], message: "הנחה באחוזים ליחידה חייבת להיות קטנה מ-100%" });
    }
  });

export const ratePlanDuplicateSchema = z.object({
  id: z.uuid(),
  withAssignments: z.boolean().default(true),
});

export const ratePlanArchiveSchema = z.object({
  id: z.uuid(),
  archived: z.boolean(), // false = restore
});

export const ratePlanDeleteSchema = z.object({ id: z.uuid() });

const overrideItemSchema = z
  .object({
    sellableUnitId: z.uuid(),
    date: dateOnlySchema,
    price: z.number().min(0).max(1_000_000).nullable().default(null),
    minStayThrough: stayField.default(null),
    minStayArrival: stayField.default(null),
    maxStay: stayField.default(null),
    closedToArrival: z.boolean().default(false),
    closedToDeparture: z.boolean().default(false),
    stopSell: z.boolean().default(false),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .refine(
    (o) =>
      o.price != null || o.minStayThrough != null || o.minStayArrival != null ||
      o.maxStay != null || o.closedToArrival || o.closedToDeparture || o.stopSell,
    { message: "שורת חריגה ריקה — אין מה לשמור" },
  );

export const ratePlanOverridesSchema = z
  .object({
    planId: z.uuid(),
    upserts: z.array(overrideItemSchema).max(1000).default([]),
    removals: z
      .array(z.object({ sellableUnitId: z.uuid(), date: dateOnlySchema }))
      .max(1000)
      .default([]),
  })
  .refine((o) => o.upserts.length > 0 || o.removals.length > 0, {
    message: "לא נבחרו שינויים לשמירה",
  });

export const simulateQuoteSchema = z.object({
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
  rooms: z
    .array(
      z.object({
        roomId: z.uuid("חדר לא תקין"),
        ratePlanId: z.uuid("תוכנית תעריף לא תקינה"),
        adults: z.number().int().min(0).max(20),
        children: z.number().int().min(0).max(20),
        infants: z.number().int().min(0).max(20),
      }),
    )
    .min(1, "יש לבחור לפחות חדר אחד")
    .max(10, "עד 10 חדרים בסימולציה"),
});

export type RatePlanSaveInput = z.infer<typeof ratePlanSaveSchema>;
export type RatePlanOverridesInput = z.infer<typeof ratePlanOverridesSchema>;
export type SimulateQuoteInput = z.infer<typeof simulateQuoteSchema>;
