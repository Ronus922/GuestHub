// ============================================================
// Domain events (D77 §6) — the ONE vocabulary for "something committed".
// Pure module (no imports): shared by the server publisher, the web-process
// hub, the worker graph and the browser provider.
//
// SAFETY BY CONSTRUCTION: the wire codec below copies a fixed whitelist of
// fields. There is no field for guest data, card data, tokens, notes or
// credentials — a payload cannot smuggle them. Consumers treat an event as an
// invalidation signal + routing hint and REFETCH through the authorized read
// paths; the event itself never renders.
// ============================================================

export const EVENTS_CHANNEL = "guesthub_events";
/** wake-up channel for the PM2 channel worker (payload = job type, diagnostic) */
export const JOBS_WAKE_CHANNEL = "guesthub_jobs";

export const DOMAIN_EVENT_TYPES = [
  "reservation.created",
  "reservation.modified",
  "reservation.cancelled",
  "reservation.workflow_status_changed",
  "reservation.payment_changed",
  "reservation.checked_in",
  "reservation.checked_out",
  "reservation.no_show",
  "inventory.changed",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export type DomainEvent = {
  type: DomainEventType;
  /** affected reservation, when the event concerns one */
  reservationId: string | null;
  /** affected physical rooms (capped — a hint, not an inventory) */
  roomIds: string[];
  /** affected date range, date-only, check-out exclusive */
  dateFrom: string | null;
  dateTo: string | null;
  /** safe lifecycle code (e.g. "confirmed" / "cancelled") — never free text */
  lifecycle: string | null;
  /** commit-side timestamp (ISO) */
  at: string;
};

export type DomainEventInput = {
  type: DomainEventType;
  reservationId?: string | null;
  roomIds?: (string | null | undefined)[];
  dateFrom?: string | null;
  dateTo?: string | null;
  lifecycle?: string | null;
};

const TYPE_SET = new Set<string>(DOMAIN_EVENT_TYPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIFECYCLE_RE = /^[a-z_]{1,32}$/;
// NOTIFY payloads are limited to ~8KB — cap the room hint, never the truth
const MAX_ROOM_IDS = 24;

/** Whitelist-copy an event into its wire form. Throws on an invalid type;
 *  silently drops malformed optional fields (they are hints). */
export function encodeDomainEvent(
  tenantId: string,
  input: DomainEventInput,
  at: string,
): string {
  if (!TYPE_SET.has(input.type)) throw new Error(`unknown domain event type: ${input.type}`);
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant id");
  const roomIds = (input.roomIds ?? [])
    .filter((x): x is string => typeof x === "string" && UUID_RE.test(x))
    .slice(0, MAX_ROOM_IDS);
  const wire = {
    t: tenantId,
    e: input.type,
    rid: input.reservationId && UUID_RE.test(input.reservationId) ? input.reservationId : null,
    rooms: roomIds,
    df: input.dateFrom && DATE_RE.test(input.dateFrom) ? input.dateFrom : null,
    dt: input.dateTo && DATE_RE.test(input.dateTo) ? input.dateTo : null,
    lc: input.lifecycle && LIFECYCLE_RE.test(input.lifecycle) ? input.lifecycle : null,
    at,
  };
  return JSON.stringify(wire);
}

/** Parse a wire payload back into (tenantId, event). Returns null on any
 *  malformed input — a bad payload is dropped, never thrown into the hub. */
export function decodeDomainEvent(
  raw: string,
): { tenantId: string; event: DomainEvent } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const tenantId = typeof o.t === "string" && UUID_RE.test(o.t) ? o.t : null;
  const type = typeof o.e === "string" && TYPE_SET.has(o.e) ? (o.e as DomainEventType) : null;
  if (!tenantId || !type) return null;
  return {
    tenantId,
    event: {
      type,
      reservationId:
        typeof o.rid === "string" && UUID_RE.test(o.rid) ? o.rid : null,
      roomIds: Array.isArray(o.rooms)
        ? o.rooms.filter((x): x is string => typeof x === "string" && UUID_RE.test(x))
        : [],
      dateFrom: typeof o.df === "string" && DATE_RE.test(o.df) ? o.df : null,
      dateTo: typeof o.dt === "string" && DATE_RE.test(o.dt) ? o.dt : null,
      lifecycle: typeof o.lc === "string" && LIFECYCLE_RE.test(o.lc) ? o.lc : null,
      at: typeof o.at === "string" ? o.at : "",
    },
  };
}
