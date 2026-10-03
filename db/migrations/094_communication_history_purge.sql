-- ============================================================
--  094 · Communication history — paging index + "מחק היסטוריה" (D204)
--
--  1. outbound_messages_tenant_created_idx — the history list is now paged
--     server-side, newest first, by created_at (Asia/Jerusalem date filter).
--     The only index carrying created_at led with reservation_id, so the list
--     scanned that whole index and filtered the tenant.
--
--  2. communication_purge_ledger — when "מחק היסטוריה" deletes terminal
--     outbound rows (and fully-finished events), the idempotency it held must
--     survive: the ledger keeps ONLY (tenant_id, key, created_at) — no content,
--     no names, no phones. key = 'delivery:<idempotency_key>' for a deleted
--     outbound row, 'occurrence:<event_type>:<aggregate_type>:<occurrence_key>'
--     for a deleted event.
--
--  3. The engine consults it at the one place every path goes through: a
--     BEFORE INSERT trigger on communication_events and on outbound_messages
--     returns NULL (the row is not written — exactly what ON CONFLICT DO
--     NOTHING already does for a live key) when the key was purged. So the
--     scheduler, the confirmed/cancelled emitters and the delivery planner can
--     never re-create, and so never re-send, a purged message.
--
--  4. Permission communications.history.purge, granted to the system admin
--     role only.
--
--  NO data changes. Nothing is deleted on migrate.
-- ============================================================

SET search_path TO "guesthub", public;

CREATE INDEX IF NOT EXISTS outbound_messages_tenant_created_idx
  ON outbound_messages (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS communication_purge_ledger (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE OR REPLACE FUNCTION guesthub.skip_purged_communication()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE k text;
BEGIN
  IF TG_TABLE_NAME = 'communication_events' THEN
    k := 'occurrence:' || NEW.event_type || ':' || NEW.aggregate_type || ':' || NEW.occurrence_key;
  ELSIF NEW.idempotency_key IS NULL THEN
    RETURN NEW;
  ELSE
    k := 'delivery:' || NEW.idempotency_key;
  END IF;
  IF EXISTS (SELECT 1 FROM guesthub.communication_purge_ledger l WHERE l.tenant_id = NEW.tenant_id AND l.key = k) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_skip_purged_event ON communication_events;
CREATE TRIGGER trg_skip_purged_event BEFORE INSERT ON communication_events
  FOR EACH ROW EXECUTE FUNCTION guesthub.skip_purged_communication();
DROP TRIGGER IF EXISTS trg_skip_purged_delivery ON outbound_messages;
CREATE TRIGGER trg_skip_purged_delivery BEFORE INSERT ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION guesthub.skip_purged_communication();

INSERT INTO permissions (key, description, category) VALUES
  ('communications.history.purge', 'מחיקת היסטוריית השליחה', 'communications')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, category = EXCLUDED.category;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.key = 'communications.history.purge'
WHERE r.is_system = true AND r.key = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
