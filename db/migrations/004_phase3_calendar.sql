-- ============================================================
--  004 · Phase 3 — occupancy-calendar core
--  Additive + idempotent. Never edits an applied migration.
--
--  Run:
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/004_phase3_calendar.sql
--
--  Contents:
--   1. reservation_rooms — per-room guest fields (locked per-room
--      reservation model; the parent reservation keeps derived
--      aggregates only. DECISIONS D33).
--   2. room_closures — temporary date-range closures ("סגור חדר").
--      A closure is NOT rooms.status (permanent) and NOT a fake
--      "blocked" reservation. DECISIONS D31.
--   3. inventory_blocking_statuses() — the single source of truth for
--      which reservation statuses consume inventory (overview §8).
--   4. check_room_availability() — the single server-side availability
--      check: room sellability + blocking reservations + closures,
--      with the canonical half-open overlap rule
--      (existing.check_in < new.check_out AND existing.check_out > new.check_in).
--   5. Range indexes for the bounded calendar read model.
-- ============================================================

-- ---- 1. per-room guest fields ----
ALTER TABLE guesthub.reservation_rooms
  ADD COLUMN IF NOT EXISTS guest_first_name text,
  ADD COLUMN IF NOT EXISTS guest_last_name  text,
  ADD COLUMN IF NOT EXISTS guest_phone      text,
  ADD COLUMN IF NOT EXISTS guest_email      text,
  ADD COLUMN IF NOT EXISTS guest_id_number  text;

-- ---- 2. room_closures ----
CREATE TABLE IF NOT EXISTS guesthub.room_closures (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE CASCADE,
  -- start inclusive, end exclusive — same hotel-night semantics as stays
  start_date date NOT NULL,
  end_date   date NOT NULL,
  reason     text,
  notes      text,
  created_by uuid REFERENCES guesthub.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);

CREATE INDEX IF NOT EXISTS idx_closures_tenant_dates
  ON guesthub.room_closures (tenant_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_closures_room_dates
  ON guesthub.room_closures (room_id, start_date, end_date);

-- updated_at trigger (same pattern as 000)
DROP TRIGGER IF EXISTS trg_room_closures_updated_at ON guesthub.room_closures;
CREATE TRIGGER trg_room_closures_updated_at BEFORE UPDATE ON guesthub.room_closures
  FOR EACH ROW EXECUTE FUNCTION guesthub.set_updated_at();

-- ---- 3. blocking statuses — single source (overview §8) ----
-- cancelled / draft / checked_out / no_show do NOT consume inventory.
-- The TS mirror (src/lib/inventory.ts) is asserted equal by scripts/check-inventory.mjs.
CREATE OR REPLACE FUNCTION guesthub.inventory_blocking_statuses()
RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['confirmed','checked_in','blocked'] $$;

-- ---- 4. the single availability check ----
-- Returns one row per conflict; zero rows ⇔ every requested room is free
-- and sellable for [p_check_in, p_check_out). p_exclude_rr lets an edit
-- ignore the reservation_rooms rows it is about to rewrite (never a whole
-- reservation — sibling rooms of the same reservation must still conflict).
-- Callers that WRITE must first lock the room rows (SELECT … FOR UPDATE)
-- in the same transaction so two concurrent writers serialize. D34.
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
  -- permanently unsellable room (inactive / out_of_order / maintenance / legacy ≠ available)
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
    AND c.start_date < p_check_out AND c.end_date > p_check_in
$$;

-- ---- 5. read-model indexes ----
-- tenant + visible-range intersection (the calendar's main query)
CREATE INDEX IF NOT EXISTS idx_res_rooms_tenant_dates
  ON guesthub.reservation_rooms (tenant_id, check_in, check_out);
-- rates by tenant + date window (empty-cell price/min-nights strip)
CREATE INDEX IF NOT EXISTS idx_rates_tenant_date
  ON guesthub.rates (tenant_id, date);

-- grants follow the 000 pattern (owner postgres; service_role for admin tools)
GRANT ALL ON guesthub.room_closures TO service_role;
REVOKE ALL ON guesthub.room_closures FROM anon, authenticated;
