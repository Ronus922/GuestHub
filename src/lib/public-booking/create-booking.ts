import "server-only";
import { sql } from "@/lib/db";
import type { TransactionSql } from "postgres";
import type { DateOnly } from "@/lib/dates";
import { lockRooms } from "@/lib/inventory";
import {
  priceReservationStays,
  reservationTotal,
  StayPricingError,
} from "@/lib/pricing/reservation-pricing";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import { enqueueReservationConfirmed } from "@/lib/communications/outbox";
import { resolveCancellationSnapshot } from "@/lib/commercial/policy-snapshot";
import { markAriDirty } from "@/lib/channel/outbox";
import { publishDomainEvent } from "@/lib/realtime/publish";
import { CARD_KEY_VERSION, encryptCvv, encryptPan } from "@/lib/card-vault";
import { detectBrand } from "@/lib/card-rules";
import { publicAvailability } from "./availability";
import { PRICE_TOLERANCE_ILS, PUBLIC_TENANT_ID } from "./config";

// ============================================================
// Website booking creation — the public counterpart of the staff
// createReservationAction, modeled on the OTA importer (booking-import.ts):
// one transaction, lock → re-check availability → engine pricing → guest →
// reservation → stays → card vault → ledger → ARI outbox → realtime.
// The card is the guarantee: no card ⇒ no reservation (route enforces the
// vault key BEFORE calling this). PAN/CVV live only in this call's scope,
// encrypted before INSERT — never logged, never echoed.
// ============================================================

export type PublicBookingInput = {
  checkIn: DateOnly;
  checkOut: DateOnly;
  roomTypeId: string;
  /* דירה ספציפית שנבחרה בכרטיס (sellable_unit id); null = הזולה מהסוג */
  preferredUnitId: string | null;
  rooms: Array<{ adults: number; children: number }>;
  expectedTotal: number;
  guest: { firstName: string; lastName: string; phone: string; email: string };
  card: {
    pan: string; // digits only, panValid-checked by the route
    cvv: string;
    holderName: string;
    holderIdNumber: string | null;
    expMonth: number;
    expYear: number;
  };
  marketingConsent: boolean;
  meta: { ip: string | null; userAgent: string | null };
};

export class PublicBookingError extends Error {
  code: "no_availability" | "price_changed";
  newTotal?: number;
  constructor(code: PublicBookingError["code"], message: string, newTotal?: number) {
    super(message);
    this.code = code;
    this.newTotal = newTotal;
  }
}

