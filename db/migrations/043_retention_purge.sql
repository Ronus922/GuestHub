-- ============================================================
--  GuestHub · Stage 6 — data-retention purge functions (defects H8, H11).
--
--  H8 (PCI scope reduction): a stored card PAN is only needed until shortly after
--  the stay. purge_expired_cards() deletes reservation_cards whose reservation
--  checked out (or was cancelled) more than N days ago — shrinking the window in
--  which any PAN ciphertext exists at rest. last4/brand/exp are card metadata, not
--  PAN, and go with the row (the reservation keeps its own history).
--
--  H11 (log growth): purge_channel_sync_errors() deletes resolved errors older
--  than N days and unresolved errors older than a longer horizon, so the
--  quarantine/error log cannot grow without bound.
--
--  Both are STRICT, tenant-agnostic maintenance functions run by an operator/timer
--  (scripts/ops/guesthub-purge.mjs). Idempotent; return the number of rows purged.
--  Safe to replay from zero.
-- ============================================================
SET search_path TO "guesthub", public;

-- H8 — purge PAN ciphertext for stays that ended more than p_days ago.
CREATE OR REPLACE FUNCTION guesthub.purge_expired_cards(p_days int DEFAULT 90)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH doomed AS (
    SELECT c.id
    FROM guesthub.reservation_cards c
    JOIN guesthub.reservations r ON r.id = c.reservation_id AND r.tenant_id = c.tenant_id
    WHERE (r.status = 'cancelled' AND r.updated_at < now() - make_interval(days => p_days))
       OR (r.check_out < (current_date - p_days))
  )
  DELETE FROM guesthub.reservation_cards c USING doomed d WHERE c.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- H11 — purge old sync errors: resolved after p_resolved_days, unresolved after
-- p_unresolved_days (a longer horizon so live problems stay visible).
CREATE OR REPLACE FUNCTION guesthub.purge_channel_sync_errors(
  p_resolved_days int DEFAULT 30,
  p_unresolved_days int DEFAULT 180
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM guesthub.channel_sync_errors
  WHERE (resolved_at IS NOT NULL AND resolved_at < now() - make_interval(days => p_resolved_days))
     OR (resolved_at IS NULL AND created_at < now() - make_interval(days => p_unresolved_days));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
