-- ============================================================
--  082 — D144 DECIDED: future tables are born writable; two frozen
--        exceptions stay locked (the ledger, the audit trail)
--
--  THE DECISION (Ronen, 2026-08-08, closing D144): option (א) — widen
--  supabase_admin's DEFAULT PRIVILEGES in schema guesthub to full app
--  write. Every table in this schema is created FOR this application and
--  the schema has no second writing role; a model that demands a manual
--  GRANT in every migration adds a duty of memory that WILL be forgotten
--  (076→077 proved it, booking_channel_reports was the second live case),
--  and the failure surfaces only in production. Two places MUST stay
--  outside the widening, because the ability to delete them is the
--  ability to delete evidence:
--    · guesthub.schema_migrations — the ledger stays SELECT-only (080's
--      decree). The app never writes the record of what ran, in any state.
--    · the audit trail — DELETE revoked, INSERT kept (the app writes
--      audit rows; an audit log the app can delete is not an audit log).
--      The audit CLASS in this schema is three tables: audit_logs (the
--      who/what/before/after record, 000 §6.16) and bulk_rate_update_logs
--      + bulk_rate_update_items (the who/when/params record of bulk rate
--      changes, 000 §6.17 — same evidentiary role, and the app only ever
--      INSERTs into all three; measured 2026-08-08: no app code path
--      UPDATEs or DELETEs any of them).
--
--  postgres's own defaults are DELIBERATELY untouched — the historical
--  postgres/supabase_admin split stays documented in D136/D144. After this
--  migration the two branches CONVERGE for tables (both arwdDxt for
--  guesthub_app, minus the two exceptions); for sequences they nearly
--  converge (postgres grants rwU, this grants rU — no setval, nothing
--  needs it).
--
--  The blanket grants on EXISTING relations are replay convergence, same
--  role as 080's: production tables already carry full write from the
--  postgres-era default ACL (D144 measured exactly 2 without INSERT), so
--  in production they are no-ops — except booking_channel_reports, which
--  gains UPDATE/DELETE (081's minimalism was scoped to "while D144 is
--  open", and D144 is now closed the wide way). On a replay-from-zero
--  they are what closes the write gap for tables born under
--  supabase_admin's read-only default.
--
--  KNOWN LIMIT (recorded, accepted): "ON TABLES" in a default-privilege
--  grant covers future views too. No view exists in guesthub today
--  (check:grants counts pg_views and asserts matviews=0), but a future
--  auto-updatable view over an audit table would bypass the DELETE
--  revoke via the view owner's rights — the migration creating the first
--  view must REVOKE write on it explicitly.
--
--  Idempotent: GRANT / REVOKE / ALTER DEFAULT PRIVILEGES all re-apply as
--  no-ops.
--
--  ROLLBACK (manual):
--    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA guesthub
--      REVOKE INSERT, UPDATE, DELETE ON TABLES FROM guesthub_app;
--    ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA guesthub
--      REVOKE USAGE, SELECT ON SEQUENCES FROM guesthub_app;
--    REVOKE UPDATE, DELETE ON guesthub.booking_channel_reports
--      FROM guesthub_app;
--    (the blanket write grant is a no-op to roll back in production —
--     every other table already carried it; the two exception REVOKEs
--     need no rollback: they restate 080's ledger decree and remove a
--     DELETE the app never used)
-- ============================================================

SET search_path TO "guesthub", public;

-- 1. replay convergence for existing relations (production: no-ops, except
--    booking_channel_reports gaining UPDATE/DELETE under the closed D144)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA guesthub TO guesthub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA guesthub TO guesthub_app;

-- 2. the decision: relations supabase_admin creates in guesthub from now on
--    are born app-writable, their sequences born usable
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA guesthub
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO guesthub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA guesthub
  GRANT USAGE, SELECT ON SEQUENCES TO guesthub_app;

-- 3. exception 1 — the ledger: SELECT-only, never app-writable (080's
--    decree, restated here so the blanket above cannot unfreeze it)
REVOKE INSERT, UPDATE, DELETE ON guesthub.schema_migrations FROM guesthub_app;

-- 4. exception 2 — the audit class: the app writes evidence, it never
--    erases evidence (INSERT stays, DELETE goes)
REVOKE DELETE ON guesthub.audit_logs             FROM guesthub_app;
REVOKE DELETE ON guesthub.bulk_rate_update_logs  FROM guesthub_app;
REVOKE DELETE ON guesthub.bulk_rate_update_items FROM guesthub_app;
