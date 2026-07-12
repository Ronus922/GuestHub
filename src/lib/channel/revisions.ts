import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { extractChannelCard, maskedCardLast4, redactPayload } from "./payloads";
import { encryptPan, CARD_KEY_VERSION, cardVaultConfigured } from "../card-vault";
import { detectBrand, normalizePan, panValid } from "../card-rules";

// ============================================================
// Inbound booking-revision foundation (§X) + operational channel-card capture
// (§Z reconciliation, D43/D52). persistBookingRevision is the concrete seam
// where a full inbound booking payload is handled: it EXTRACTS + ENCRYPTS the
// PAN from the RAW payload BEFORE the payload is redacted, staging the ciphertext
// on the revision row. The CVV is NEVER staged or stored (D52 §2) — any CVV in
// the payload is discarded. The stored `payload` column stays redacted — raw
// card data never lands in it or in any log. markRevisionImported then MOVES the
// staged encrypted PAN into reservation_cards once a local reservation exists.
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

// Non-sensitive metadata staged alongside the encrypted PAN. NEVER holds a
// plaintext PAN, and never a CVV in any form (D52 §2).
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
  // D76 §8 — true when the channel supplied only a MASKED guarantee (the normal
  // Channex endpoint): no PAN exists anywhere, only display metadata below.
  masked_only?: boolean;
  masked_display?: string | null;
};

