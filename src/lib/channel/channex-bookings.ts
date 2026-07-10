// ============================================================
// Channex BOOKING REVISIONS client (D76) — server-side network calls for the
// inbound booking import. Requests go through the shared, leak-proof core in
// ./channex-http (single attempt, bounded timeout, fixed safe messages,
// api-key never echoed).
//
// SCOPE: this client touches the booking-revision feed, single revisions,
// single bookings (controlled recovery only) and the acknowledge endpoint.
// It NEVER calls the secure PCI endpoint (/bookings/:id/pci or any /pci path),
// never DELETE, and never mutates any Channex booking — the only POST is the
// acknowledgement, which marks a revision as delivered and nothing else.
// An ambiguous ack result (timeout/network) is returned as-is and is NEVER
// blindly retried here — the caller re-converges via the next feed pull.
//
// API contract (docs.channex.io/api-v.1-documentation/bookings-collection):
//   FEED GET  /booking_revisions/feed?filter[property_id]=<uuid>
//               &order[inserted_at]=asc&pagination[page]=N&pagination[limit]=100
//        → { data: [{ id, attributes: {...revision...} }], meta: { total, page, limit } }
//        Returns ONLY unacknowledged revisions, oldest first.
//   GET  /booking_revisions/:id  → { data: { id, attributes } }   (recovery)
//   GET  /bookings/:id           → { data: { id, attributes } }   (recovery)
//   ACK  POST /booking_revisions/:id/ack → { meta: { message } }
// ============================================================

import {
  channexRequest,
  fail,
  mapErrorStatus,
  asObj,
  asStr,
  type ChannexApiFailure,
  type ChannexReqOpts,
} from "./channex-http";

type ReqOpts = ChannexReqOpts;

export const FEED_PAGE_LIMIT = 100;

// The revision payload is handed onward VERBATIM (as unknown): redaction
// happens at persistence (persistBookingRevision → redactPayload) and parsing
// happens in the pure normalizer. This client only validates the envelope.
export type FeedRevision = { id: string; attributes: unknown };

export type FeedPage = {
  ok: true;
  revisions: FeedRevision[];
  /** total unacknowledged records upstream (not pages) */
  total: number;
};

function parseEnvelopeList(body: unknown): FeedRevision[] | null {
  const root = asObj(body);
  if (!root || !Array.isArray(root.data)) return null;
  const out: FeedRevision[] = [];
  for (const item of root.data) {
    const o = asObj(item);
    const id = o ? asStr(o.id) : null;
    const attributes = o ? o.attributes : null;
    if (!id || !attributes) return null;
    out.push({ id, attributes });
  }
  return out;
}

export async function fetchBookingRevisionsFeed(
  opts: ReqOpts,
  propertyId: string,
  page: number,
): Promise<FeedPage | ChannexApiFailure> {
  const path =
    `/booking_revisions/feed?filter[property_id]=${encodeURIComponent(propertyId)}` +
    `&order[inserted_at]=asc&pagination[page]=${page}&pagination[limit]=${FEED_PAGE_LIMIT}`;
  const res = await channexRequest({ ...opts, method: "GET", path });
  if ("ok" in res) return res;
  if (res.status !== 200) return fail(mapErrorStatus(res.status), res.status);
  const revisions = parseEnvelopeList(res.body);
  if (revisions === null) return fail("bad_response", res.status);
  const meta = asObj(asObj(res.body)?.meta);
  const total = typeof meta?.total === "number" ? meta.total : revisions.length;
  return { ok: true, revisions, total };
}

// Single revision by its Channex UUID — controlled recovery only (§10): used
// when the feed no longer returns a revision that must be (re)imported.
export async function fetchBookingRevision(
  opts: ReqOpts,
  revisionId: string,
): Promise<{ ok: true; revision: FeedRevision } | ChannexApiFailure> {
  const res = await channexRequest({
    ...opts,
    method: "GET",
    path: `/booking_revisions/${encodeURIComponent(revisionId)}`,
  });
  if ("ok" in res) return res;
  if (res.status !== 200) return fail(mapErrorStatus(res.status), res.status);
  const root = asObj(res.body);
  const data = asObj(root?.data);
  const id = data ? asStr(data.id) : null;
  if (!id || !data?.attributes) return fail("bad_response", res.status);
  return { ok: true, revision: { id, attributes: data.attributes } };
}

// Whole booking by its Channex UUID — controlled reconciliation only. Returns
// the booking attributes verbatim (same redaction/normalization path applies).
export async function fetchBooking(
  opts: ReqOpts,
  bookingId: string,
): Promise<{ ok: true; attributes: unknown } | ChannexApiFailure> {
  const res = await channexRequest({
    ...opts,
    method: "GET",
    path: `/bookings/${encodeURIComponent(bookingId)}`,
  });
  if ("ok" in res) return res;
  if (res.status !== 200) return fail(mapErrorStatus(res.status), res.status);
  const data = asObj(asObj(res.body)?.data);
  if (!data?.attributes) return fail("bad_response", res.status);
  return { ok: true, attributes: data.attributes };
}

// Acknowledge ONE revision. Called ONLY after the local import transaction
// committed (the DB-side gate in markRevisionAcknowledged is the backstop).
// Single attempt; an ambiguous result is reported, never blindly re-sent.
export async function acknowledgeBookingRevision(
  opts: ReqOpts,
  revisionId: string,
): Promise<{ ok: true } | ChannexApiFailure> {
  const res = await channexRequest({
    ...opts,
    method: "POST",
    path: `/booking_revisions/${encodeURIComponent(revisionId)}/ack`,
  });
  if ("ok" in res) return res;
  if (res.status !== 200 && res.status !== 201) return fail(mapErrorStatus(res.status), res.status);
  return { ok: true };
}

// ---- webhook registration (wake-up signal only) ----
// Ensures ONE active Channex webhook points at our per-connection callback URL.
// Idempotent: an existing webhook with the same callback is adopted, not
// duplicated. The webhook only wakes the pull job — send_data stays false so
// no booking payload (and no card data) ever rides the webhook body.
export type EnsureWebhookResult =
  | { ok: true; webhookId: string; created: boolean }
  | ChannexApiFailure;

export async function ensureChannexWebhook(
  opts: ReqOpts,
  propertyId: string,
  callbackUrl: string,
): Promise<EnsureWebhookResult> {
  const list = await channexRequest({
    ...opts,
    method: "GET",
    path: `/webhooks?filter[property_id]=${encodeURIComponent(propertyId)}&pagination[limit]=100`,
  });
  if ("ok" in list) return list;
  if (list.status !== 200) return fail(mapErrorStatus(list.status), list.status);
  const rows = asObj(list.body)?.data;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const o = asObj(row);
      const attrs = asObj(o?.attributes);
      const id = o ? asStr(o.id) : null;
      if (id && attrs && asStr(attrs.callback_url) === callbackUrl) {
        return { ok: true, webhookId: id, created: false };
      }
    }
  }
  const created = await channexRequest({
    ...opts,
    method: "POST",
    path: "/webhooks",
    body: {
      webhook: {
        property_id: propertyId,
        callback_url: callbackUrl,
        event_mask: "booking",
        request_params: {},
        headers: {},
        is_active: true,
        send_data: false,
      },
    },
  });
  if ("ok" in created) return created;
  if (created.status !== 201 && created.status !== 200)
    return fail(mapErrorStatus(created.status), created.status);
  const id = asStr(asObj(asObj(created.body)?.data)?.id);
  if (!id) return fail("bad_response", created.status);
  return { ok: true, webhookId: id, created: true };
}
