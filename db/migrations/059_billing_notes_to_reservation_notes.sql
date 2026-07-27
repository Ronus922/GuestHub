-- ============================================================
--  059 · D109 — הערות חיוב עוברות להערות ההזמנה
--
--  The billing-note belonged to the CARD row (reservation_cards.billing_notes):
--  it vanished with the card, and could not exist without one. Ronen's flow
--  (complaint 9) treats it as a reservation note. This migration moves the
--  existing content into reservations.notes with a "[הערת חיוב] " prefix and
--  clears the source. The column itself STAYS (deprecated, no UI writer left)
--  — dropping it is a separate release after the move is verified (D109).
--
--  SECURITY (PCI-DSS Req. 3.2): a production billing-note was found carrying a
--  pasted channel-payload block INCLUDING a plaintext CVV. A CVV must never
--  live outside the vault (card-vault.ts), so any "Cvv: NNN"-shaped fragment
--  is REDACTED in transit — the operator keys a real CVV into the card fields
--  (D87), where it is encrypted.
--
--  Idempotent: the position() guard skips rows whose note already carries the
--  exact migrated text, and pass 2 empties the source so a re-run is a no-op.
--  At audit time 2 of 12 stored cards carried a note (docs/PRICING_AUDIT.md §10).
-- ============================================================
SET search_path TO "guesthub", public;

UPDATE guesthub.reservations res
SET notes = CASE
      WHEN res.notes IS NULL OR btrim(res.notes) = ''
        THEN '[הערת חיוב] ' || regexp_replace(btrim(c.billing_notes), '(?i)(cvv|cvc|cvv2)\s*:?\s*[0-9]{3,4}', '\1: [הוסר]', 'g')
      ELSE res.notes || E'\n' || '[הערת חיוב] ' || regexp_replace(btrim(c.billing_notes), '(?i)(cvv|cvc|cvv2)\s*:?\s*[0-9]{3,4}', '\1: [הוסר]', 'g')
    END,
    updated_at = now()
FROM guesthub.reservation_cards c
WHERE c.reservation_id = res.id
  AND c.tenant_id = res.tenant_id
  AND c.billing_notes IS NOT NULL
  AND btrim(c.billing_notes) <> ''
  AND (res.notes IS NULL
       OR position('[הערת חיוב] ' || regexp_replace(btrim(c.billing_notes), '(?i)(cvv|cvc|cvv2)\s*:?\s*[0-9]{3,4}', '\1: [הוסר]', 'g') IN res.notes) = 0);

UPDATE guesthub.reservation_cards
SET billing_notes = NULL, updated_at = now()
WHERE billing_notes IS NOT NULL;
