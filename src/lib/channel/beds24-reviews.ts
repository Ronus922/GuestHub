import "server-only";
import type { Sql } from "postgres";
import { beds24BaseUrl } from "./config";
import { asObj } from "./channel-http";
import {
  beds24Fail,
  beds24Request,
  mapErrorStatus,
  type Beds24ApiFailure,
  type Beds24ReqOpts,
} from "./beds24-http";
import { getBeds24AccessToken } from "./beds24-token";
import {
  createBeds24CreditGate, beds24CreditPauseMessage,
  type Beds24CreditPause, type Beds24CreditSnapshot,
} from "./beds24-credits";
import { circuitAllowsRequest } from "./circuit-breaker";
import { logChannelError } from "./queue";
import {
  ingestCircuitState,
  loadBeds24PropertyIds,
  type Beds24IngestConnection,
} from "./beds24-messages";

// ============================================================
// Booking.com review ingest through Beds24 (Phase 4, RECEIVE-ONLY) —
// GET /channels/booking/reviews into channel_reviews (076). This module makes
// exactly ONE kind of Beds24 call. There is NO write path for a review reply:
// Beds24 support confirmed (2026-08-02) that no such endpoint exists —
// `reply` is a read-only reflection of what staff wrote in the Booking.com
// extranet, and this poll is the only thing that ever fills it in.
//
// THE WIRE, MEASURED (ref/audit/BEDS24-REVIEWS-SHAPE-2026-08-05.json — live
// probe, 24 reviews; parameter contract from the spec probe of 2026-08-02):
//   • BOTH query params are REQUIRED: propertyId (single integer — not an
//     array like /bookings) and from (YYYY-MM-DD). Omitting `from` returns
//     Beds24's generic 400 {"code":3000,"error":"Invalid data"} that names
//     no parameter — that 400 read as a scope problem for a whole probe
//     cycle. Never drop `from`.
//   • a review is nine keys: review_id (opaque string), created_timestamp /
//     last_change_timestamp ("YYYY-MM-DD HH:MM:SS", no zone), content|null
//     {headline,positive,negative,language_code} (null on score-only reviews,
//     10 of 24), reservation_id (number), scoring {facilities,comfort,staff,
//     value,clean,location,review_score}, reviewer {name,country_code,
//     is_genius}, reply|null {text,last_change_timestamp}, url
//   • THE JOIN-KEY TRAP: reservation_id is BOOKING.COM's reservation number —
//     it joins reservations.ota_reservation_code. It is NOT the Beds24
//     booking id: joining external_booking_id (the messages feed's key)
//     matches 0/24 and yields an empty screen with no error.
//   • the live scoring block carries `comfort` and NOT the spec's `services`;
//     category_scores jsonb absorbs that drift verbatim
//   • measured cost: 1.0 credit per call; ≤100 reviews per call with the
//     shared pages envelope
//
// Upsert model: ON CONFLICT (tenant_id, external_review_id) DO UPDATE — a
// reply written months after ingest lands on the EXISTING row and stamps
// replied_at; "awaiting response" stays reply IS NULL (076's partial index).
// ============================================================

/** How far back `from` reaches, in days. Two years spans the entire history
 *  this account holds (oldest measured review: 2025-09-30) while bounding the
 *  walk forever; a reply landing on a review older than that stops being
 *  tracked, which is acceptable for an "awaiting response" surface. */
export const REVIEWS_LOOKBACK_DAYS = 730;
// ≤100 reviews per call (documented) → 5 pages = 500 reviews per property per
// cycle, far above the measured 24. A bound, never an unbounded loop.
const REVIEWS_MAX_PAGES = 5;
const MAX_ERRORS = 20;

// ---------------------------------------------------------------
// wire types + pure normalization (no DB, no HTTP)
// ---------------------------------------------------------------

/** One review as measured on the wire. `url` exists upstream but is
 *  deliberately NOT modeled — it addresses Booking.com's own supply API with
 *  credentials this system does not hold (it survives inside raw only). */
export type Beds24BookingReview = {
  review_id: string;
  created_timestamp: string;
  last_change_timestamp: string;
  content: {
    headline?: string;
    positive?: string;
    negative?: string;
    language_code?: string;
  } | null;
  reservation_id: number;
  scoring: Record<string, number>;
  reviewer: { name?: string; country_code?: string; is_genius?: boolean };
  reply: { text?: string; last_change_timestamp?: string } | null;
};

export type NormalizedChannelReview = {
  externalReviewId: string;
  /** Booking.com's reservation number — joins ota_reservation_code (header) */
  bookingId: string | null;
  guestName: string | null;
  /** ISO-8601; the wire's zone-less stamp is taken as UTC (verbatim in raw) */
  submittedAt: string;
  overallScore: number;
  categoryScores: Record<string, number>;
  positiveText: string | null;
  negativeText: string | null;
  reply: string | null;
  repliedAt: string | null;
  raw: unknown;
};

export type ChannelReviewNormalizeResult =
  | { ok: true; value: NormalizedChannelReview }
  | { ok: false; error: string };

