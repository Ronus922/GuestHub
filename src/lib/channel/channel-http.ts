// ============================================================
// Channel-provider HTTP primitives shared by the Beds24 client (beds24-http.ts
// owns the actual request path): the error-category taxonomy, status mapping,
// Retry-After parsing, defensive body accessors, and the D112 raw-evidence
// capture. The generic `channelRequest` core that once lived here had no
// remaining caller (every call goes through beds24-http) and was deleted with
// its fixed category-message table — a table whose "(401)…(429)" literals are
// exactly the fabricated-status class D112 forbids.
//
// Safety invariants (enforced in beds24-http, stated here with the taxonomy):
//  • Single attempt per call, no retries — an ambiguous result stays ambiguous.
//  • The credential is NEVER placed in a returned message or category.
// ============================================================

export type ChannelApiErrorCategory =
  | "unauthorized" // 401
  | "forbidden" // 403
  | "not_found" // 404
  | "conflict" // 409
  | "validation" // 422
  | "rate_limited" // 429
  | "server_error" // 5xx
  | "timeout"
  | "network_error"
  | "bad_response";

// ---- D112: failures must carry their own evidence ----
// The category above is DERIVED data. What an operator (or a later diagnosis)
// needs is what the provider actually said — captured verbatim, at the moment
// of failure, BEFORE any parsing or mapping. A category may stand beside the
// original; it must never replace it.
export const RAW_BODY_MAX_CHARS = 2048;

export type RawResponseEvidence = {
  /** the actual HTTP status received, verbatim. null = no response arrived
   *  (timeout / network failure / payload rejected before sending) */
  httpStatus: number | null;
  /** the raw response body text, unmodified — first RAW_BODY_MAX_CHARS chars.
   *  The stored prefix is verbatim; `truncated` is the explicit marker. */
  body: string | null;
  truncated: boolean;
  /** UTC timestamp taken when the response (or transport failure) was observed */
  receivedAt: string;
};

export function rawEvidenceOf(
  httpStatus: number | null,
  bodyText: string | null,
  now: Date = new Date(),
): RawResponseEvidence {
  const truncated = bodyText !== null && bodyText.length > RAW_BODY_MAX_CHARS;
  return {
    httpStatus,
    body: bodyText !== null && truncated ? bodyText.slice(0, RAW_BODY_MAX_CHARS) : bodyText,
    truncated,
    receivedAt: now.toISOString(),
  };
}

// Parse a Retry-After header: either delta-seconds ("120") or an HTTP-date.
// Returns ms, or null when absent/unparseable. `now` is injectable for tests.
export function parseRetryAfterMs(headerValue: string | null, now: number = Date.now()): number | null {
  if (!headerValue) return null;
  const secs = Number(headerValue.trim());
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const when = Date.parse(headerValue);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

export const DEFAULT_TIMEOUT_MS = 12_000;

// Map a non-2xx status (or an unexpected 2xx) to a safe failure category.
export function mapErrorStatus(status: number): ChannelApiErrorCategory {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_response";
}

// An AMBIGUOUS failure leaves the external state unknown: the request may or may
// not have been applied upstream. Such a write must never be blindly re-issued —
// the caller must re-read the external collection and reconcile explicitly.
export function isAmbiguous(category: ChannelApiErrorCategory): boolean {
  return (
    category === "timeout" ||
    category === "network_error" ||
    category === "server_error" ||
    category === "bad_response"
  );
}

// ---- defensive body parsing ----
export type RawObj = Record<string, unknown>;
export const asObj = (v: unknown): RawObj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RawObj) : null;
export const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) ? v : null;

