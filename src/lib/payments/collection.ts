import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { paymentGatewayConfigured } from "./gateway";

// ============================================================
// Honest payment-collection derivation (D77 §D). ONE explicit state per
// reservation, derived from facts — never fabricated:
//
//   ota_collected            — the channel collects; GuestHub never charges
//   property_tokenized       — property collects and a REAL PSP payment-method
//                              reference exists (chargeable iff a gateway is
//                              configured and the reservation is live)
//   property_masked_only     — property collects but only the masked Channex
//                              guarantee exists — NOT chargeable, ever
//   no_card_or_other_method  — cash / transfer / manual / unspecified
//
// The masked guarantee is DISPLAY metadata (D76 §8); it never becomes a
// chargeable instrument and never marks anything paid.
// ============================================================

import { COLLECTION_LABEL, type CollectionState } from "./collection-labels";

export { COLLECTION_LABEL };
export type { CollectionState };

export type GuaranteeMeta = {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  /** cardholder display name from the channel guarantee — never a PAN */
  holderName: string | null;
  maskedDisplay: string | null;
  isVirtual: boolean;
  /** channel-supplied virtual-card activation window, when present */
  availableFrom: string | null;
  availableUntil: string | null;
};

export type TokenizedMethod = {
  provider: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  createdAt: string;
};

export type CollectionView = {
  state: CollectionState;
  /** "ota" | "property" | null — verbatim collection owner from the channel */
  collect: string | null;
  paymentType: string | null; // e.g. "credit_card"
  guarantee: GuaranteeMeta | null;
  tokenized: TokenizedMethod | null;
  chargeable: boolean;
  gatewayConfigured: boolean;
};

// PURE state derivation — the single truth table (unit-tested).
export function deriveCollectionState(input: {
  isOta: boolean;
  paymentCollect: string | null;
  hasTokenizedMethod: boolean;
  hasGuaranteeMeta: boolean;
  gatewayConfigured: boolean;
  lifecycleStatus: string;
}): { state: CollectionState; chargeable: boolean } {
  let state: CollectionState = "no_card_or_other_method";
  if (input.isOta && input.paymentCollect === "ota") state = "ota_collected";
  else if (input.hasTokenizedMethod) state = "property_tokenized";
  else if (input.isOta && input.paymentCollect === "property" && input.hasGuaranteeMeta)
    state = "property_masked_only";
  const chargeable =
    state === "property_tokenized" &&
    input.gatewayConfigured &&
    input.lifecycleStatus !== "cancelled";
  return { state, chargeable };
}

type RevisionCardMeta = {
  brand?: string | null;
  last4?: string | null;
  exp_month?: number | null;
  exp_year?: number | null;
  holder_name?: string | null;
  masked_display?: string | null;
  is_virtual?: boolean;
  available_from?: string | null;
  available_until?: string | null;
  masked_only?: boolean;
};

// Server half: reads the latest imported revision's collection facts + the
// PSP method row and derives the view. Read-only; safe on every detail load.
export async function loadCollectionView(
  db: Sql | TransactionSql,
  tenantId: string,
  reservation: { id: string; status: string; channel_connection_id: string | null },
): Promise<CollectionView> {
  const isOta = reservation.channel_connection_id !== null;

  let collect: string | null = null;
  let paymentType: string | null = null;
  let guarantee: GuaranteeMeta | null = null;
  if (isOta) {
    const [rev] = await db<
      { payment_collect: string | null; payment_type: string | null; card_meta: RevisionCardMeta | null }[]
    >`
      SELECT payload->>'payment_collect' AS payment_collect,
             payload->>'payment_type' AS payment_type,
             card_meta
      FROM guesthub.channel_booking_revisions
      WHERE tenant_id = ${tenantId} AND local_reservation_id = ${reservation.id}
        AND import_status = 'imported'
      ORDER BY created_at DESC LIMIT 1`;
    collect = rev?.payment_collect ?? null;
    paymentType = rev?.payment_type ?? null;
    if (rev?.card_meta && (rev.card_meta.last4 || rev.card_meta.brand)) {
      guarantee = {
        brand: rev.card_meta.brand ?? null,
        last4: rev.card_meta.last4 ?? null,
        expMonth: rev.card_meta.exp_month ?? null,
        expYear: rev.card_meta.exp_year ?? null,
        holderName: rev.card_meta.holder_name ?? null,
        maskedDisplay: rev.card_meta.masked_display ?? null,
        isVirtual: rev.card_meta.is_virtual === true,
        availableFrom: rev.card_meta.available_from ?? null,
        availableUntil: rev.card_meta.available_until ?? null,
      };
    }
  }

  const [method] = await db<
    { provider: string; brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; created_at: string }[]
  >`
    SELECT provider, brand, last4, exp_month, exp_year, created_at::text AS created_at
    FROM guesthub.reservation_payment_methods
    WHERE tenant_id = ${tenantId} AND reservation_id = ${reservation.id}
    ORDER BY created_at DESC LIMIT 1`;
  const tokenized: TokenizedMethod | null = method
    ? {
        provider: method.provider,
        brand: method.brand,
        last4: method.last4,
        expMonth: method.exp_month,
        expYear: method.exp_year,
        createdAt: method.created_at,
      }
    : null;

  const gateway = paymentGatewayConfigured();
  const { state, chargeable } = deriveCollectionState({
    isOta,
    paymentCollect: collect,
    hasTokenizedMethod: tokenized !== null,
    hasGuaranteeMeta: guarantee !== null,
    gatewayConfigured: gateway,
    lifecycleStatus: reservation.status,
  });
  return { state, collect, paymentType, guarantee, tokenized, chargeable, gatewayConfigured: gateway };
}
