// ============================================================
// Google Maps failure taxonomy — PURE (no IO, no SDK, no key).
// D61 shipped ONE generic "טעינת Google Maps נכשלה" for every failure, which
// swallowed the real exception (a library that was not yet loaded). Each stage
// of the picker now reports a distinct code so a production failure is
// diagnosable from the UI without opening a console or exposing a secret.
//
// Sanitization contract: a code + a fixed Hebrew message + a short technical
// detail that is scrubbed of anything key-shaped. The Maps script URL carries
// the browser key in ?key=, so a raw error message or URL must NEVER reach a
// log, an audit row, or the DOM.
// ============================================================

export const MAPS_ERROR_CODES = [
  "MAPS_SCRIPT_LOAD_FAILED",
  "MAPS_LIBRARY_INIT_FAILED",
  "PLACES_LIBRARY_INIT_FAILED",
  "AUTOCOMPLETE_WIDGET_INIT_FAILED",
  "MAP_CONTAINER_MISSING",
  "PLACE_SELECTION_FAILED",
  "PLACE_DETAILS_FAILED",
  "PLACE_WITHOUT_LOCATION",
  "MAP_RENDER_FAILED",
  "MARKER_RENDER_FAILED",
  "GEOCODING_FAILED",
] as const;

export type MapsErrorCode = (typeof MAPS_ERROR_CODES)[number];

const MESSAGES: Record<MapsErrorCode, string> = {
  MAPS_SCRIPT_LOAD_FAILED: "טעינת הסקריפט של Google Maps נכשלה. בדוק חיבור לרשת ונסה שוב.",
  MAPS_LIBRARY_INIT_FAILED: "אתחול ספריית המפות של Google נכשל.",
  PLACES_LIBRARY_INIT_FAILED: "אתחול ספריית המקומות (Places) של Google נכשל.",
  AUTOCOMPLETE_WIDGET_INIT_FAILED: "יצירת שדה חיפוש הכתובות של Google נכשלה.",
  MAP_CONTAINER_MISSING: "מיכל המפה לא נמצא בעמוד.",
  PLACE_SELECTION_FAILED: "עיבוד המקום שנבחר נכשל. נסה לבחור שוב.",
  PLACE_DETAILS_FAILED: "שליפת פרטי המקום מ-Google נכשלה.",
  PLACE_WITHOUT_LOCATION: "למקום שנבחר אין קואורדינטות ולכן אי אפשר לשמור אותו.",
  MAP_RENDER_FAILED: "הצגת המפה נכשלה.",
  MARKER_RENDER_FAILED: "הצגת הסמן על המפה נכשלה.",
  GEOCODING_FAILED: "המרת הקואורדינטות לכתובת נכשלה. הקואורדינטות עצמן תקינות.",
};

export class MapsError extends Error {
  readonly code: MapsErrorCode;
  constructor(code: MapsErrorCode, cause?: unknown) {
    super(code);
    this.name = "MapsError";
    this.code = code;
    this.cause = cause;
  }
}

export function mapsErrorMessage(code: MapsErrorCode): string {
  return MESSAGES[code];
}

// Strip anything that could carry the browser key: a `key=` query param, a full
// maps.googleapis.com URL, or a bare long token. Applied to every technical
// detail before it is logged or rendered.
export function scrubSecrets(text: string): string {
  return text
    .replace(/([?&])key=[^&\s"']*/gi, "$1key=[redacted]")
    .replace(/https?:\/\/maps\.googleapis\.com\/\S*/gi, "[maps-url-redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, "[redacted]");
}

export type SanitizedMapsError = { code: MapsErrorCode; message: string; detail: string };

// The ONLY shape allowed to reach a log or the UI. `detail` is a short scrubbed
// excerpt so an operator can report *which* failure happened; it never contains
// a key, a script URL, or an upstream response body.
export function sanitizeMapsError(e: unknown, fallback: MapsErrorCode): SanitizedMapsError {
  const code = e instanceof MapsError ? e.code : fallback;
  const raw = e instanceof MapsError ? e.cause : e;
  const rawText = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  return { code, message: mapsErrorMessage(code), detail: scrubSecrets(rawText).slice(0, 120) };
}
