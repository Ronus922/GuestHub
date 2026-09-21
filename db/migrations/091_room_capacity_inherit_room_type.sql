-- ============================================================
--  091 — rooms.max_* capacity columns become nullable (Phase 5 owner decision)
--
--  WHY. The BIOS Bot connector audit found a live discrepancy: the documented
--  rule "a room's capacity falls back to its room type when unset" was only
--  ever implemented in getRoomCapacities() (src/lib/inventory.ts) — a
--  function with ZERO call sites. The actually-enforced path (the pricing
--  engine, src/lib/pricing/engine.ts) read max_occupancy/max_adults/
--  max_children/max_infants straight off guesthub.rooms, with no fallback.
--  That was invisible in practice only because these four columns were
--  `NOT NULL DEFAULT ...`, so a room could never actually be missing a value
--  to fall back FROM.
--
--  THE RULE (owner decision, unchanged by this migration — only now
--  mechanically possible): COALESCE(room.field, room_type.field) per column,
--  independently, for max_occupancy / max_adults / max_children / max_infants.
--  ZERO IS A REAL VALUE — e.g. room.max_infants = 0 means "no infants" and
--  must NOT fall back to the room type. Only NULL means "inherit."
--
--  SCOPE. This migration only relaxes the constraint so NULL becomes a legal,
--  meaningful room-level value. It does NOT touch any existing room's data —
--  every room keeps its current explicit number (still "room value present"),
--  and it does NOT touch guesthub.room_types, which remains the NOT NULL
--  backstop layer. The dashboard Room wizard (src/lib/validation/rooms.ts)
--  still requires an explicit number on every save — this migration does not
--  change that UI; it only makes the inherited-from-room-type path reachable
--  (by future integrations, imports, or a later UI change) and makes it the
--  one rule the pricing engine and the dashboard room picker both enforce.
--  See src/lib/inventory.ts getRoomCapacities() for the single implementation.
--
--  CHECK constraints mirror the existing Zod bounds (validation/rooms.ts):
--  max_occupancy >= 1 when present (a room that exists is sellable to at
--  least one guest); the other three >= 0 when present (0 is a real cap).
--
--  Idempotent. Safe to replay: DROP NOT NULL / DROP DEFAULT are no-ops on an
--  already-nullable/already-default-less column, and the CHECK constraints
--  are dropped and re-added.
--
--  ROLLBACK (only safe if no room row has NULL in any of the four columns —
--  verify with the SELECT below first):
--    SELECT count(*) FROM guesthub.rooms
--      WHERE max_occupancy IS NULL OR max_adults IS NULL
--         OR max_children IS NULL OR max_infants IS NULL;
--    ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_occupancy_chk;
--    ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_adults_chk;
--    ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_children_chk;
--    ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_infants_chk;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_occupancy SET DEFAULT 2;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_adults    SET DEFAULT 2;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_children  SET DEFAULT 0;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_infants   SET DEFAULT 0;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_occupancy SET NOT NULL;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_adults    SET NOT NULL;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_children  SET NOT NULL;
--    ALTER TABLE guesthub.rooms ALTER COLUMN max_infants   SET NOT NULL;
-- ============================================================
SET search_path TO "guesthub", public;

ALTER TABLE guesthub.rooms
  ALTER COLUMN max_occupancy DROP DEFAULT,
  ALTER COLUMN max_adults    DROP DEFAULT,
  ALTER COLUMN max_children  DROP DEFAULT,
  ALTER COLUMN max_infants   DROP DEFAULT,
  ALTER COLUMN max_occupancy DROP NOT NULL,
  ALTER COLUMN max_adults    DROP NOT NULL,
  ALTER COLUMN max_children  DROP NOT NULL,
  ALTER COLUMN max_infants   DROP NOT NULL;

ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_occupancy_chk;
ALTER TABLE guesthub.rooms ADD CONSTRAINT rooms_max_occupancy_chk
  CHECK (max_occupancy IS NULL OR max_occupancy >= 1);

ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_adults_chk;
ALTER TABLE guesthub.rooms ADD CONSTRAINT rooms_max_adults_chk
  CHECK (max_adults IS NULL OR max_adults >= 0);

ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_children_chk;
ALTER TABLE guesthub.rooms ADD CONSTRAINT rooms_max_children_chk
  CHECK (max_children IS NULL OR max_children >= 0);

ALTER TABLE guesthub.rooms DROP CONSTRAINT IF EXISTS rooms_max_infants_chk;
ALTER TABLE guesthub.rooms ADD CONSTRAINT rooms_max_infants_chk
  CHECK (max_infants IS NULL OR max_infants >= 0);
