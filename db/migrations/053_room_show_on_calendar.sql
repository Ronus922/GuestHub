-- 053 — per-room calendar visibility (owner request 2026-07-24): the rooms
-- wizard's "סדר מיון" stepper is replaced by a "מוצג בלוח תפוסה" toggle.
-- OFF hides the room from the calendar grid (יומן חדרים) ONLY — the room
-- stays bookable, sellable and counted in occupancy; this is display, not
-- inventory. Default true: every existing and future room is visible.
-- rooms.sort_order stays in the schema (values preserved), it just lost its
-- wizard control.

ALTER TABLE guesthub.rooms
  ADD COLUMN IF NOT EXISTS show_on_calendar boolean NOT NULL DEFAULT true;
