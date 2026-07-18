-- ============================================================
--  GuestHub · Stage 5 — Maintenance foundation: typed room closures (§10).
--
--  A room_closure until now carried only a free-text reason and ALWAYS removed
--  the room from availability. Maintenance needs two distinct kinds:
--    · out_of_order  (OOO) — room is genuinely unusable; removed from sellable
--                            inventory AND synced stop-sold to channels.
--    · out_of_service (OOS) — a soft maintenance flag (e.g. "dirty but sellable",
--                            cosmetic fix pending); the room STAYS sellable, so
--                            it does NOT reduce availability and does NOT sync.
--
--  category types the maintenance reason for reporting (plumbing/electrical/…).
--
--  Existing rows default to out_of_order — that preserves today's behaviour
--  exactly (every existing closure already blocks). Only the availability
--  function changes: it now blocks on OOO closures only.
--
--  Idempotent. Safe to replay from zero. No data deleted.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.room_closures
  ADD COLUMN IF NOT EXISTS closure_type text NOT NULL DEFAULT 'out_of_order',
  ADD COLUMN IF NOT EXISTS category     text;

DO $$ BEGIN
  ALTER TABLE guesthub.room_closures
    ADD CONSTRAINT room_closures_type_check
    CHECK (closure_type IN ('out_of_order','out_of_service'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN guesthub.room_closures.closure_type IS
  '§10 maintenance: out_of_order removes availability + syncs; out_of_service stays sellable.';
COMMENT ON COLUMN guesthub.room_closures.category IS
  '§10 maintenance category for reporting (plumbing/electrical/deep_clean/renovation/other).';

-- Availability now honours only out_of_order closures (OOS keeps the room
-- sellable). Everything else in the function is unchanged from migration 004.
CREATE OR REPLACE FUNCTION guesthub.check_room_availability(
  p_tenant     uuid,
  p_room_ids   uuid[],
  p_check_in   date,
  p_check_out  date,
  p_exclude_rr uuid[] DEFAULT ARRAY[]::uuid[]
) RETURNS TABLE (
  room_id       uuid,
  conflict_kind text,   -- 'room_status' | 'reservation' | 'closure'
  conflict_id   uuid,
  conflict_from date,
  conflict_to   date
) LANGUAGE sql STABLE AS $$
  SELECT r.id, 'room_status'::text, r.id, NULL::date, NULL::date
  FROM guesthub.rooms r
  WHERE r.id = ANY (p_room_ids)
    AND r.tenant_id = p_tenant
    AND (r.status <> 'available' OR r.is_active = false)

  UNION ALL

  SELECT rr.room_id, 'reservation'::text, rr.id, rr.check_in, rr.check_out
  FROM guesthub.reservation_rooms rr
  JOIN guesthub.reservations res ON res.id = rr.reservation_id
  WHERE rr.tenant_id = p_tenant
    AND rr.room_id = ANY (p_room_ids)
    AND rr.check_in < p_check_out AND rr.check_out > p_check_in
    AND res.status = ANY (guesthub.inventory_blocking_statuses())
    AND NOT (rr.id = ANY (p_exclude_rr))

  UNION ALL

  SELECT c.room_id, 'closure'::text, c.id, c.start_date, c.end_date
  FROM guesthub.room_closures c
  WHERE c.tenant_id = p_tenant
    AND c.room_id = ANY (p_room_ids)
    AND c.closure_type = 'out_of_order'    -- OOS stays sellable (§10)
    AND c.start_date < p_check_out AND c.end_date > p_check_in
$$;
