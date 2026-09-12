-- ============================================================
--  090 — bulk_rate_update_items: restriction before/after (D187)
--
--  WHY. A Group Update audited only old_price/new_price. The 2026-09-06
--  min-stay run therefore left 32 rows whose two price columns were equal —
--  reading as "nothing happened" — while every night's min_stay_through had
--  changed. The audit must record what the operator changed, not only price.
--
--  SEMANTICS. old_restrictions / new_restrictions hold the SIX restriction
--  fields of guesthub.pricing_plan_rates as stored, for the (plan, date) the
--  item describes: {min_stay_through, min_stay_arrival, max_stay,
--  closed_to_arrival, closed_to_departure, stop_sell}. old_restrictions is
--  NULL when no row existed before the write (the same meaning old_price
--  NULL already has). The price columns are unchanged.
--
--  No backfill: the history before this migration did not record
--  restrictions, and inventing them would be fabrication. Legacy rows keep
--  NULL in both columns.
--
--  Idempotent. Safe to replay.
--
--  ROLLBACK:
--    ALTER TABLE guesthub.bulk_rate_update_items
--      DROP COLUMN IF EXISTS old_restrictions, DROP COLUMN IF EXISTS new_restrictions;
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.bulk_rate_update_items
  ADD COLUMN IF NOT EXISTS old_restrictions jsonb,
  ADD COLUMN IF NOT EXISTS new_restrictions jsonb;
