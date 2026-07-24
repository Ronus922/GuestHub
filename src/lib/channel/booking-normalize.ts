// ============================================================
// PURE provider-neutral interchange types for inbound bookings (D76/D77/D78).
// No imports, no DB, no HTTP. Each provider adapter (today: Beds24) parses its
// own payload into a NormalizedRevision; the shared import core consumes ONLY
// this shape — never a raw provider body.
// ============================================================

export type NormalizedRoom = {
  /** the provider-side room identity (e.g. the Beds24 room id) — resolved to a
   *  physical room by the provider's injected RoomResolver, never by title */
  externalRoomId: string;
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
  /** guest-stated expected arrival time "HH:MM" — null when not supplied */
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

export function otaSourceKey(otaName: string | null): string | null {
  if (!otaName) return null;
  const n = otaName.toLowerCase().replace(/[^a-z]/g, "");
  if (n.includes("booking")) return "booking_com";
  if (n.includes("airbnb")) return "airbnb";
  if (n.includes("expedia")) return "expedia";
  return null;
}
