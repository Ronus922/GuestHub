"use server";

import { sql } from "@/lib/db";
import {
  getActor,
  hasPermission,
  requirePermission,
  AuthorizationError,
  type Actor,
} from "@/lib/auth/actor";
import { writeAudit, auditRequestContext } from "@/lib/audit";
import {
  detectBrand,
  expiryInPast,
  MANUAL_CARD_SOURCES,
  normalizePan,
  panValid,
  type CardSource,
} from "@/lib/card-rules";
import {
  cardVaultConfigured,
  encryptPan,
  decryptPan,
  CARD_KEY_VERSION,
} from "@/lib/card-vault";
import { getPaymentGateway, NO_GATEWAY_MESSAGE } from "@/lib/payments/gateway";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import { publishDomainEvent } from "@/lib/realtime/publish";
import type { ActionResult } from "@/app/(dashboard)/calendar/types";

// ============================================================
// Protected reservation-card actions (D41/D42/D52). The PAN travels ONLY through
// saveReservationCardAction (encrypted before persistence) and back ONLY
// through revealReservationCardAction (explicit, permission-guarded, audited).
// Nothing here ever logs a request body, puts digits in an error/audit payload
// beyond last4, or returns the PAN from save/list.
//
// CVV/CVC is NEVER accepted, stored, encrypted, revealed, logged or audited
// (D52 §2). The save action does not take a CVV; the reveal never returns one;
// no cvv_encrypted column exists (dropped in migration 018). A CVV may exist
// only transiently inside a single PSP authorization request via the gateway
// seam, and is discarded immediately after. Every reveal and charge — success
// OR rejected — is recorded with IP + session.
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
  source: CardSource;
  sourceChannel: string | null;
  isVirtual: boolean;
  availableUntil: string | null;
  billingNotes: string | null;
  updatedAt: string;
};

// The full plaintext bundle returned ONLY by the audited reveal action.
// NOTE (D52): no CVV — it is never stored, so it can never be revealed.
export type RevealedCard = {
  pan: string;
  holderName: string;
  holderIdNumber: string | null;
  expMonth: number;
  expYear: number;
  brand: string | null;
  source: CardSource;
  sourceChannel: string | null;
  isVirtual: boolean;
  availableUntil: string | null;
};