// Extract + encrypt ONLY the PAN from a raw payload (the CVV, if any, is
// discarded — D52 §2). Returns the encrypted PAN and the non-sensitive meta, or
// nulls when there is no usable card.
//
// D76 §8: the normal Channex endpoint supplies a MASKED guarantee
// ("375516*****1144"). That is not a PAN and is never encrypted or placed in
// any PAN field — instead the allowed metadata (brand, derived last4, expiry,
// holder, virtual flag, masked display) is staged WITHOUT a ciphertext, so it
// stays on the revision row only (attachStagedCard requires a ciphertext).
function stageCard(rev: RevisionInput): {
  panEnc: string | null;
  meta: StagedCardMeta | null;
} {
  const card = extractChannelCard(rev.payload);
  if (!card || card.expMonth === null || card.expYear === null) {
    return { panEnc: null, meta: null };
  }
  const shared = {
    holder_name: card.holderName,
    exp_month: card.expMonth,
    exp_year: card.expYear,
    is_virtual: card.isVirtual,
    source_channel: rev.otaName ?? null,
    provider_reservation_ref: rev.otaReservationCode ?? null,
    available_from: card.availableFrom,
    available_until: card.availableUntil,
    key_version: CARD_KEY_VERSION,
  };
  const pan = normalizePan(card.pan ?? "");
  if (panValid(pan)) {
    if (!cardVaultConfigured()) return { panEnc: null, meta: null };
    return {
      panEnc: encryptPan(pan),
      meta: { ...shared, brand: card.brand ?? detectBrand(pan), last4: pan.slice(-4) },
    };
  }
  const maskedLast4 = maskedCardLast4(card.pan);
  if (!maskedLast4) return { panEnc: null, meta: null };
  return {
    panEnc: null,
    meta: {
      ...shared,
      brand: card.brand,
      last4: maskedLast4,
      masked_only: true,
      masked_display: card.pan,
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
  const { panEnc, meta } = stageCard(rev);
  const rows = await db<{ id: string }[]>`
    INSERT INTO guesthub.channel_booking_revisions
      (tenant_id, connection_id, provider_booking_id, provider_revision_id,
       unique_id, system_id, ota_reservation_code, ota_name,
       revision_kind, raw_status, payload,
       card_pan_encrypted, card_meta)
    VALUES
      (${rev.tenantId}, ${rev.connectionId}, ${rev.providerBookingId},
       ${rev.providerRevisionId}, ${rev.uniqueId ?? null}, ${rev.systemId ?? null},
       ${rev.otaReservationCode ?? null}, ${rev.otaName ?? null},
       ${rev.revisionKind}, ${rev.rawStatus ?? null},
       ${db.json(redactPayload(rev.payload) as never)},
       ${panEnc}, ${meta ? db.json(meta as never) : null})
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
  meta: StagedCardMeta,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO guesthub.reservation_cards
      (tenant_id, reservation_id, holder_name, pan_encrypted, key_version,
       brand, last4, exp_month, exp_year, source, source_channel,
       provider_reservation_ref, is_virtual, available_from, available_until, received_at)
    VALUES
      (${tenantId}, ${reservationId}, ${meta.holder_name || "כרטיס ערוץ"}, ${panEnc},
       ${meta.key_version}, ${meta.brand}, ${meta.last4}, ${meta.exp_month}, ${meta.exp_year},
       'channel', ${meta.source_channel}, ${meta.provider_reservation_ref}, ${meta.is_virtual},
       ${meta.available_from}, ${meta.available_until}, now())
    ON CONFLICT (reservation_id) DO UPDATE SET
      holder_name = COALESCE(NULLIF(EXCLUDED.holder_name, ''), guesthub.reservation_cards.holder_name),
      pan_encrypted = EXCLUDED.pan_encrypted,
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
            } as never)},
            ${`channel:${meta.source_channel ?? "unknown"}`})`;
}

// A transient import failure (DB error, crash mid-import): recorded visibly,
// retried by the next pull — the revision stays unacknowledged upstream.
export async function markRevisionFailed(
  db: Sql | TransactionSql,
  revisionId: string,
  error: string,
): Promise<void> {
  await db`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'failed', mapping_error = ${error},
      attempts = attempts + 1
    WHERE id = ${revisionId}`;
}

// Mark imported — call ONLY inside the transaction that created the local
// reservation/inventory hold, so "imported" implies durably saved. When a local
// reservation exists and the revision staged a card, the card is attached to it.
// attachCard=false is for a STALE revision recorded as processed without
// applying anything — its card must not overwrite a newer one.
export async function markRevisionImported(
  tx: TransactionSql,
  tenantId: string,
  revisionId: string,
  localReservationId: string | null,
  attachCard = true,
): Promise<void> {
  const [rev] = await tx<
    {
      card_pan_encrypted: string | null;
      card_meta: StagedCardMeta | null;
    }[]
  >`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'imported', local_reservation_id = ${localReservationId},
      mapping_error = NULL
    WHERE id = ${revisionId}
    RETURNING card_pan_encrypted, card_meta`;
  if (attachCard && localReservationId && rev?.card_pan_encrypted && rev.card_meta) {
    await attachStagedCard(
      tx,
      tenantId,
      localReservationId,
      rev.card_pan_encrypted,
      rev.card_meta,
    );
  }
}

// HELD for operator approval (037): the revision is durably persisted and one
// pending review exists — but NOTHING was applied to the reservation. The
// entire revision (dates AND metadata AND card) applies only on approval,
// atomically; rejection applies none of it.
export async function markRevisionHeld(
  tx: TransactionSql,
  revisionId: string,
  localReservationId: string | null,
): Promise<void> {
  await tx`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'awaiting_approval', local_reservation_id = ${localReservationId},
      mapping_error = NULL
    WHERE id = ${revisionId}`;
}

// Operator rejection (037): terminal. The revision row stays as the durable
// record; duplicate delivery finds it and can never recreate the review.
export async function markRevisionRejected(
  db: Sql | TransactionSql,
  revisionId: string,
): Promise<void> {
  await db`
    UPDATE guesthub.channel_booking_revisions SET
      import_status = 'rejected'
    WHERE id = ${revisionId} AND import_status = 'awaiting_approval'`;
}

// Acknowledgement gate (§X): a revision may be acknowledged only AFTER its
// local transaction committed with import_status='imported' — or, since 037,
// 'awaiting_approval': the revision + its pending review are durably ours, so
// upstream ack loses nothing (the feed would expire it in ~30 min anyway).
// The WHERE clause makes early acknowledgement structurally impossible.
export async function markRevisionAcknowledged(
  db: Sql | TransactionSql,
  revisionId: string,
): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    UPDATE guesthub.channel_booking_revisions SET
      ack_status = 'acknowledged', acknowledged_at = now()
    WHERE id = ${revisionId}
      AND import_status IN ('imported', 'awaiting_approval')
      AND ack_status = 'unacknowledged'
    RETURNING id`;
  return rows.length > 0;
}
