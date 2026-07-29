-- ============================================================
--  063 — the length-of-stay discount mechanism is removed
--
--  The LOS tiers (057, D104/D105) are replaced by automatic rate-plan
--  selection by stay length inside the pricing engine: a stay's discount is
--  the PLAN it becomes eligible for (e.g. a monthly plan), not a second
--  arithmetic layer stacked on top. The table, its settings and its UI go
--  together; the manual discount field on the booking panel stays (an
--  operator override for exceptions, not an automatic rule).
--
--  Committed reservations are untouched: their totals are STORED values
--  (reservations.total_price / discount_amount, D106) and are never
--  recomputed. A pricing_snapshot that recorded a historical `los` entry
--  remains a faithful record of how that price was produced at the time.
--
--  Idempotent. Safe to replay.
-- ============================================================
SET search_path TO "guesthub", public;

DROP TABLE IF EXISTS guesthub.length_of_stay_discounts;
