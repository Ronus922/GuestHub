-- ============================================================
--  058 · D106/D107 — reservation totals V2: price modes, discount modes,
--  VAT toggle context, currency (הרחבת מודל הכסף לחלון הזמנה V2)
--
--  STRICTLY ADDITIVE. Every default reproduces the pre-058 behavior exactly,
--  and check:totals-parity proves the money columns of every existing
--  reservation are byte-identical before/after this migration on a restored
--  production copy. Nothing here is read until the code that ships with it.
--
--  reservations:
--    discount_mode / discount_value — the discount SOURCE OF TRUTH (D106).
--        discount_amount is kept as the RESOLVED-₪ cache the app always
--        writes alongside, so every existing reader (SQL, preview, BI,
--        parity dump) keeps working unchanged.
--    rooms_total_override — the OTA-sent reservation total (channel imports
--        only): sovereign over Σ reservation_rooms.price_total (H6).
--    exchange_rate — manual display snapshot to the tenant base currency for
--        a non-ILS reservation (D107); NULL for base-currency rows.
--    (tax_exempt, extra_charges, currency, discount_amount already exist.)
--
--  reservation_rooms:
--    price_mode — 'auto' | 'manual_night' | 'manual_total' (D106).
--        'manual_night' mirrors the legacy is_manual_rate flag, which is KEPT
--        and stays in sync (readers/scripts unbroken; deprecation later).
--    manual_total — the operator's exact stay total when price_mode =
--        'manual_total' (agora-exact; rate_per_night becomes display spread).
--
--  tenants.settings seeds (idempotent):
--    vat_rate = 18 where missing — numerically inert: the engine already
--        falls back to DEFAULT_VAT_RATE = 18 (docs/PRICING_AUDIT.md §5.ב);
--        after this the Settings screen edits a key that actually exists.
--    enabled_currencies = ["ILS"] where missing — the currency selector's
--        source of truth (D107).
--
--  discount_percent (dead since 000, zero readers/writers) is NOT dropped
--  here: it stays until a separate post-parity-window migration, so the
--  parity dump's column list is stable across this deploy (D106).
--
--  Idempotent.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.reservations
  ADD COLUMN IF NOT EXISTS discount_mode text NOT NULL DEFAULT 'amount_total',
  ADD COLUMN IF NOT EXISTS discount_value numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rooms_total_override numeric(12,2),
  ADD COLUMN IF NOT EXISTS exchange_rate numeric(14,6);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_discount_mode_check') THEN
    ALTER TABLE guesthub.reservations
      ADD CONSTRAINT reservations_discount_mode_check
      CHECK (discount_mode IN ('none', 'amount_per_night', 'percent_per_night', 'amount_total', 'percent_total'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_discount_value_check') THEN
    ALTER TABLE guesthub.reservations
      ADD CONSTRAINT reservations_discount_value_check CHECK (discount_value >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_rooms_total_override_check') THEN
    ALTER TABLE guesthub.reservations
      ADD CONSTRAINT reservations_rooms_total_override_check
      CHECK (rooms_total_override IS NULL OR rooms_total_override >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservations_exchange_rate_check') THEN
    ALTER TABLE guesthub.reservations
      ADD CONSTRAINT reservations_exchange_rate_check
      CHECK (exchange_rate IS NULL OR exchange_rate > 0);
  END IF;
END $$;

ALTER TABLE guesthub.reservation_rooms
  ADD COLUMN IF NOT EXISTS price_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS manual_total numeric(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_rooms_price_mode_check') THEN
    ALTER TABLE guesthub.reservation_rooms
      ADD CONSTRAINT reservation_rooms_price_mode_check
      CHECK (price_mode IN ('auto', 'manual_night', 'manual_total'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_rooms_manual_total_check') THEN
    ALTER TABLE guesthub.reservation_rooms
      ADD CONSTRAINT reservation_rooms_manual_total_check
      CHECK (manual_total IS NULL OR manual_total >= 0);
  END IF;
END $$;

-- ---- backfills (idempotent by WHERE; touch only the NEW columns) ----

-- legacy manual nightly overrides become price_mode='manual_night'
UPDATE guesthub.reservation_rooms
  SET price_mode = 'manual_night'
  WHERE is_manual_rate AND price_mode = 'auto';

-- existing ₪-per-reservation discounts become the source-of-truth pair
UPDATE guesthub.reservations
  SET discount_value = discount_amount
  WHERE discount_mode = 'amount_total' AND discount_value = 0 AND discount_amount <> 0;

-- OTA imports whose stored total cannot be reproduced from Σ room rows carry
-- an OTA-sent amount (H6) — reconstruct it so the new single-source arithmetic
-- keeps producing the exact stored total. Guarded to rows the zero floor never
-- clamped (total_price > 0 makes the reconstruction algebraically exact).
UPDATE guesthub.reservations res
  SET rooms_total_override = res.total_price + res.discount_amount - res.extra_charges
  WHERE res.booking_origin = 'ota'
    AND res.rooms_total_override IS NULL
    AND res.total_price > 0
    AND res.total_price + res.discount_amount - res.extra_charges
        <> (SELECT COALESCE(SUM(rr.price_total), 0)
            FROM guesthub.reservation_rooms rr
            WHERE rr.reservation_id = res.id AND rr.tenant_id = res.tenant_id);

-- ---- tenant settings seeds ----

UPDATE guesthub.tenants
  SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{vat_rate}', to_jsonb(18))
  WHERE settings->>'vat_rate' IS NULL;

UPDATE guesthub.tenants
  SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{enabled_currencies}', '["ILS"]'::jsonb)
  WHERE settings->'enabled_currencies' IS NULL;