// "YYYY-MM-DD HH:MM:SS" (no zone, measured 24/24) → ISO UTC. Anything else
// that Date.parse can read is accepted defensively; unreadable → null.
function wireTimestampToIso(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)
    ? `${v.replace(" ", "T")}Z`
    : v;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const nonBlank = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;

/** Pure. Defensive on every field; a malformed review is reported, never
 *  thrown, and never partially stored. */
export function normalizeBeds24Review(payload: unknown): ChannelReviewNormalizeResult {
  const r = asObj(payload);
  if (!r) return { ok: false, error: "חוות דעת מ-Beds24 אינה אובייקט" };
  const externalReviewId = nonBlank(r.review_id);
  if (!externalReviewId) return { ok: false, error: "חוות דעת מ-Beds24 ללא מזהה" };
  const submittedAt = wireTimestampToIso(r.created_timestamp);
  if (!submittedAt) {
    return { ok: false, error: `חוות דעת ${externalReviewId} עם חותמת זמן בלתי קריאה` };
  }
  const scoring = asObj(r.scoring) ?? {};
  const overall = scoring.review_score;
  if (typeof overall !== "number" || !Number.isFinite(overall)) {
    return { ok: false, error: `חוות דעת ${externalReviewId} ללא ציון כולל` };
  }
  const categoryScores: Record<string, number> = {};
  for (const [k, v] of Object.entries(scoring)) {
    if (typeof v === "number" && Number.isFinite(v)) categoryScores[k] = v;
  }
  const content = asObj(r.content);
  const reviewer = asObj(r.reviewer);
  const reply = asObj(r.reply);
  const replyText = reply ? nonBlank(reply.text) : null;
  return {
    ok: true,
    value: {
      externalReviewId,
      bookingId:
        typeof r.reservation_id === "number" && Number.isFinite(r.reservation_id)
          ? String(r.reservation_id)
          : null,
      guestName: reviewer ? nonBlank(reviewer.name) : null,
      submittedAt,
      overallScore: overall,
      categoryScores,
      positiveText: content ? nonBlank(content.positive) : null,
      negativeText: content ? nonBlank(content.negative) : null,
      reply: replyText,
      // a reply's own stamp when present; a reply with no readable stamp
      // still counts as answered (replied_at falls back to the change stamp)
      repliedAt: replyText
        ? wireTimestampToIso(reply?.last_change_timestamp) ??
          wireTimestampToIso(r.last_change_timestamp)
        : null,
      raw: payload,
    },
  };
}

// ---------------------------------------------------------------
// reviews client — GET /channels/booking/reviews ONLY
// ---------------------------------------------------------------

type ReviewsPage = {
  ok: true;
  reviews: unknown[];
  nextPageExists: boolean;
  credits: Beds24CreditSnapshot;
};

async function fetchReviewsPage(
  opts: Beds24ReqOpts,
  propertyId: string,
  fromDate: string,
  page: number,
): Promise<ReviewsPage | Beds24ApiFailure> {
  // BOTH params are required — see header before touching this path.
  const path =
    `/channels/booking/reviews?propertyId=${encodeURIComponent(propertyId)}` +
    `&from=${fromDate}&page=${page}`;
  const res = await beds24Request({ ...opts, method: "GET", path });
  if ("ok" in res) return res;
  if (res.status !== 200) {
    const f = beds24Fail(mapErrorStatus(res.status), res.status, res.raw);
    return res.retryAfterMs !== undefined
      ? { ...f, retryAfterMs: res.retryAfterMs, credits: res.credits }
      : { ...f, credits: res.credits };
  }
  const root = asObj(res.body);
  if (root && root.success === false) return beds24Fail("bad_response", res.status, res.raw);
  const data = root?.data ?? res.body;
  if (!Array.isArray(data)) return beds24Fail("bad_response", res.status, res.raw);
  return {
    ok: true,
    reviews: data,
    nextPageExists: asObj(root?.pages)?.nextPageExists === true,
    credits: res.credits,
  };
}

// ---------------------------------------------------------------
// persistence — upsert on (tenant_id, external_review_id)
// ---------------------------------------------------------------