export async function createPublicBooking(input: PublicBookingInput): Promise<{
  reservationId: string;
  reservationNumber: string;
  total: number;
}> {
  const tenantId = PUBLIC_TENANT_ID;
  return sql.begin(async (tx) => {
    // Serialize concurrent public bookings on this room type: lock ALL its
    // rooms, then re-derive availability inside the transaction.
    const typeRooms = await tx<{ id: string }[]>`
      SELECT id FROM guesthub.rooms
      WHERE tenant_id = ${tenantId} AND room_type_id = ${input.roomTypeId}`;
    if (typeRooms.length === 0) {
      throw new PublicBookingError("no_availability", "סוג החדר אינו קיים");
    }
    await lockRooms(tx, tenantId, typeRooms.map((r) => r.id));

    const types = await publicAvailability(tx, input.checkIn, input.checkOut);
    const type = types.find((t) => t.roomTypeId === input.roomTypeId);
    let ordered = type?.units ?? [];
    if (input.preferredUnitId) {
      const pref = ordered.find((u) => u.suId === input.preferredUnitId);
      if (!pref) {
        throw new PublicBookingError(
          "no_availability",
          "הדירה שנבחרה כבר אינה זמינה בתאריכים שנבחרו",
        );
      }
      /* הדירה שנבחרה קודם; חדרים נוספים (הזמנה רב-חדרית) מהזול לַיקר */
      ordered = [pref, ...ordered.filter((u) => u.suId !== pref.suId)];
    }
    const picked = ordered.slice(0, input.rooms.length);
    if (!type || picked.length < input.rooms.length) {
      throw new PublicBookingError(
        "no_availability",
        "הדירה כבר אינה זמינה בתאריכים שנבחרו",
      );
    }

    // Engine pricing is authoritative (availability + restrictions + occupancy
    // enforced — the same seam every staff reservation goes through).
    const stays = await priceReservationStays(
      tx,
      tenantId,
      picked.map((unit, i) => ({
        roomId: unit.roomId,
        ratePlanId: null,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.rooms[i].adults,
        children: input.rooms[i].children,
        infants: 0,
      })),
      { source: "website", enforceAvailability: true, enforceRestrictions: true },
    );

    const total = reservationTotal(
      stays.reduce((s, st) => s + st.priceTotal, 0),
      0,
      0,
    );
    if (Math.abs(total - input.expectedTotal) > PRICE_TOLERANCE_ILS) {
      throw new PublicBookingError(
        "price_changed",
        "המחיר התעדכן מאז הצגת ההצעה",
        total,
      );
    }

    const guestId = await insertGuest(tx, tenantId, input.guest);
    const number = await allocateReservationNumber(tx, tenantId);
    const [source] = await tx<{ id: string }[]>`
      SELECT id FROM guesthub.lookup_items
      WHERE tenant_id = ${tenantId} AND category = 'booking_sources'
        AND is_active AND key IN ('website', 'direct')
      ORDER BY (key = 'website') DESC LIMIT 1`;
    const [wf] = await tx<{ id: string }[]>`
      SELECT id FROM guesthub.lookup_items
      WHERE tenant_id = ${tenantId} AND category = 'workflow_statuses'
        AND is_active AND (metadata->>'is_default') = 'true'`;
    const cancellation = await resolveCancellationSnapshot(tx, tenantId, null);

    const adults = input.rooms.reduce((s, r) => s + r.adults, 0);
    const children = input.rooms.reduce((s, r) => s + r.children, 0);
    const noteLines = [
      "הזמנה מהאתר (sea-tower).",
      input.marketingConsent ? "אישר/ה קבלת דיוור שיווקי." : "ללא הסכמה לדיוור שיווקי.",
      input.meta.ip ? `IP: ${input.meta.ip}` : null,
      input.meta.userAgent ? `דפדפן: ${input.meta.userAgent.slice(0, 200)}` : null,
    ].filter(Boolean);

    const [created] = await tx<{ id: string }[]>`
      INSERT INTO guesthub.reservations
        (tenant_id, reservation_number, primary_guest_id, source_id, status,
         check_in, check_out, adults, children, infants,
         total_price, paid_amount, balance, currency, notes,
         cancellation_policy_snapshot, created_by, booking_origin, workflow_status_id)
      VALUES (${tenantId}, ${number}, ${guestId}, ${source?.id ?? null}, 'confirmed',
              ${input.checkIn}, ${input.checkOut}, ${adults}, ${children}, 0,
              ${total}, 0, ${total}, 'ILS', ${noteLines.join("\n")},
              ${cancellation === null ? null : tx.json(cancellation as never)},
              NULL, 'direct_website', ${wf?.id ?? null})
      RETURNING id`;
    const reservationId = created.id;

    for (const stay of stays) {
      await tx`
        INSERT INTO guesthub.reservation_rooms
          (tenant_id, reservation_id, room_id, check_in, check_out,
           adults, children, infants, rate_per_night, price_total,
           is_manual_rate, rate_plan_id, pricing_snapshot,
           guest_first_name, guest_last_name, guest_phone, guest_email)
        VALUES (${tenantId}, ${reservationId}, ${stay.roomId},
                ${stay.checkIn}, ${stay.checkOut},
                ${stay.adults}, ${stay.children}, 0,
                ${stay.ratePerNight}, ${stay.priceTotal},
                false, ${stay.ratePlanId},
                ${stay.pricingSnapshot === null ? null : tx.json(stay.pricingSnapshot as never)},
                ${input.guest.firstName}, ${input.guest.lastName},
                ${input.guest.phone}, ${input.guest.email})`;
    }

    // Card as guarantee — same columns as the staff save path (card-actions.ts),
    // source 'website' ("אתר ישיר"). CVV storage: owner decision D87.
    const pan = input.card.pan;
    await tx`
      INSERT INTO guesthub.reservation_cards
        (tenant_id, reservation_id, holder_name, holder_id_number,
         pan_encrypted, cvv_encrypted, key_version, brand, last4, exp_month, exp_year,
         source, received_at, created_by, updated_by)
      VALUES (${tenantId}, ${reservationId}, ${input.card.holderName},
              ${input.card.holderIdNumber}, ${encryptPan(pan)}, ${encryptCvv(input.card.cvv)},
              ${CARD_KEY_VERSION}, ${detectBrand(pan)}, ${pan.slice(-4)},
              ${input.card.expMonth}, ${input.card.expYear},
              'website', now(), NULL, NULL)`;

    await recomputePaymentAggregates(tx, tenantId, reservationId);

    // אישור הזמנה לאורח (מייל/וואטסאפ אם מוגדרים) — אותו מסלול כמו הזמנת צוות
    await enqueueReservationConfirmed(tx, {
      tenantId,
      reservationId,
      bookingOrigin: "direct_website",
    });

    // Consumed nights → outbound ARI stays true (the PM2 worker drains this).
    const roomIds = stays.map((s) => s.roomId);
    await markAriDirty(tx, {
      tenantId,
      roomIds,
      dateFrom: input.checkIn,
      dateTo: input.checkOut,
    });
    await publishDomainEvent(tx, tenantId, {
      type: "reservation.created",
      reservationId,
      roomIds,
      dateFrom: input.checkIn,
      dateTo: input.checkOut,
      lifecycle: "confirmed",
    });
    await publishDomainEvent(tx, tenantId, {
      type: "inventory.changed",
      roomIds,
      dateFrom: input.checkIn,
      dateTo: input.checkOut,
    });

    return { reservationId, reservationNumber: number, total };
  }) as Promise<{ reservationId: string; reservationNumber: string; total: number }>;
}

// Same allocation rule as reservations/actions.ts and booking-import.ts.
// ponytail: third copy — extract to a shared lib on the next touch of all three.
async function allocateReservationNumber(tx: TransactionSql, tenantId: string): Promise<string> {
  await tx`SELECT id FROM guesthub.tenants WHERE id = ${tenantId} FOR UPDATE`;
  const [row] = await tx<{ next: string }[]>`
    SELECT (COALESCE(MAX(NULLIF(regexp_replace(reservation_number, '\\D', '', 'g'), '')::bigint), 1000) + 1)::text AS next
    FROM guesthub.reservations WHERE tenant_id = ${tenantId}`;
  return row.next;
}

// Website guests are always fresh CRM rows (no guest identity/dedup exists —
// same behavior as the staff path without an id).
async function insertGuest(
  tx: TransactionSql,
  tenantId: string,
  guest: PublicBookingInput["guest"],
): Promise<string> {
  const fullName = `${guest.firstName} ${guest.lastName}`.trim();
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.guests
      (tenant_id, first_name, last_name, full_name, phone, email, language)
    VALUES (${tenantId}, ${guest.firstName}, ${guest.lastName}, ${fullName},
            ${guest.phone}, ${guest.email}, 'he')
    RETURNING id`;
  return created.id;
}

export { StayPricingError };
