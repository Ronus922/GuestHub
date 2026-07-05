import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { extractChannelCard, redactPayload } from "./payloads";
import { encryptPan, encryptCvv, CARD_KEY_VERSION, cardVaultConfigured } from "../card-vault";
import { cvvValid, detectBrand, normalizePan, panValid } from "../card-rules";

// ============================================================
// Inbound booking-revision foundation (§X) + operational channel-card capture
// (§Z reconciliation, D43). persistBookingRevision is the concrete seam where a
// full inbound booking payload is handled: it EXTRACTS + ENCRYPTS the card from
// the RAW payload BEFORE the payload is redacted, staging the ciphertext on the
// revision row. The stored `payload` column stays redacted — raw card data
// never lands in it or in any log. markRevisionImported then MOVES the staged
// encrypted card into reservation_cards once a local reservation exists.
//
// NOTE: no live poller calls these yet (no revision→reservation importer runs
// in the app today). Card extraction/encryption is wired at this real seam and
// covered by scripts/check-channel-card-ingest.mjs; the app-level chain
// activates when the Phase-4 importer lands.
// ============================================================

export type RevisionInput = {
  tenantId: string;
  connectionId: string;
  providerBookingId: string;
  providerRevisionId: string;
  uniqueId?: string;
  systemId?: string;
  otaReservationCode?: string;
  otaName?: string;
  revisionKind: "new" | "modified" | "cancelled";
  rawStatus?: string;
  payload: unknown;
};

// Non-sensitive metadata staged alongside the encrypted PAN/CVV. NEVER holds a
// plaintext PAN or CVV.
type StagedCardMeta = {
  holder_name: string | null;
  brand: string | null;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_virtual: boolean;
  source_channel: string | null;
  provider_reservation_ref: string | null;
  available_from: string | null;
  available_until: string | null;
  key_version: number;
};

// Extract + encrypt the card from a raw payload. Returns the encrypted columns
// and the non-sensitive meta, or nulls when there is no usable card.
function stageCard(rev: RevisionInput): {
  panEnc: string | null;
  cvvEnc: string | null;
  meta: StagedCardMeta | null;
} {
  if (!cardVaultConfigured()) return { panEnc: null, cvvEnc: null, meta: null };
  const card = extractChannelCard(rev.payload);
  if (!card) return { panEnc: null, cvvEnc: null, meta: null };
  const pan = normalizePan(card.pan ?? "");
  if (!panValid(pan) || card.expMonth === null || card.expYear === null) {
    return { panEnc: null, cvvEnc: null, meta: null };
  }
  return {
    panEnc: encryptPan(pan),
    cvvEnc: card.cvv && cvvValid(card.cvv) ? encryptCvv(card.cvv) : null,
    meta: {
      holder_name: card.holderName,
      brand: card.brand ?? detectBrand(pan),
      last4: pan.slice(-4),
      exp_month: card.expMonth,
      exp_year: card.expYear,
      is_virtual: card.isVirtual,
      source_channel: rev.otaName ?? null,
      provider_reservation_ref: rev.otaReservationCode ?? null,
      available_from: card.availableFrom,
      available_until: card.availableUntil,
      key_version: CARD_KEY_VERSION,
    },
  };
}

// Idempotent persistence: the same provider revision can never be stored (and
// therefore never imported) twice — identity is (connection, revision_id),
// never the OTA reservation code alone. The card is encrypted-staged here; the
// stored payload is redacted.
export async function persistBookingRevision(
  db: Sql | TransactionSql,
  rev: RevisionInput,
): Promise<{ id: string; duplicate: false } | { duplicate: true }> {
  const { panEnc, cvvEnc, meta } = stageCard(rev);
  const rows = await db<{ id: string }[]>`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id,
       unique_id, system_id, ota_reservation_code, ota_name,
       revision_kind, raw_status, payload,
       card_pan_encrypted, card_cvv_encrypted, card_meta)
    VALUES
      (${rev.tenantId}, ${rev.connectionId}, ${rev.providerBookingId},
       ${rev.providerRevisionId}, ${rev.uniqueId ?? null}, ${rev.systemId ?? null},
       ${rev.otaReservationCode ?? null}, ${rev.otaName ?? null},
       ${rev.revisionKind}, ${rev.rawStatus ?? null},
       ${db.json(redactPayload(rev.payload) as never)},
       ${panEnc}, ${cvvEnc}, ${meta ? db.json(meta as never) : null})
    ON CONFLICT (connection_id, provider_revision_id) DO NOTHING
    RETURNING id`;
  return rows[0] ? { id: rows[0].id, duplicate: false } : { duplicate: true };
}