// Insert-or-refresh one review. The update path only fires when the payload
// actually changed (raw IS DISTINCT FROM), so an unchanged hourly re-poll
// touches nothing. xmax = 0 distinguishes a fresh insert from a refresh.
async function upsertChannelReview(
  db: Sql,
  conn: Beds24IngestConnection,
  propertyId: string,
  review: NormalizedChannelReview,
): Promise<"inserted" | "updated" | "unchanged"> {
  const rows = await db<{ inserted: boolean }[]>`
    INSERT INTO guesthub.channel_reviews
      (tenant_id, connection_id, property_id, external_review_id, booking_id,
       guest_name, submitted_at, overall_score, category_scores,
       positive_text, negative_text, reply, replied_at, raw)
    VALUES
      (${conn.tenant_id}, ${conn.id}, ${propertyId}, ${review.externalReviewId},
       ${review.bookingId}, ${review.guestName}, ${review.submittedAt},
       ${review.overallScore}, ${db.json(review.categoryScores as never)},
       ${review.positiveText}, ${review.negativeText},
       ${review.reply}, ${review.repliedAt}, ${db.json(review.raw as never)})
    ON CONFLICT (tenant_id, external_review_id) DO UPDATE SET
      booking_id = EXCLUDED.booking_id,
      guest_name = EXCLUDED.guest_name,
      submitted_at = EXCLUDED.submitted_at,
      overall_score = EXCLUDED.overall_score,
      category_scores = EXCLUDED.category_scores,
      positive_text = EXCLUDED.positive_text,
      negative_text = EXCLUDED.negative_text,
      reply = EXCLUDED.reply,
      replied_at = EXCLUDED.replied_at,
      raw = EXCLUDED.raw
    WHERE guesthub.channel_reviews.raw IS DISTINCT FROM EXCLUDED.raw
    RETURNING (xmax = 0) AS inserted`;
  if (rows.length === 0) return "unchanged";
  return rows[0].inserted ? "inserted" : "updated";
}

// ---------------------------------------------------------------
// the pull — one bounded walk per mapped property
// ---------------------------------------------------------------

export type Beds24ChannelReviewsSummary = {
  fetched: number;
  inserted: number;
  /** an existing row refreshed — e.g. a reply appeared upstream */
  updated: number;
  failed: number;
  errors: string[];
  credits: Beds24CreditSnapshot | null;
  creditPause: Beds24CreditPause | null;
  circuitOpen: boolean;
};

function pushError(summary: { errors: string[] }, message: string): void {
  if (summary.errors.length < MAX_ERRORS) summary.errors.push(message);
}

export async function runBeds24ChannelReviewsPull(
  db: Sql,
  conn: Beds24IngestConnection,
): Promise<Beds24ChannelReviewsSummary> {
  const summary: Beds24ChannelReviewsSummary = {
    fetched: 0, inserted: 0, updated: 0, failed: 0,
    errors: [], credits: null, creditPause: null, circuitOpen: false,
  };

  // §16 — read-only respect, same doctrine as the messages pull.
  if (!circuitAllowsRequest(ingestCircuitState(conn), Date.now())) {
    summary.circuitOpen = true;
    return summary;
  }

  const propertyIds = await loadBeds24PropertyIds(db, conn.id);
  if (propertyIds.length === 0) {
    pushError(summary, "אין חדרי Beds24 ממופים לחיבור זה");
    return summary;
  }

  const access = await getBeds24AccessToken(db, conn);
  if (!access.ok) {
    pushError(summary, access.error);
    return summary;
  }
  const creds: Beds24ReqOpts = { token: access.token, baseUrl: beds24BaseUrl() };
  const gate = createBeds24CreditGate();
  const fromDate = new Date(Date.now() - REVIEWS_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // propertyId is a SINGLE integer on this endpoint (unlike /bookings) —
  // one bounded walk per mapped property.
  for (const propertyId of propertyIds) {
    for (let page = 1; page <= REVIEWS_MAX_PAGES; page++) {
      if (gate.pause) {
        pushError(summary, beds24CreditPauseMessage(gate.pause));
        break;
      }
      const res = await fetchReviewsPage(creds, propertyId, fromDate, page);
      const rateLimited = "ok" in res && res.ok === false && res.category === "rate_limited";
      gate.observe(res.credits, {
        ...(rateLimited ? { httpStatus: 429 } : {}),
        ...(rateLimited && res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
      });
      summary.credits = gate.last;
      summary.creditPause = gate.pause;
      if (!res.ok) {
        pushError(summary, gate.pause ? beds24CreditPauseMessage(gate.pause) : res.message);
        // D112 — raw evidence, one unresolved row per code (hourly repeat).
        const [dup] = await db<{ x: number }[]>`
          SELECT 1 AS x FROM guesthub.channel_sync_errors
          WHERE tenant_id = ${conn.tenant_id} AND connection_id = ${conn.id}
            AND error_code = ${`channel_reviews_${res.category}`} AND resolved_at IS NULL
          LIMIT 1`;
        if (!dup) {
          await logChannelError(db, {
            tenantId: conn.tenant_id,
            connectionId: conn.id,
            code: `channel_reviews_${res.category}`,
            message: res.message,
            httpStatus: res.raw?.httpStatus ?? null,
            responseBody: res.raw?.body ?? null,
            responseTruncated: res.raw?.truncated ?? false,
            responseReceivedAt: res.raw?.receivedAt ?? null,
          });
        }
        break;
      }
      for (const item of res.reviews) {
        summary.fetched += 1;
        const norm = normalizeBeds24Review(item);
        if (!norm.ok) {
          summary.failed += 1;
          pushError(summary, norm.error);
          continue;
        }
        const outcome = await upsertChannelReview(db, conn, propertyId, norm.value);
        if (outcome === "inserted") summary.inserted += 1;
        else if (outcome === "updated") summary.updated += 1;
      }
      if (!res.nextPageExists || res.reviews.length === 0) break;
    }
    if (gate.pause) break; // the window is closed for every remaining property too
  }
  return summary;
}
