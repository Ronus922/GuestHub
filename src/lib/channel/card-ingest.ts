import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { encryptPan, encryptCvv, CARD_KEY_VERSION, cardVaultConfigured } from "../card-vault";
import { cvvValid, detectBrand, normalizePan, panValid } from "../card-rules";
import type { ChannelCardData } from "./payloads";

// ============================================================
// Channel card ingestion (§Z reconciliation, D42/D43). Given an extracted card
// from a raw inbound booking, encrypts the PAN (+CVV when the channel sends one,
// e.g. virtual cards) and upserts it into reservation_cards. Encrypted
// immediately, never logged, never returned. Relative imports + an inline
// system-audit INSERT keep this module free of Next-only deps so it can run in
// the channel-ingest integration test against a real DB.
//
// "Do not overwrite channel card information with empty values": the upsert
// COALESCEs incoming nulls to the existing value. Virtual vs regular cards are
// distinguished by is_virtual and the channel-supplied availability window.
// ============================================================

export type ChannelCardIngestResult =
  | { stored: true; cardId: string }
  | { stored: false; reason: "no_card" | "invalid_pan" | "no_expiry" | "vault_unconfigured" };

export async function ingestChannelCard(
  db: Sql | TransactionSql,
  args: {
    tenantId: string;
    reservationId: string;
    otaName?: string | null;
    otaReservationCode?: string | null;
    card: ChannelCardData | null;
  },
): Promise<ChannelCardIngestResult> {
  const card = args.card;
  if (!card) return { stored: false, reason: "no_card" };
  if (!cardVaultConfigured()) return { stored: false, reason: "vault_unconfigured" };

  const pan = normalizePan(card.pan ?? "");
  if (!panValid(pan)) return { stored: false, reason: "invalid_pan" };
  if (card.expMonth === null || card.expYear === null) return { stored: false, reason: "no_expiry" };

  const panEncrypted = encryptPan(pan);
  const cvvEncrypted = card.cvv && cvvValid(card.cvv) ? encryptCvv(card.cvv) : null;
  const last4 = pan.slice(-4);
  const brand = card.brand ?? detectBrand(pan);
  const holderName = card.holderName ?? "כרטיס ערוץ";

  const [row] = await db<{ id: string }[]>`
    INSERT INTO guesthub.reservation_cards
      (tenant_id, reservation_id, holder_name, pan_encrypted, cvv_encrypted, key_version,
       brand, last4, exp_month, exp_year, source, source_channel,
       provider_reservation_ref, is_virtual, available_from, available_until, received_at)
    VALUES
      (${args.tenantId}, ${args.reservationId}, ${holderName}, ${panEncrypted}, ${cvvEncrypted}, ${CARD_KEY_VERSION},
       ${brand}, ${last4}, ${card.expMonth}, ${card.expYear}, 'channel', ${args.otaName ?? null},
       ${args.otaReservationCode ?? null}, ${card.isVirtual}, ${card.availableFrom},
       ${card.availableUntil}, now())
    ON CONFLICT (reservation_id) DO UPDATE SET
      holder_name = COALESCE(NULLIF(EXCLUDED.holder_name, ''), guesthub.reservation_cards.holder_name),
      pan_encrypted = EXCLUDED.pan_encrypted,
      cvv_encrypted = COALESCE(EXCLUDED.cvv_encrypted, guesthub.reservation_cards.cvv_encrypted),
      key_version = EXCLUDED.key_version,
      brand = COALESCE(EXCLUDED.brand, guesthub.reservation_cards.brand),
      last4 = EXCLUDED.last4,
      exp_month = EXCLUDED.exp_month,
      exp_year = EXCLUDED.exp_year,
      source = 'channel',
      source_channel = COALESCE(EXCLUDED.source_channel, guesthub.reservation_cards.source_channel),
      provider_reservation_ref = COALESCE(EXCLUDED.provider_reservation_ref, guesthub.reservation_cards.provider_reservation_ref),
      is_virtual = EXCLUDED.is_virtual,
      available_from = COALESCE(EXCLUDED.available_from, guesthub.reservation_cards.available_from),
      available_until = COALESCE(EXCLUDED.available_until, guesthub.reservation_cards.available_until),
      received_at = now(),
      updated_at = now()
    RETURNING id`;

  // system audit — masked metadata only, never the PAN/CVV
  await db`
    INSERT INTO guesthub.audit_logs
      (tenant_id, user_id, entity_type, entity_id, action, after_data, session_info)
    VALUES (${args.tenantId}, NULL, 'reservation_card', ${row.id}, 'card_import_channel',
            ${db.json({
              reservation_id: args.reservationId,
              source_channel: args.otaName ?? null,
              is_virtual: card.isVirtual,
              last4,
              cvv_stored: cvvEncrypted !== null,
            } as never)},
            ${`channel:${args.otaName ?? "unknown"}`})`;

  return { stored: true, cardId: row.id };
}
