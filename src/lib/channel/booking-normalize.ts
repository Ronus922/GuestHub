// ============================================================
// PURE normalization of a Channex booking-revision payload (D76). No imports,
// no DB, no HTTP — mirrors the payloads.ts discipline so the import pipeline
// and the check scripts exercise the exact same parse.
//
// Consumes the REDACTED payload (the one persistBookingRevision stored):
// guarantee/card fields are already stripped — card handling never passes
// through here (it is staged separately from the RAW payload at persist time).
//
// Validation is strict where a wrong value would corrupt the domain (ids,
// dates, kind) and tolerant where the channel is merely informative (notes,
// names, phone). A failure returns a safe Hebrew message — never a raw body.
// ============================================================

export type NormalizedRoom = {
  channexRoomTypeId: string;
  channexRatePlanId: string | null;
  checkinDate: string; // YYYY-MM-DD
  checkoutDate: string; // exclusive
  adults: number;
  children: number;
  infants: number;
  /** full room amount as supplied by the channel (string-decimal → number) */
  amount: number | null;
  /** per-date nightly breakdown where supplied: { "2026-07-10": 223.21 } */
  days: Record<string, number>;
  isCancelled: boolean;
};

/** OTA cancellation terms as supplied inside rooms[].meta — preserved verbatim
 *  (strings untouched) so the reservation snapshot is the channel's own
 *  contract, never a re-interpretation. */
export type OtaCancellationTerms = {
  cancel_penalties: { from: string | null; amount: string | null; currency: string | null }[];
  policies_text: string | null;
};

export type NormalizedRevision = {
  revisionId: string;
  bookingId: string;
  propertyId: string;
  kind: "new" | "modified" | "cancelled";
  uniqueId: string | null;
  systemId: string | null;
  otaReservationCode: string | null;
  otaName: string | null;
  currency: string | null;
  /** booking total as supplied by the channel */
  amount: number | null;
  arrivalDate: string;
  departureDate: string;
  /** guest-stated expected arrival time "HH:MM" (Channex arrival_hour) — null when not supplied */
  arrivalHour: string | null;
  insertedAt: string | null; // channel timestamp, ISO-ish
  /** channel-reported OTA commission for the booking, where supplied */
  otaCommission: number | null;
  customer: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    country: string | null;
    language: string | null;
    address: string | null;
    city: string | null;
    zip: string | null;
  };
  occupancy: { adults: number; children: number; infants: number };
  notes: string | null;
  paymentCollect: string | null; // "property" = hotel collect
  paymentType: string | null; // "credit_card" | ...
  rooms: NormalizedRoom[];
  /** OTA cancellation terms (rooms[].meta.cancel_penalties / .policies) —
   *  null when the channel supplied none */
  cancellation: OtaCancellationTerms | null;
};

export type NormalizeResult =
  | { ok: true; value: NormalizedRevision }
  | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const count = (v: unknown): number => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : 0;
};
const dateOnly = (v: unknown): string | null => {
  const s = str(v);
  return s && DATE_RE.test(s) ? s : null;
};
// arrival_hour arrives as "13:00" (occasionally with seconds) — anything else
// is dropped, never guessed and never appended to notes.
const hourOnly = (v: unknown): string | null => {
  const s = str(v);
  const m = s ? /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(s) : null;
  return m ? `${m[1]}:${m[2]}` : null;
};

function normalizeRoom(raw: unknown): NormalizedRoom | { error: string } {
  const r = obj(raw);
  if (!r) return { error: "רשומת חדר בהזמנה אינה תקינה" };
  const roomTypeId = str(r.room_type_id);
  const checkin = dateOnly(r.checkin_date);
  const checkout = dateOnly(r.checkout_date);
  if (!roomTypeId) return { error: "חדר בהזמנה ללא מזהה Room Type של הערוץ" };
  if (!checkin || !checkout || checkout <= checkin)
    return { error: "תאריכי שהות של חדר בהזמנה אינם תקינים" };
  const occ = obj(r.occupancy) ?? {};
  const days: Record<string, number> = {};
  const rawDays = obj(r.days) ?? {};
  for (const [d, v] of Object.entries(rawDays)) {
    const n = num(v);
    if (DATE_RE.test(d) && n !== null) days[d] = n;
  }
  return {
    channexRoomTypeId: roomTypeId,
    channexRatePlanId: str(r.rate_plan_id),
    checkinDate: checkin,
    checkoutDate: checkout,
    adults: count(occ.adults),
    children: count(occ.children),
    infants: count(occ.infants),
    amount: num(r.amount),
    days,
    isCancelled: r.is_cancelled === true,
  };
}

