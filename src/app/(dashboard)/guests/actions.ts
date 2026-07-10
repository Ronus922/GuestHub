"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError } from "@/lib/auth/actor";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// Guest profile read (D77 §19) — the guest row + its reservation history
// (incl. cancelled/no-show), payment summary and communication trail
// (outbound_messages is already guest-keyed since D53). Read-only.

const fail = (error: string): ActionResult<never> => ({ success: false, error });

export type GuestProfile = {
  guest: {
    id: string;
    full_name: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    email: string | null;
    id_number: string | null;
    country: string | null;
    language: string | null;
    is_vip: boolean;
    is_blocked: boolean;
    notes: string | null;
    created_at: string;
  };
  reservations: {
    id: string;
    reservation_number: string;
    status: string;
    check_in: string;
    check_out: string;
    total_price: number;
    paid_amount: number;
    currency: string;
    source_label: string | null;
    ota_name: string | null;
    cancelled_at: string | null;
    cancellation_origin: string | null;
  }[];
  otaSources: string[];
  /** tenant-currency totals only — foreign-currency rows are counted, never
   *  summed into a mixed number */
  totals: { paid: number; outstanding: number; currency: string; foreignCount: number };
  messages: { channel: string; status: string; created_at: string }[];
};

export async function getGuestProfileAction(id: string): Promise<ActionResult<GuestProfile>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "guests.view");
    const [guest] = await sql<GuestProfile["guest"][]>`
      SELECT id, full_name, first_name, last_name, phone, email, id_number,
             country, language, is_vip, is_blocked, notes, created_at::text AS created_at
      FROM guesthub.guests
      WHERE id = ${id} AND tenant_id = ${actor.tenantId}`;
    if (!guest) return fail("אורח לא נמצא");

    const reservations = await sql<GuestProfile["reservations"]>`
      SELECT res.id, res.reservation_number, res.status,
             res.check_in::text AS check_in, res.check_out::text AS check_out,
             res.total_price::float8 AS total_price,
             res.paid_amount::float8 AS paid_amount,
             res.currency, src.label AS source_label, res.ota_name,
             res.cancelled_at::text AS cancelled_at, res.cancellation_origin
      FROM guesthub.reservations res
      LEFT JOIN guesthub.lookup_items src ON src.id = res.source_id
      WHERE res.primary_guest_id = ${id} AND res.tenant_id = ${actor.tenantId}
      ORDER BY res.check_in DESC
      LIMIT 100`;

    const messages = await sql<GuestProfile["messages"]>`
      SELECT channel, status, created_at::text AS created_at
      FROM guesthub.outbound_messages
      WHERE guest_id = ${id} AND tenant_id = ${actor.tenantId}
      ORDER BY created_at DESC
      LIMIT 15`;

    const [tenant] = await sql<{ currency: string }[]>`
      SELECT currency FROM guesthub.tenants WHERE id = ${actor.tenantId}`;
    const cur = tenant?.currency || "ILS";
    const active = reservations.filter((r) => r.status !== "cancelled" && r.currency === cur);
    return {
      success: true,
      data: {
        guest,
        reservations,
        otaSources: [...new Set(reservations.map((r) => r.ota_name).filter((x): x is string => !!x))],
        totals: {
          paid: active.reduce((s, r) => s + r.paid_amount, 0),
          outstanding: active
            .filter((r) => r.status !== "no_show")
            .reduce((s, r) => s + Math.max(0, r.total_price - r.paid_amount), 0),
          currency: cur,
          foreignCount: reservations.filter((r) => r.currency !== cur && r.status !== "cancelled").length,
        },
        messages,
      },
    };
  } catch (e) {
    if (e instanceof AuthorizationError) return fail(e.message);
    console.error("[guests]", e);
    return fail("אירעה שגיאה בלתי צפויה");
  }
}
