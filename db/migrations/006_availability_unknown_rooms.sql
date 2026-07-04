-- ============================================================
--  006 · Phase 3 — availability hardening
--  check_room_availability now reports a requested room id that does NOT
--  belong to the tenant (or does not exist) as a 'room_missing' conflict,
--  instead of silently returning no rows for it. Write paths were already
--  safe via lockRooms (which throws), but the function itself must not be
--  usable as a cross-tenant "looks available" oracle. Additive: replaces
--  the function only (004 is applied and stays untouched).
-- ============================================================

CREATE OR REPLACE FUNCTION guesthub.check_room_availability(
  p_tenant     uuid,
  p_room_ids   uuid[],
  p_check_in   date,
  p_check_out  date,
  p_exclude_rr uuid[] DEFAULT ARRAY[]::uuid[]
) RETURNS TABLE (
  room_id       uuid,
  conflict_kind text,   -- 'room_missing' | 'room_status' | 'reservation' | 'closure'
  conflict_id   uuid,
  conflict_from date,
  conflict_to   date
) LANGUAGE sql STABLE AS $$
  -- requested room that is not this tenant's room at all
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
$$;
