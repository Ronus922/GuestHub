-- ============================================================
--  056 — מקור הזמנה "מהמערכת" (key = system).
--
--  A reservation the SYSTEM created inside GuestHub — not a channel import and
--  not an operator typing a walk-in. It needs its own booking source so the
--  reservations list, the calendar popover and the source filter can say
--  "מהמערכת" instead of falling back to an empty source.
--
--  The dropdown is DB-driven: every source option on /reservations, /calendar
--  and the booking panels comes from lookup_items(category='booking_sources')
--  (see src/app/(dashboard)/reservations/page.tsx). Seeding the row here IS the
--  feature — no hardcoded option list exists to extend.
--
--  NOT an external channel. src/lib/colors.ts::normalizeVisibleChannel maps
--  only booking_com/booking/airbnb/expedia/direct/site/website to a visible
--  channel; 'system' hits the `default: return null` branch, so
--  resolveChannelBadge('system') = 'manual' and EditReservationPanel's
--  `externalReservation` stays FALSE — the reservation's fields remain
--  editable. Do NOT add 'system' to that switch.
--  Locked by scripts/check-reservation-source-system.mjs.
--
--  sort_order = the tenant's current MAX + 1, so the new option lands at the
--  END of that tenant's existing list and no existing row is renumbered.
--
--  Seeded ONLY for tenants that already own booking_sources rows: a tenant with
--  no source catalogue at all is not silently given a one-item one.
--
--  Idempotent (ON CONFLICT DO NOTHING on the (tenant_id, category, key) unique
--  constraint). Inserts only — never deletes, never updates an existing row.
--    docker exec -i supabase-db psql -U supabase_admin -d postgres \
--      < db/migrations/056_source_system.sql
-- ============================================================
BEGIN;

INSERT INTO guesthub.lookup_items
  (tenant_id, category, key, label, icon, color, sort_order, is_active)
SELECT s.tenant_id, 'booking_sources', 'system', 'מהמערכת', 'edit_note', '#7C3AED',
       MAX(s.sort_order) + 1, true
FROM guesthub.lookup_items s
WHERE s.category = 'booking_sources'
GROUP BY s.tenant_id
ON CONFLICT (tenant_id, category, key) DO NOTHING;

COMMIT;