// Unmapped room type / rate plan → quarantined with a visible error, raw
// identifiers retained; never silently discarded, never a broken local
// reservation, never falsely acknowledged.
export async function quarantineRevision(
  db: Sql | TransactionSql,
  revisionId: string,
  mappingError: string,
): Promise<void> {
  await db`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'quarantined', mapping_error = ${mappingError},
      attempts = attempts + 1
    WHERE id = ${revisionId}`;
}

// Move a revision's staged encrypted card into reservation_cards for the created
// local reservation. Copies the ciphertext (no re-encrypt); COALESCEs so an
// empty incoming value never overwrites an existing encrypted one (§8/§10).
async function attachStagedCard(
  tx: TransactionSql,
  tenantId: string,
  reservationId: string,
  panEnc: string,
  cvvEnc: string | null,
  meta: StagedCardMeta,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.reservation_cards
      (tenant_id, reservation_id, holder_name, pan_encrypted, cvv_encrypted, key_version,
       brand, last4, exp_month, exp_year, source, source_channel,
       provider_reservation_ref, is_virtual, available_from, available_until, received_at)
    VALUES
      (${tenantId}, ${reservationId}, ${meta.holder_name || "כרטיס ערוץ"}, ${panEnc}, ${cvvEnc},
       ${meta.key_version}, ${meta.brand}, ${meta.last4}, ${meta.exp_month}, ${meta.exp_year},
       'channel', ${meta.source_channel}, ${meta.provider_reservation_ref}, ${meta.is_virtual},
       ${meta.available_from}, ${meta.available_until}, now())
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
  await tx`
    INSERT INTO guesthub.audit_logs
      (tenant_id, user_id, entity_type, entity_id, action, after_data, session_info)
    VALUES (${tenantId}, NULL, 'reservation_card', ${row.id}, 'card_import_channel',
            ${tx.json({
              reservation_id: reservationId,
              source_channel: meta.source_channel,
              is_virtual: meta.is_virtual,
              last4: meta.last4,
              cvv_stored: cvvEnc !== null,
            } as never)},
            ${`channel:${meta.source_channel ?? "unknown"}`})`;
}

// Mark imported — call ONLY inside the transaction that created the local
// reservation/inventory hold, so "imported" implies durably saved. When a local
// reservation exists and the revision staged a card, the card is attached to it.
export async function markRevisionImported(
  tx: TransactionSql,
  tenantId: string,
  revisionId: string,
  localReservationId: string | null,
): Promise<void> {
  const [rev] = await tx<
    {
      card_pan_encrypted: string | null;
      card_cvv_encrypted: string | null;
      card_meta: StagedCardMeta | null;
    }[]
  >`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'imported', local_reservation_id = ${localReservationId},
      mapping_error = NULL
    WHERE id = ${revisionId}
    RETURNING card_pan_encrypted, card_cvv_encrypted, card_meta`;
  if (localReservationId && rev?.card_pan_encrypted && rev.card_meta) {
    await attachStagedCard(
      tx,
      tenantId,
      localReservationId,
      rev.card_pan_encrypted,
      rev.card_cvv_encrypted,
      rev.card_meta,
    );
  }
}

// Acknowledgement gate (§X): a revision may be acknowledged only AFTER its
// local transaction committed with import_status='imported'. The WHERE clause
// makes early acknowledgement structurally impossible.
export async function markRevisionAcknowledged(
  db: Sql | TransactionSql,
  revisionId: string,
): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    UPDATE guesthub.channel_booking_revisions SET
      ack_status = 'acknowledged', acknowledged_at = now()
    WHERE id = ${revisionId}
      AND import_status = 'imported'
      AND ack_status = 'unacknowledged'
    RETURNING id`;
  return rows.length > 0;
}
