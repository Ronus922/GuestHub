-- ============================================================
-- 032 — Inbound rate-plan aliases (additive, idempotent)
--
-- WHY: bookings arrive from a channel (Booking.com via Channex) carrying the
-- rate_plan UUID the OWNER mapped in the Channex UI. That mapping can point at
-- rate-plan objects GuestHub never created (UI-made copies, later even deleted
-- upstream) instead of the canonical per-room plans in
-- channel_room_rate_mappings. Those canonical rows are OUTBOUND-critical (ARI
-- pushes go to their UUIDs) and must never be overwritten by an inbound alias.
--
-- This table records EXTRA inbound identifiers only, each adopted after a
-- live, UUID-verified Channex lookup (property + room type chain). One
-- external UUID can alias exactly one physical room per connection.
-- local_rate_plan_id is OPTIONAL: it is set only when the verified upstream
-- plan disambiguates to exactly one canonical mapping of the SAME room —
-- never claimed by title across rooms.
-- ============================================================

CREATE TABLE IF NOT EXISTS guesthub.channel_inbound_rate_plan_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guesthub.tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES guesthub.channel_connections(id) ON DELETE CASCADE,
  -- the exact external UUID bookings arrive with
  channex_rate_plan_id text NOT NULL,
  -- the physical room proven by the UUID chain (plan.room_type -> room mapping)
  room_id uuid NOT NULL REFERENCES guesthub.rooms(id) ON DELETE CASCADE,
  -- optional canonical plan association (evidence-gated, may stay NULL)
  local_rate_plan_id uuid REFERENCES guesthub.pricing_plans(id) ON DELETE SET NULL,
  -- the verified upstream facts at adoption time (audit trail)
  channex_property_id text NOT NULL,
  channex_room_type_id text NOT NULL,
  channex_title text,
  source text NOT NULL DEFAULT 'channex_verified'
    CHECK (source IN ('channex_verified')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- one alias per external UUID per connection — the adoption uniqueness rule
  CONSTRAINT uq_inbound_rp_alias UNIQUE (connection_id, channex_rate_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_rp_alias_room
  ON guesthub.channel_inbound_rate_plan_aliases (connection_id, room_id);