const META_COLS = sql`
  id, brand, last4,
  exp_month AS "expMonth", exp_year AS "expYear",
  holder_name AS "holderName", holder_id_number AS "holderIdNumber",
  source, source_channel AS "sourceChannel", is_virtual AS "isVirtual",
  available_until::text AS "availableUntil", billing_notes AS "billingNotes",
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
  source?: CardSource;
  billingNotes?: string;
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

    // manual entry may only set a manual source — never 'channel' (that path
    // is server-only ingest); default to back-office
    const source: CardSource =
      raw.source && MANUAL_CARD_SOURCES.includes(raw.source) ? raw.source : "back_office";
    const billingNotes = String(raw.billingNotes ?? "").trim().slice(0, 500) || null;

    const pan = normalizePan(String(raw.pan ?? ""));
    if (!panValid(pan)) return fail("מספר כרטיס אינו תקין");

    // CVV is intentionally NOT accepted or stored (D52 §2).

    const expMonth = Number(raw.expMonth);
    const expYear = Number(raw.expYear);
    if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) return fail("חודש תוקף אינו תקין");
    if (!Number.isInteger(expYear) || expYear < 2000 || expYear > 2099) return fail("שנת תוקף אינה תקינה");
    if (expiryInPast(expMonth, expYear, new Date())) return fail("תוקף הכרטיס פג");

    await requireReservation(actor, raw.reservationId);

    const encrypted = encryptPan(pan);
    const brand = detectBrand(pan);
    const last4 = pan.slice(-4);
    const ctx = await auditRequestContext();

    const meta = await sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string; last4: string }[]>`
        SELECT id, last4 FROM guesthub.reservation_cards
        WHERE reservation_id = ${raw.reservationId} AND tenant_id = ${actor.tenantId}
        FOR UPDATE`;
      const [row] = await tx<StoredCardMeta[]>`
        INSERT INTO guesthub.reservation_cards
          (tenant_id, reservation_id, holder_name, holder_id_number,
           pan_encrypted, key_version, brand, last4, exp_month, exp_year,
           source, billing_notes, received_at, created_by, updated_by)
        VALUES (${actor.tenantId}, ${raw.reservationId}, ${holderName}, ${holderId || null},
                ${encrypted}, ${CARD_KEY_VERSION}, ${brand}, ${last4}, ${expMonth}, ${expYear},
                ${source}, ${billingNotes}, now(), ${actor.userId}, ${actor.userId})
        ON CONFLICT (reservation_id) DO UPDATE SET
          holder_name = EXCLUDED.holder_name,
          holder_id_number = EXCLUDED.holder_id_number,
          pan_encrypted = EXCLUDED.pan_encrypted,
          key_version = EXCLUDED.key_version,
          brand = EXCLUDED.brand,
          last4 = EXCLUDED.last4,
          exp_month = EXCLUDED.exp_month,
          exp_year = EXCLUDED.exp_year,
          source = EXCLUDED.source,
          source_channel = NULL,
          is_virtual = false,
          billing_notes = EXCLUDED.billing_notes,
          received_at = EXCLUDED.received_at,
          updated_by = ${actor.userId},
          updated_at = now()
        RETURNING ${META_COLS}`;
      // audit carries masked metadata only — never full digits
      await writeAudit(actor, {
        entityType: "reservation_card",
        entityId: row.id,
        action: existing ? "card_replace" : "card_save",
        before: existing ? { last4: existing.last4 } : undefined,
        // masked metadata only — never digits, never a CVV (none is stored)
        after: { brand, last4, source, reservation_id: raw.reservationId },
        ip: ctx.ip,
        session: ctx.session,
      }, tx);
      return row;
    });

    // saving a card is NOT a payment: no status/paid/transaction change here
    return { success: true, data: meta };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---- explicit full-card reveal (server-enforced permission, audited) ----
// Returns the full PAN and other stored card fields (NEVER a CVV — none is
// stored), decrypted server-side for THIS authenticated request only. Repeatable
// — the encrypted PAN is never deleted or replaced by a reveal. Records success
// AND rejected attempts, which fields were revealed, IP + session. The audit
// NEVER carries the digits.
export async function revealReservationCardAction(
  cardId: string,
): Promise<ActionResult<RevealedCard>> {
  const actor = await getActor();
  const ctx = await auditRequestContext();
  try {
    if (!actor) throw new AuthorizationError("לא מחובר למערכת");

    // audit the REJECTED reveal before refusing (spec: success or rejected)
    if (!hasPermission(actor, "payments.card_reveal")) {
      await writeAudit(actor, {
        entityType: "reservation_card",
        entityId: cardId,
        action: "card_reveal_denied",
        after: { outcome: "rejected" },
        ip: ctx.ip,
        session: ctx.session,
      });
      throw new AuthorizationError("חסרה הרשאה: payments.card_reveal");
    }
    if (!cardVaultConfigured()) return fail("אחסון כרטיסים אינו מוגדר בשרת");

    const [row] = await sql<
      {
        id: string; reservation_id: string; pan_encrypted: string;
        holder_name: string; holder_id_number: string | null; exp_month: number; exp_year: number;
        brand: string | null; source: CardSource; source_channel: string | null;
        is_virtual: boolean; available_until: string | null;
      }[]
    >`
      SELECT id, reservation_id, pan_encrypted,
             holder_name, holder_id_number, exp_month, exp_year, brand,
             source, source_channel, is_virtual, available_until::text AS available_until
      FROM guesthub.reservation_cards
      WHERE id = ${cardId} AND tenant_id = ${actor.tenantId}`;
    if (!row) return fail("כרטיס שמור לא נמצא");

    const pan = decryptPan(row.pan_encrypted);
    const fields = ["pan", "expiry", "holder", ...(row.holder_id_number ? ["holder_id"] : [])];
    await writeAudit(actor, {
      entityType: "reservation_card",
      entityId: row.id,
      action: "card_reveal",
      after: { reservation_id: row.reservation_id, fields, outcome: "success" },
      ip: ctx.ip,
      session: ctx.session,
    });
    return {
      success: true,
      data: {
        pan,
        holderName: row.holder_name,
        holderIdNumber: row.holder_id_number,
        expMonth: row.exp_month,
        expYear: row.exp_year,
        brand: row.brand,
        source: row.source,
        sourceChannel: row.source_channel,
        isVirtual: row.is_virtual,
        availableUntil: row.available_until,
      },
    };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---- immediate charge via PSP (server-enforced permission, audited) ----
// Routes through the payment-gateway seam (src/lib/payments/gateway.ts). No PSP
// is integrated today, so getPaymentGateway() is null and this fails closed. When
// a real gateway lands, the else-branch decrypts the stored PAN and calls
// gateway.charge() (a CVV, if the flow needs one, is collected transiently at
// that moment and discarded — never stored); nothing at the call sites changes.
export async function chargeReservationCardAction(input: {
  cardId: string;
  amount: number;
}): Promise<ActionResult<{ charged: false }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_charge");
    const ctx = await auditRequestContext();
    const amount = Math.max(0, Math.round(Number(input.amount) || 0));

    const [row] = await sql<{ id: string; reservation_id: string }[]>`
      SELECT id, reservation_id FROM guesthub.reservation_cards
      WHERE id = ${input.cardId} AND tenant_id = ${actor.tenantId}`;
    if (!row) return fail("כרטיס שמור לא נמצא");

    const gateway = getPaymentGateway();
    // audit the attempt WITHOUT any card digits or the CVV
    await writeAudit(actor, {
      entityType: "reservation_card",
      entityId: row.id,
      action: "card_charge_attempt",
      after: { reservation_id: row.reservation_id, amount, outcome: gateway ? "gateway" : "no_gateway" },
      ip: ctx.ip,
      session: ctx.session,
    });

    // ponytail: no PSP integrated yet → always fail closed rather than fabricate
    // a success. A real gateway (getPaymentGateway() non-null) decrypts the
    // stored card via the vault, calls gateway.charge(), then records the
    // payment — wire that here; the call sites already handle this null case.
    return fail(NO_GATEWAY_MESSAGE);
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---- record a payment collected OUTSIDE GuestHub (external terminal / PSP) ----
// This is NOT a GuestHub charge: no card is charged here. It records that staff
// collected a payment elsewhere (terminal/provider) and moves the reservation's
// paid/balance forward — ONLY on explicit staff confirmation. Captures amount,
// method, reference and audits who/when/IP. Used while no gateway is wired.
export async function recordExternalPaymentAction(input: {
  reservationId: string;
  amount: number;
  method?: string;
  reference?: string;
  note?: string;
  confirmed: boolean;
}): Promise<
  ActionResult<{
    paid: number;
    balance: number;
    payment: { id: string; amount: number; method: string | null; paid_at: string; reference: string | null };
  }>
> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_charge");
    if (!input.confirmed) return fail("נדרש אישור שהתשלום נגבה בפועל");

    const amount = Math.round(Number(input.amount) || 0);
    if (amount <= 0) return fail("סכום התשלום חייב להיות חיובי");
    const method = String(input.method ?? "").trim() || "credit_card";
    const reference = String(input.reference ?? "").trim().slice(0, 120) || null;
    const note = String(input.note ?? "").trim().slice(0, 500) || null;
    const ctx = await auditRequestContext();

    const result = await sql.begin(async (tx) => {
      const [res] = await tx<{ total_price: string }[]>`
        SELECT total_price FROM guesthub.reservations
        WHERE id = ${input.reservationId} AND tenant_id = ${actor.tenantId}
        FOR UPDATE`;
      if (!res) throw new DomainError("הזמנה לא נמצאה");

      const [payment] = await tx<
        { id: string; amount: number; method: string | null; paid_at: string; reference: string | null }[]
      >`
        INSERT INTO guesthub.payments
          (tenant_id, reservation_id, amount, method, status, paid_at, reference, notes)
        VALUES (${actor.tenantId}, ${input.reservationId}, ${amount}, ${method},
                'paid', now(), ${reference}, ${note})
        RETURNING id, amount::float8 AS amount, method, paid_at::text AS paid_at, reference`;

      // paid_amount/balance derive from the payments LEDGER (D51) — one
      // formula everywhere, never an incremental add that can drift.
      const { paid, balance } = await recomputePaymentAggregates(
        tx, actor.tenantId, input.reservationId,
      );

      // audited as an EXTERNAL record — never as a charge performed by GuestHub
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: input.reservationId,
        action: "payment_external_record",
        after: { amount, method, reference, outcome: "recorded_external" },
        ip: ctx.ip,
        session: ctx.session,
      }, tx);

      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.payment_changed",
        reservationId: input.reservationId,
      });

      return { paid, balance, payment };
    });

    return { success: true, data: result };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

// ---- delete ----
export async function deleteReservationCardAction(cardId: string): Promise<ActionResult> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_manage");
    const ctx = await auditRequestContext();
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
        ip: ctx.ip,
        session: ctx.session,
      }, tx);
    });
    return { success: true };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
