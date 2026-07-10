import "server-only";
import { sql } from "@/lib/db";
import { decodeDomainEvent, EVENTS_CHANNEL, type DomainEvent } from "./events";

// ============================================================
// Web-process event hub (D77 §6): ONE dedicated LISTEN connection per Node
// process (postgres.js sql.listen — outside the pool, auto-reconnect +
// re-subscribe), fanned out in-process to the SSE subscribers of each tenant.
//
// Tenant isolation is enforced HERE: a subscriber registers for exactly one
// tenant (taken from its authenticated actor, never from the client) and only
// ever receives that tenant's events. Works for any number of tabs; the
// PM2 worker's events arrive through the same pg channel.
//
// globalThis singleton — survives dev HMR exactly like __guesthubSql (db.ts).
// ============================================================

type Subscriber = (event: DomainEvent) => void;

type Hub = {
  subs: Map<string, Set<Subscriber>>;
  starting: Promise<void> | null;
};

const globalForHub = globalThis as unknown as { __guesthubEventHub?: Hub };

function hub(): Hub {
  if (!globalForHub.__guesthubEventHub) {
    globalForHub.__guesthubEventHub = { subs: new Map(), starting: null };
  }
  return globalForHub.__guesthubEventHub;
}

function dispatch(raw: string): void {
  const decoded = decodeDomainEvent(raw);
  if (!decoded) return; // malformed payloads are dropped, never thrown
  const set = hub().subs.get(decoded.tenantId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(decoded.event);
    } catch {
      // one broken subscriber must not break the fan-out
    }
  }
}

function ensureListening(): void {
  const h = hub();
  if (h.starting) return;
  // sql.listen re-subscribes automatically after a connection drop; only the
  // INITIAL failure needs a retry path — clearing `starting` lets the next
  // subscriber try again instead of wedging the hub forever.
  h.starting = sql
    .listen(EVENTS_CHANNEL, dispatch)
    .then(() => {})
    .catch((e) => {
      console.error("[realtime] listen failed", e instanceof Error ? e.message : e);
      h.starting = null;
    });
}

/** Subscribe an authenticated SSE stream to its tenant's events.
 *  Returns the unsubscribe function. */
export function subscribeTenantEvents(tenantId: string, fn: Subscriber): () => void {
  ensureListening();
  const h = hub();
  let set = h.subs.get(tenantId);
  if (!set) {
    set = new Set();
    h.subs.set(tenantId, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) h.subs.delete(tenantId);
  };
}
