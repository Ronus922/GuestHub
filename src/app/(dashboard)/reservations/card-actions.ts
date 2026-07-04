"use server";

import { sql } from "@/lib/db";
import { getActor, requirePermission, AuthorizationError, type Actor } from "@/lib/auth/actor";
import { writeAudit } from "@/lib/audit";
import {
  detectBrand,
  expiryInPast,
  normalizePan,
  panValid,
} from "@/lib/card-rules";
import { cardVaultConfigured, encryptPan, decryptPan, CARD_KEY_VERSION } from "@/lib/card-vault";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// Protected reservation-card actions (D41). The PAN travels ONLY through
// saveReservationCardAction (encrypted before persistence) and back ONLY
// through revealReservationCardAction (explicit, permission-guarded,
// audited). Nothing here ever logs a request body, puts digits in an
// error/audit payload beyond last4, or returns the PAN from save/list.
// CVV has no field anywhere — it is never accepted, stored or returned.
// ============================================================

class DomainError extends Error {}

const fail = (error: string): ActionResult<never> => ({ success: false, error });

function errorMessage(e: unknown): string {
  if (e instanceof AuthorizationError || e instanceof DomainError) return e.message;
  // never log card action inputs — only the error object itself
  console.error("[reservation-cards]", e);
  return "אירעה שגיאה בלתי צפויה";
}

export type StoredCardMeta = {
  id: string;
  brand: string | null;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName: string;
  holderIdNumber: string | null;
  updatedAt: string;
};

const META_COLS = sql`
  id, brand, last4,
  exp_month AS "expMonth", exp_year AS "expYear",
  holder_name AS "holderName", holder_id_number AS "holderIdNumber",
  updated_at::text AS "updatedAt"`;

async function requireReservation(actor: Actor, reservationId: string): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM guesthub.reservations
    WHERE id = ${reservationId} AND tenant_id = ${actor.tenantId}`;
  if (!row) throw new DomainError("הזמנה לא נמצאה");
}

// ---- save / replace (one active card per reservation) ----
export async function saveReservationCardAction(raw: {
  reservationId: string;
  holderName: string;
  holderIdNumber?: string;
  pan: string;
  expMonth: number;
  expYear: number;
}): Promise<ActionResult<StoredCardMeta>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_manage");
    if (!cardVaultConfigured()) {
      // fail closed — never fall back to plaintext storage
      return fail("אחסון כרטיסים אינו מוגדר בשרת (CARD_VAULT_KEY חסר)");
    }

    const holderName = String(raw.holderName ?? "").trim();
    if (holderName.length < 2 || holderName.length > 120) return fail("שם בעל הכרטיס אינו תקין");
    const holderId = String(raw.holderIdNumber ?? "").trim();
    if (holderId && !/^\d{5,9}$/.test(holderId)) return fail("תעודת זהות אינה תקינה");

    const pan = normalizePan(String(raw.pan ?? ""));
    if (!panValid(pan)) return fail("מספר כרטיס אינו תקין");

    const expMonth = Number(raw.expMonth);
    const expYear = Number(raw.expYear);
    if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) return fail("חודש תוקף אינו תקין");
    if (!Number.isInteger(expYear) || expYear < 2000 || expYear > 2099) return fail("שנת תוקף אינה תקינה");
    if (expiryInPast(expMonth, expYear, new Date())) return fail("תוקף הכרטיס פג");

    await requireReservation(actor, raw.reservationId);

    const encrypted = encryptPan(pan);
    const brand = detectBrand(pan);
    const last4 = pan.slice(-4);

    const meta = await sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string; last4: string }[]>`
        SELECT id, last4 FROM guesthub.reservation_cards
        WHERE reservation_id = ${raw.reservationId} AND tenant_id = ${actor.tenantId}
        FOR UPDATE`;
      const [row] = await tx<StoredCardMeta[]>`
        INSERT INTO guesthub.reservation_cards
          (tenant_id, reservation_id, holder_name, holder_id_number,
           pan_encrypted, key_version, brand, last4, exp_month, exp_year,
           created_by, updated_by)
        VALUES (${actor.tenantId}, ${raw.reservationId}, ${holderName}, ${holderId || null},
                ${encrypted}, ${CARD_KEY_VERSION}, ${brand}, ${last4}, ${expMonth}, ${expYear},
                ${actor.userId}, ${actor.userId})
        ON CONFLICT (reservation_id) DO UPDATE SET
          holder_name = EXCLUDED.holder_name,
          holder_id_number = EXCLUDED.holder_id_number,
          pan_encrypted = EXCLUDED.pan_encrypted,
          key_version = EXCLUDED.key_version,
          brand = EXCLUDED.brand,
          last4 = EXCLUDED.last4,
          exp_month = EXCLUDED.exp_month,
          exp_year = EXCLUDED.exp_year,
          updated_by = ${actor.userId},
          updated_at = now()
        RETURNING ${META_COLS}`;
      // audit carries masked metadata only — never full digits
      await writeAudit(actor, {
        entityType: "reservation_card",
        entityId: row.id,
        action: existing ? "card_replace" : "card_save",
        before: existing ? { last4: existing.last4 } : undefined,
        after: { brand, last4, reservation_id: raw.reservationId },
      }, tx);
      return row;
    });

    // saving a card is NOT a payment: no status/paid/transaction change here
    return { success: true, data: meta };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---- explicit full-PAN reveal (server-enforced permission, audited) ----
export async function revealReservationCardAction(
  cardId: string,
): Promise<ActionResult<{ pan: string }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_reveal");
    if (!cardVaultConfigured()) return fail("אחסון כרטיסים אינו מוגדר בשרת");

    const [row] = await sql<{ id: string; reservation_id: string; pan_encrypted: string }[]>`
      SELECT id, reservation_id, pan_encrypted FROM guesthub.reservation_cards
      WHERE id = ${cardId} AND tenant_id = ${actor.tenantId}`;
    if (!row) return fail("כרטיס שמור לא נמצא");

    const pan = decryptPan(row.pan_encrypted);
    await writeAudit(actor, {
      entityType: "reservation_card",
      entityId: row.id,
      action: "card_reveal",
      after: { reservation_id: row.reservation_id },
    });
    return { success: true, data: { pan } };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---- delete ----
export async function deleteReservationCardAction(cardId: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_manage");
    await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string; reservation_id: string; last4: string }[]>`
        DELETE FROM guesthub.reservation_cards
        WHERE id = ${cardId} AND tenant_id = ${actor.tenantId}
        RETURNING id, reservation_id, last4`;
      if (!row) throw new DomainError("כרטיס שמור לא נמצא");
      await writeAudit(actor, {
        entityType: "reservation_card",
        entityId: row.id,
        action: "card_delete",
        before: { last4: row.last4, reservation_id: row.reservation_id },
      }, tx);
    });
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