// Cancellation terms ride inside each room's meta (Booking.com via Channex:
// meta.cancel_penalties = structured schedule, meta.policies = verbatim text).
// Values are kept verbatim (strings untouched, deduped across rooms) — the
// snapshot must be the channel's own contract, never a re-interpretation.
function extractCancellationTerms(rawRooms: unknown[]): OtaCancellationTerms | null {
  const penalties: OtaCancellationTerms["cancel_penalties"] = [];
  const seen = new Set<string>();
  let policiesText: string | null = null;
  for (const raw of rawRooms) {
    const meta = obj(obj(raw)?.meta);
    if (!meta) continue;
    if (Array.isArray(meta.cancel_penalties)) {
      for (const rawPenalty of meta.cancel_penalties) {
        const p = obj(rawPenalty);
        if (!p) continue;
        const amount = str(p.amount) ?? (num(p.amount) !== null ? String(num(p.amount)) : null);
        const entry = { from: str(p.from), amount, currency: str(p.currency) };
        const key = JSON.stringify(entry);
        if (!seen.has(key)) {
          seen.add(key);
          penalties.push(entry);
        }
      }
    }
    if (!policiesText) policiesText = str(meta.policies);
  }
  return penalties.length > 0 || policiesText
    ? { cancel_penalties: penalties, policies_text: policiesText }
    : null;
}

export function normalizeBookingRevision(payload: unknown): NormalizeResult {
  const p = obj(payload);
  if (!p) return { ok: false, error: "גוף הרוויזיה אינו אובייקט תקין" };

  const revisionId = str(p.id);
  const bookingId = str(p.booking_id);
  const propertyId = str(p.property_id);
  const status = str(p.status);
  if (!revisionId || !bookingId || !propertyId)
    return { ok: false, error: "לרוויזיה חסרים מזהי חובה (revision/booking/property)" };
  if (status !== "new" && status !== "modified" && status !== "cancelled")
    return { ok: false, error: "סטטוס רוויזיה לא מוכר" };

  const arrival = dateOnly(p.arrival_date);
  const departure = dateOnly(p.departure_date);
  if (!arrival || !departure || departure <= arrival)
    return { ok: false, error: "תאריכי ההזמנה אינם תקינים" };

  const rawRooms = Array.isArray(p.rooms) ? p.rooms : [];
  const rooms: NormalizedRoom[] = [];
  for (const raw of rawRooms) {
    const room = normalizeRoom(raw);
    if ("error" in room) return { ok: false, error: room.error };
    rooms.push(room);
  }
  // a live (non-cancelled) revision must occupy at least one live room
  if (status !== "cancelled" && rooms.filter((r) => !r.isCancelled).length === 0)
    return { ok: false, error: "רוויזיה פעילה ללא חדרים פעילים" };

  const customer = obj(p.customer) ?? {};
  const occ = obj(p.occupancy) ?? {};

  return {
    ok: true,
    value: {
      revisionId,
      bookingId,
      propertyId,
      kind: status,
      uniqueId: str(p.unique_id),
      systemId: str(p.system_id),
      otaReservationCode: str(p.ota_reservation_code),
      otaName: str(p.ota_name),
      currency: str(p.currency),
      amount: num(p.amount),
      arrivalDate: arrival,
      departureDate: departure,
      arrivalHour: hourOnly(p.arrival_hour),
      insertedAt: str(p.inserted_at),
      otaCommission: num(p.ota_commission),
      customer: {
        firstName: str(customer.name) ?? "אורח",
        lastName: str(customer.surname) ?? "",
        email: str(customer.mail),
        phone: str(customer.phone),
        country: str(customer.country),
        language: str(customer.language),
        address: str(customer.address),
        city: str(customer.city),
        zip: str(customer.zip),
      },
      occupancy: {
        adults: count(occ.adults),
        children: count(occ.children),
        infants: count(occ.infants),
      },
      notes: str(p.notes),
      paymentCollect: str(p.payment_collect),
      paymentType: str(p.payment_type),
      rooms,
      cancellation: extractCancellationTerms(rawRooms),
    },
  };
}

// Channel OTA name → local lookup_items(booking_sources) key. Unknown channels
// keep source_id NULL — never guessed.
export function otaSourceKey(otaName: string | null): string | null {
  if (!otaName) return null;
  const n = otaName.toLowerCase().replace(/[^a-z]/g, "");
  if (n.includes("booking")) return "booking_com";
  if (n.includes("airbnb")) return "airbnb";
  if (n.includes("expedia")) return "expedia";
  return null;
}
