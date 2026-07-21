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
  cvvValid,
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
  encryptCvv,
  decryptCvv,
  CARD_KEY_VERSION,
} from "@/lib/card-vault";
import { getPaymentGateway, NO_GATEWAY_MESSAGE } from "@/lib/payments/gateway";
import { recomputePaymentAggregates } from "@/lib/payments/ledger";
import { recordRefund, voidPayment } from "@/lib/payments/mutations";
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
  cvv: string | null; // D87 — stored CVV, decrypted here only
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
  cvv?: string;
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

    // D87 — CVV stored (owner decision, migration 047). Optional; when present it
    // must be 3–4 digits. Encrypted at rest, NEVER logged/audited/echoed. See the
    // PCI ceiling note in card-vault.ts.
    const cvvRaw = String(raw.cvv ?? "").trim();
    if (cvvRaw && !cvvValid(cvvRaw)) return fail("קוד אבטחה (CVV) אינו תקין");
    const cvvEncrypted = cvvRaw ? encryptCvv(cvvRaw) : null;

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
           pan_encrypted, cvv_encrypted, key_version, brand, last4, exp_month, exp_year,
           source, billing_notes, received_at, created_by, updated_by)
        VALUES (${actor.tenantId}, ${raw.reservationId}, ${holderName}, ${holderId || null},
                ${encrypted}, ${cvvEncrypted}, ${CARD_KEY_VERSION}, ${brand}, ${last4}, ${expMonth}, ${expYear},
                ${source}, ${billingNotes}, now(), ${actor.userId}, ${actor.userId})
        ON CONFLICT (reservation_id) DO UPDATE SET
          holder_name = EXCLUDED.holder_name,
          holder_id_number = EXCLUDED.holder_id_number,
          pan_encrypted = EXCLUDED.pan_encrypted,
          cvv_encrypted = EXCLUDED.cvv_encrypted,
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
        id: string; reservation_id: string; pan_encrypted: string; cvv_encrypted: string | null;
        holder_name: string; holder_id_number: string | null; exp_month: number; exp_year: number;
        brand: string | null; source: CardSource; source_channel: string | null;
        is_virtual: boolean; available_until: string | null;
      }[]
    >`
      SELECT id, reservation_id, pan_encrypted, cvv_encrypted,
             holder_name, holder_id_number, exp_month, exp_year, brand,
             source, source_channel, is_virtual, available_until::text AS available_until
      FROM guesthub.reservation_cards
      WHERE id = ${cardId} AND tenant_id = ${actor.tenantId}`;
    if (!row) return fail("כרטיס שמור לא נמצא");

    const pan = decryptPan(row.pan_encrypted);
    const cvv = row.cvv_encrypted ? decryptCvv(row.cvv_encrypted) : null;
    const fields = [
      "pan",
      "expiry",
      "holder",
      ...(row.cvv_encrypted ? ["cvv"] : []),
      ...(row.holder_id_number ? ["holder_id"] : []),
    ];
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
        cvv,
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
// Routes through the payment-gateway seam (src/lib/payments/gateway.ts): no
// configured PSP → fails closed with NO_GATEWAY_MESSAGE. With a gateway, the
// stored PAN (+CVV, transiently) is decrypted for THIS request only and sent to
// the provider; success is returned ONLY on real provider evidence, and the
// captured payment lands in the ledger idempotently (keyed by the provider's
// transaction id) with paid/balance reconciled from it (D51). No digits or CVV
// ever reach a log, an audit row or an error message.
export async function chargeReservationCardAction(input: {
  cardId: string;
  amount: number;
}): Promise<
  ActionResult<{ charged: boolean; paid?: number; balance?: number; reference?: string | null }>
> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.card_charge");
    const ctx = await auditRequestContext();
    const amount = Math.max(0, Math.round(Number(input.amount) || 0));

    const [row] = await sql<
      {
        id: string; reservation_id: string; pan_encrypted: string; cvv_encrypted: string | null;
        holder_name: string; holder_id_number: string | null; exp_month: number; exp_year: number;
      }[]
    >`
      SELECT id, reservation_id, pan_encrypted, cvv_encrypted,
             holder_name, holder_id_number, exp_month, exp_year
      FROM guesthub.reservation_cards
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

    // fail closed rather than fabricate a success (D46)
    if (!gateway) return fail(NO_GATEWAY_MESSAGE);
    if (amount <= 0) return fail("סכום החיוב חייב להיות חיובי");
    if (!cardVaultConfigured()) return fail("אחסון כרטיסים אינו מוגדר בשרת");

    // transient decrypt for THIS request only — the plaintext exists solely in
    // the charge call below and is discarded with this scope (D52 §2)
    const pan = decryptPan(row.pan_encrypted);
    const cvv = row.cvv_encrypted ? decryptCvv(row.cvv_encrypted) : null;

    // unique per attempt: PSP-side idempotency — a double-submit of the same
    // attempt is rejected by the provider instead of double-charging
    const reference = `res:${row.reservation_id}:${crypto.randomUUID()}`;
    const result = await gateway.charge({
      amount,
      currency: "ILS",
      pan,
      expMonth: row.exp_month,
      expYear: row.exp_year,
      cvv,
      holderName: row.holder_name,
      holderIdNumber: row.holder_id_number,
      reference,
    });

    if (!result.success) {
      await writeAudit(actor, {
        entityType: "reservation_card",
        entityId: row.id,
        action: "card_charge_result",
        after: {
          reservation_id: row.reservation_id, amount,
          outcome: "declined", provider: gateway.id, error: result.error ?? null,
        },
        ip: ctx.ip,
        session: ctx.session,
      });
      return fail(result.error ?? "החיוב נדחה על ידי ספק הסליקה");
    }

    // money moved at the provider — record it in the canonical ledger (D51/D52),
    // idempotently keyed by the provider transaction id (a replay recomputes but
    // never double-counts), and reconcile paid/balance from the ledger.
    const data = await sql.begin(async (tx) => {
      const idempotencyKey = `psp:${gateway.id}:${result.providerRef ?? reference}`;
      await tx`
        INSERT INTO guesthub.payments
          (tenant_id, reservation_id, amount, method, status, paid_at, reference, idempotency_key)
        VALUES (${actor.tenantId}, ${row.reservation_id}, ${amount}, 'credit_card',
                'paid', now(), ${result.providerRef ?? null}, ${idempotencyKey})
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`;
      const { paid, balance } = await recomputePaymentAggregates(
        tx, actor.tenantId, row.reservation_id,
      );
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: row.reservation_id,
        action: "card_charge_captured",
        after: {
          amount, provider: gateway.id,
          reference: result.providerRef ?? null, outcome: "captured",
        },
        ip: ctx.ip,
        session: ctx.session,
      }, tx);
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.payment_changed",
        reservationId: row.reservation_id,
      });
      return { charged: true, paid, balance, reference: result.providerRef ?? null };
    });

    return { success: true, data };
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

      // M6: when an external reference is supplied it is the natural idempotency
      // key — recording the same external transaction twice is suppressed by the
      // unique (tenant_id, idempotency_key) index, so a double-submit can't
      // double-count money. No reference → no key (manual entries stay additive).
      const idempotencyKey = reference ? `ext:${reference}` : null;
      const [payment] = await tx<
        { id: string; amount: number; method: string | null; paid_at: string; reference: string | null }[]
      >`
        INSERT INTO guesthub.payments
          (tenant_id, reservation_id, amount, method, status, paid_at, reference, notes, idempotency_key)
        VALUES (${actor.tenantId}, ${input.reservationId}, ${amount}, ${method},
                'paid', now(), ${reference}, ${note}, ${idempotencyKey})
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id, amount::float8 AS amount, method, paid_at::text AS paid_at, reference`;
      if (!payment) throw new DomainError("תשלום עם אסמכתא זו כבר נרשם");

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

// ---- refund / void (Stage 3, H7) ----
// Refund and void are the sanctioned corrections to captured money. Both go
// through the canonical ledger (lib/payments/mutations) so paid_amount/balance
// stay derived, never hand-adjusted. Neither performs a real PSP operation —
// they record money movements done OUTSIDE GuestHub (like the external recorder).
export async function refundPaymentAction(input: {
  reservationId: string;
  amount: number;
  method?: string;
  reference?: string;
  note?: string;
  confirmed: boolean;
}): Promise<ActionResult<{ refunded: number; paid: number; balance: number }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.refund");
    if (!input.confirmed) return fail("נדרש אישור שהזיכוי בוצע בפועל");
    const amount = Math.round((Number(input.amount) || 0) * 100) / 100;
    if (amount <= 0) return fail("סכום הזיכוי חייב להיות חיובי");
    const method = String(input.method ?? "").trim() || "refund";
    const reference = String(input.reference ?? "").trim().slice(0, 120) || null;
    const note = String(input.note ?? "").trim().slice(0, 500) || null;
    const ctx = await auditRequestContext();

    const result = await sql.begin(async (tx) => {
      const refunded = await recordRefund(tx, {
        tenantId: actor.tenantId,
        reservationId: input.reservationId,
        amount, method, reference, notes: note,
        idempotencyKey: reference ? `refund:${reference}` : null,
      });
      if (!refunded) throw new DomainError("זיכוי עם אסמכתא זו כבר נרשם");
      await writeAudit(actor, {
        entityType: "reservation",
        entityId: input.reservationId,
        action: "payment_refund_record",
        after: { amount, method, reference, outcome: "refunded_external" },
        ip: ctx.ip, session: ctx.session,
      }, tx);
      await publishDomainEvent(tx, actor.tenantId, {
        type: "reservation.payment_changed", reservationId: input.reservationId,
      });
      return { refunded: refunded.refunded, paid: refunded.paid, balance: refunded.balance };
    });
    return { success: true, data: result };
  } catch (e) {
    return fail(errorMessage(e));
  }
}

export async function voidPaymentAction(input: {
  reservationId: string;
  paymentId: string;
}): Promise<ActionResult<{ voided: boolean }>> {
  try {
    const actor = await getActor();
    requirePermission(actor, "payments.refund");
    const ctx = await auditRequestContext();
    const voided = await sql.begin(async (tx) => {
      const ok = await voidPayment(tx, actor.tenantId, input.paymentId);
      if (ok) {
        await writeAudit(actor, {
          entityType: "reservation",
          entityId: input.reservationId,
          action: "payment_void",
          after: { paymentId: input.paymentId, outcome: "voided" },
          ip: ctx.ip, session: ctx.session,
        }, tx);
        await publishDomainEvent(tx, actor.tenantId, {
          type: "reservation.payment_changed", reservationId: input.reservationId,
        });
      }
      return ok;
    });
    return { success: true, data: { voided } };
  } catch (e) {
    return fail(errorMessage(e));
  }
}
