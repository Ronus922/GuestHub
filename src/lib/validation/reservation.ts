import { z } from "zod";
import { isDateOnly } from "@/lib/dates";

// Shared Zod schemas for the reservation flow (booking panel, edit panel,
// calendar move/resize, closures). Every server action parses with these —
// client forms are cosmetic only (overview §4).

export const dateOnlySchema = z
  .string()
  .refine(isDateOnly, "תאריך לא תקין");

const stayCore = {
  roomId: z.uuid("חדר לא תקין"),
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
  adults: z.number().int().min(1, "נדרש מבוגר אחד לפחות").max(20),
  children: z.number().int().min(0).max(20),
  infants: z.number().int().min(0).max(10),
  ratePerNight: z.number().min(0).max(1_000_000).optional(),
  // authorized manual override (§13) — explicit, never inferred from a price
  // being present (the edit panel resubmits the stored rate on every save).
  isManualRate: z.boolean().optional(),
  // tenant-level Rate Plan for the stay; null/omitted = base-ARI pricing.
  // undefined on edit = keep the stay's stored plan (preserved server-side).
  ratePlanId: z.uuid().nullable().optional(),
  guestFirstName: z.string().trim().max(80).optional(),
  guestLastName: z.string().trim().max(80).optional(),
  guestPhone: z.string().trim().max(30).optional(),
  guestEmail: z.email("אימייל לא תקין").optional().or(z.literal("")),
  guestIdNumber: z.string().trim().max(30).optional(),
};

export const roomStaySchema = z
  .object(stayCore)
  .refine((s) => s.checkOut > s.checkIn, {
    message: "תאריך היציאה חייב להיות אחרי תאריך הכניסה",
    path: ["checkOut"],
  });

export const existingRoomStaySchema = z
  .object({ rrId: z.uuid().optional(), ...stayCore })
  .refine((s) => s.checkOut > s.checkIn, {
    message: "תאריך היציאה חייב להיות אחרי תאריך הכניסה",
    path: ["checkOut"],
  });

export const guestInputSchema = z.object({
  id: z.uuid().optional(),
  firstName: z.string().trim().min(1, "שם פרטי חובה").max(80),
  lastName: z.string().trim().min(1, "שם משפחה חובה").max(80),
  phone: z.string().trim().max(30).optional(),
  email: z.email("אימייל לא תקין").optional().or(z.literal("")),
  idNumber: z.string().trim().max(30).optional(),
  country: z.string().trim().max(60).optional(),
  language: z.string().trim().max(30).optional(),
});

// שעת הגעה משוערת — "HH:MM"; null = explicitly none, undefined = untouched
export const expectedArrivalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "שעת הגעה לא תקינה")
  .nullable()
  .optional();

// Reservation statuses reachable through create/edit. Cancelling goes only
// through cancelReservationAction (reservations.cancel).
export const EDITABLE_STATUSES = [
  "draft",
  "confirmed",
  "checked_in",
  "checked_out",
  "no_show",
] as const;

export const createReservationSchema = z.object({
  guest: guestInputSchema,
  sourceId: z.uuid().nullable().optional(),
  status: z.enum(["draft", "confirmed"]),
  rooms: z.array(roomStaySchema).min(1, "נדרש חדר אחד לפחות").max(10),
  notes: z.string().trim().max(2000).optional(),
  // שעת הגעה משוערת — dedicated field (D80), never folded into notes
  expectedArrivalTime: expectedArrivalTimeSchema,
  discountAmount: z.number().min(0).max(1_000_000).optional(),
  paidAmount: z.number().min(0).max(10_000_000).optional(),
  paymentMethod: z.string().trim().max(40).optional(),
  // D77 §11 — optional explicit workflow status; omitted → tenant default
  workflowStatusId: z.uuid().optional(),
});

export const updateReservationSchema = z.object({
  id: z.uuid(),
  guest: guestInputSchema,
  sourceId: z.uuid().nullable().optional(),
  // Optional since the manual "סטטוס שהות" select was retired (D85): an
  // ordinary editor save OMITS status and the server keeps the stored value;
  // only the explicit check-in/check-out quick actions send one.
  status: z.enum(EDITABLE_STATUSES).optional(),
  rooms: z.array(existingRoomStaySchema).min(1, "נדרש חדר אחד לפחות").max(10),
  notes: z.string().trim().max(2000).optional(),
  // null clears the value; undefined (omitted) keeps the stored one
  expectedArrivalTime: expectedArrivalTimeSchema,
  discountAmount: z.number().min(0).max(1_000_000).optional(),
  additionalPayment: z.number().min(0).max(10_000_000).optional(),
  paymentMethod: z.string().trim().max(40).optional(),
});

export const rescheduleSchema = z
  .object({
    rrId: z.uuid(),
    targetRoomId: z.uuid(),
    checkIn: dateOnlySchema,
    checkOut: dateOnlySchema,
  })
  .refine((s) => s.checkOut > s.checkIn, {
    message: "תאריך היציאה חייב להיות אחרי תאריך הכניסה",
  });

export const closureSchema = z
  .object({
    roomId: z.uuid(),
    startDate: dateOnlySchema,
    endDate: dateOnlySchema,
    reason: z.string().trim().max(200).optional(),
  })
  .refine((s) => s.endDate > s.startDate, {
    message: "נדרש לילה אחד לפחות",
  });

export type RoomStayInput = z.infer<typeof roomStaySchema>;
export type ExistingRoomStayInput = z.infer<typeof existingRoomStaySchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;
