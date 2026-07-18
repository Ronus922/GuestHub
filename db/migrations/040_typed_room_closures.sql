-- ============================================================
--  GuestHub · Stage 5 — typed room closures (OOO vs OOS) + categories (§8).
--
--  room_closures previously had a free-text reason and every closure blocked
--  availability. The maintenance gap: distinguish
--    · OOO (out of order)  — removed from inventory; NOT sellable. (existing behaviour)
--    · OOS (out of service)— dirty / minor issue but STILL sellable before the
--                            next arrival; must NOT reduce availability.
--  and carry a closure category (a reason taxonomy) instead of only free text.
--
--  Availability is derived by three STABLE functions that read room_closures:
--  check_room_availability (booking conflict), sellable_unit_inventory (the ARI
--  + grid source) and room_type_inventory. All three are recreated here to count
--  ONLY kind='ooo' closures as blocking. Existing rows default to 'ooo', so
--  behaviour is unchanged for every closure created before this migration.
--
--  Idempotent. Safe to replay from zero. No data deleted.
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.room_closures
  ADD COLUMN IF NOT EXISTS kind     text NOT NULL DEFAULT 'ooo',
  ADD COLUMN IF NOT EXISTS category text;

DO $$ BEGIN
  ALTER TABLE guesthub.room_closures ADD CONSTRAINT room_closures_kind_check
    CHECK (kind IN ('ooo','oos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- only OOO closures are indexed for the hot availability path
CREATE INDEX IF NOT EXISTS idx_closures_ooo
  ON guesthub.room_closures (room_id, start_date, end_date) WHERE kind = 'ooo';

-- ---- 1. check_room_availability — only OOO closures conflict ----
CREATE OR REPLACE FUNCTION guesthub.check_room_availability(
  p_tenant     uuid,
  p_room_ids   uuid[],
  p_check_in   date,
  p_check_out  date,
  p_exclude_rr uuid[] DEFAULT ARRAY[]::uuid[]
) RETURNS TABLE (
  room_id       uuid,
  conflict_kind text,
  conflict_id   uuid,
  conflict_from date,
  conflict_to   date
) LANGUAGE sql STABLE AS $$
  SELECT req.id, 'room_missing'::text, req.id, NULL::date, NULL::date
  FROM unnest(p_room_ids) AS req(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM guesthub.rooms r
    WHERE r.id = req.id AND r.tenant_id = p_tenant)

  UNION ALL

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
    AND c.kind = 'ooo'   -- §8: OOS is dirty-but-sellable and never a conflict
$$;

-- ---- 2. sellable_unit_inventory — only OOO closures consume a room ----
CREATE OR REPLACE FUNCTION guesthub.sellable_unit_inventory(
  p_tenant uuid,
  p_from   date,
  p_to     date
) RETURNS TABLE (
  sellable_unit_id uuid,
  day              date,
  total_rooms      integer,
  sellable_rooms   integer,
  occupied_rooms   integer,
  closed_rooms     integer,
  availability     integer
) LANGUAGE sql STABLE AS $$
WITH days AS (
  SELECT d::date AS day FROM generate_series(p_from, (p_to - 1)::date, interval '1 day') d
),
m AS (
  SELECT sur.sellable_unit_id AS su, r.id AS room_id, r.status, r.is_active
  FROM guesthub.sellable_unit_rooms sur
  JOIN guesthub.rooms r ON r.id = sur.room_id
  WHERE sur.tenant_id = p_tenant
),
base AS (
  SELECT su,
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'available' AND is_active)::int AS sellable
  FROM m GROUP BY su
),
consumed AS (
  SELECT su, day,
         count(DISTINCT room_id)::int AS unavailable,
         count(DISTINCT room_id) FILTER (WHERE kind = 'occupied')::int AS occupied,
         count(DISTINCT room_id) FILTER (WHERE kind = 'closed')::int   AS closed
  FROM (
    SELECT m.su, d.day, rr.room_id, 'occupied'::text AS kind
    FROM guesthub.reservation_rooms rr
    JOIN guesthub.reservations res ON res.id = rr.reservation_id
    JOIN m ON m.room_id = rr.room_id AND m.status = 'available' AND m.is_active
    JOIN days d ON rr.check_in <= d.day AND rr.check_out > d.day
    WHERE rr.tenant_id = p_tenant
      AND res.status = ANY (guesthub.inventory_blocking_statuses())
    UNION ALL
    SELECT m.su, d.day, c.room_id, 'closed'::text
    FROM guesthub.room_closures c
    JOIN m ON m.room_id = c.room_id AND m.status = 'available' AND m.is_active
    JOIN days d ON c.start_date <= d.day AND c.end_date > d.day
    WHERE c.tenant_id = p_tenant
      AND c.kind = 'ooo'   -- §8: only OOO removes a room from inventory
  ) x
  GROUP BY su, day
)
SELECT b.su, d.day, b.total, b.sellable,
       COALESCE(c.occupied, 0), COALESCE(c.closed, 0),
       GREATEST(0, b.sellable - COALESCE(c.unavailable, 0))
FROM base b CROSS JOIN days d
LEFT JOIN consumed c ON c.su = b.su AND c.day = d.day
ORDER BY b.su, d.day
$$;

-- ---- 3. room_type_inventory — only OOO closures consume a room ----
CREATE OR REPLACE FUNCTION guesthub.room_type_inventory(
  p_tenant uuid,
  p_from   date,
  p_to     date
) RETURNS TABLE (
  room_type_id       uuid,
  day                date,
  total_rooms        integer,
  inactive_rooms     integer,
  out_of_order_rooms integer,
  sellable_rooms     integer,
  occupied_rooms     integer,
  closed_rooms       integer,
  hold_rooms         integer,
  availability       integer
) LANGUAGE sql STABLE AS $$
WITH days AS (
  SELECT d::date AS day FROM generate_series(p_from, (p_to - 1)::date, interval '1 day') d
),
r AS (
  SELECT id, rooms.room_type_id AS rt, status, is_active
  FROM guesthub.rooms
  WHERE tenant_id = p_tenant AND rooms.room_type_id IS NOT NULL
),
base AS (
  SELECT rt,
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'inactive' OR NOT is_active)::int AS inactive_ct,
         count(*) FILTER (WHERE status = 'out_of_order')::int              AS ooo_ct,
         count(*) FILTER (WHERE status = 'available' AND is_active)::int   AS sellable
  FROM r GROUP BY rt
),
consumed AS (
  SELECT rt, day,
         count(DISTINCT room_id)::int AS unavailable,
         count(DISTINCT room_id) FILTER (WHERE kind = 'occupied')::int AS occupied,
         count(DISTINCT room_id) FILTER (WHERE kind = 'closed')::int   AS closed
  FROM (
    SELECT r.rt, d.day, rr.room_id, 'occupied'::text AS kind
    FROM guesthub.reservation_rooms rr
    JOIN guesthub.reservations res ON res.id = rr.reservation_id
    JOIN r ON r.id = rr.room_id AND r.status = 'available' AND r.is_active
    JOIN days d ON rr.check_in <= d.day AND rr.check_out > d.day
    WHERE rr.tenant_id = p_tenant
      AND res.status = ANY (guesthub.inventory_blocking_statuses())
    UNION ALL
    SELECT r.rt, d.day, c.room_id, 'closed'::text
    FROM guesthub.room_closures c
    JOIN r ON r.id = c.room_id AND r.status = 'available' AND r.is_active
    JOIN days d ON c.start_date <= d.day AND c.end_date > d.day
    WHERE c.tenant_id = p_tenant
      AND c.kind = 'ooo'   -- §8: only OOO removes a room from inventory
  ) x
  GROUP BY rt, day
),
holds AS (
  SELECT h.room_type_id AS rt, d.day, sum(h.rooms_count)::int AS held
  FROM guesthub.channel_inventory_holds h
  JOIN days d ON h.check_in <= d.day AND h.check_out > d.day
  WHERE h.tenant_id = p_tenant AND h.status = 'active'
  GROUP BY 1, 2
)
SELECT b.rt,
       d.day,
       b.total,
       b.inactive_ct,
       b.ooo_ct,
       b.sellable,
       COALESCE(c.occupied, 0),
       COALESCE(c.closed, 0),
       COALESCE(h.held, 0),
       GREATEST(0, b.sellable - COALESCE(c.unavailable, 0) - COALESCE(h.held, 0))
FROM base b
CROSS JOIN days d
LEFT JOIN consumed c ON c.rt = b.rt AND c.day = d.day
LEFT JOIN holds h    ON h.rt = b.rt AND h.day = d.day
ORDER BY b.rt, d.day
$$;
