/**
 * RFC header values must never contain line breaks or NUL. Reject instead of
 * stripping so a malicious/accidental value cannot silently change meaning.
 */
export function sanitizeEmailHeader(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("invalid_email_header");
  return value;
}

const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(value: string): boolean {
  return !/[\r\n\0]/.test(value) && EMAIL_ADDRESS_RE.test(value.trim());
}
