import { z } from "zod";
import { dateOnlySchema } from "./reservation";

// Zod schemas for the commercial-write paths (§0.2). Client grids are cosmetic;
// every rates Server Action parses with these.

// `0` is not a weaker restriction, it is a STRICTER one — and on the wire it is
// a payload killer. Beds24 answers maxStay:0 with "capped to 1" (a one-night
// ceiling, measured 2026-07-25), and our own builder rejects any stay value
// below 1, which drops the ENTIRE request, not just the field. "No limit" is
// NULL, never 0. rate-plans.ts has always required .min(1); this path was the
// outlier. See docs/MAXSTAY_NO_LIMIT_SPEC.md §5.
const stayField = z.number().int().min(1, "מינימום לילה אחד").max(3650).nullable();
// price 0 is a SILENT room closure: beds24-ari-payloads.ts treats price1 <= 0
// as `blocked` and publishes numAvail 0 without anyone asking for it. Closing a
// room is what stop_sell is for. Clearing a price is NULL, not 0.
const priceField = z.number().min(1, "מחיר חייב להיות חיובי").max(1_000_000).nullable();

// A grid cell patch — only the touched fields are present; at least one.
export const rateCellPatchSchema = z
  .object({
    price: priceField.optional(),
    minStayThrough: stayField.optional(),
    minStayArrival: stayField.optional(),
    maxStay: stayField.optional(),
    closedToArrival: z.boolean().optional(),
    closedToDeparture: z.boolean().optional(),
    stopSell: z.boolean().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "לא נבחר שדה לעדכון",
  });

export const upsertRateCellSchema = z.object({
  sellableUnitId: z.uuid("יחידת מכירה לא תקינה"),
  pricingPlanId: z.uuid().optional(), // defaults to the SU's base plan
  date: dateOnlySchema,
  patch: rateCellPatchSchema,
});

export const priceModeSchema = z.enum([
  "replace", "add", "subtract", "percent_add", "percent_subtract",
]);

export const bulkUpdateRatesSchema = z
  .object({
    sellableUnitIds: z.array(z.uuid()).min(1, "נדרשת יחידה אחת לפחות").max(1000),
    dateFrom: dateOnlySchema,
    dateTo: dateOnlySchema, // inclusive last day
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    price: z
      .object({ mode: priceModeSchema, amount: z.number().min(0).max(1_000_000) })
      .optional(),
    minStayThrough: stayField.optional(),
    minStayArrival: stayField.optional(),
    maxStay: stayField.optional(),
    stopSell: z.boolean().optional(),
    closedToArrival: z.boolean().optional(),
    closedToDeparture: z.boolean().optional(),
  })
  .refine((b) => b.dateTo >= b.dateFrom, { message: "טווח תאריכים לא תקין", path: ["dateTo"] })
  .refine(
    (b) =>
      b.price !== undefined ||
      b.minStayThrough !== undefined ||
      b.minStayArrival !== undefined ||
      b.maxStay !== undefined ||
      b.stopSell !== undefined ||
      b.closedToArrival !== undefined ||
      b.closedToDeparture !== undefined,
    { message: "לא נבחר שדה לעדכון" },
  );

export const roomStatusSchema = z.object({
  roomId: z.uuid(),
  status: z.enum(["available", "inactive", "out_of_order"]),
});

export type UpsertRateCellInput = z.infer<typeof upsertRateCellSchema>;
export type BulkUpdateRatesInput = z.infer<typeof bulkUpdateRatesSchema>;
export type RoomStatusInput = z.infer<typeof roomStatusSchema>;
