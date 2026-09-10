// Pure logic for the guest message composer ("שליחת מייל לאורח", D178).
//
// Zero imports on purpose: scripts/check-send-message-panel.mjs compiles this
// file ALONE with tsc and CALLS it, so every rule below is proven by running
// it, not by reading it.
//
// Two things live here, both of which the drawer used to bury inside the
// component: inserting a variable token at the caret, and the ONE gate that
// decides whether the send button is live. The gate is single-sourced because
// the footer must NAME the same reason the button is locked for — a disabled
// button with no stated reason is what the approved design replaces.

/** the composer's editable draft — survives closing the overlay (D178) */
export type ComposerDraft = {
  mode: "custom" | "template";
  templateId: string;
  subject: string;
  body: string;
};

export const EMPTY_DRAFT: ComposerDraft = { mode: "custom", templateId: "", subject: "", body: "" };

/**
 * Insert `token` over the [start, end) selection. A collapsed selection is a
 * plain insertion; a real selection is REPLACED (the browser's own behaviour
 * for typing), and the caret always lands just after the inserted token.
 */
export function insertToken(
  text: string,
  start: number,
  end: number,
  token: string,
): { text: string; caret: number } {
  const lo = Math.max(0, Math.min(start, end, text.length));
  const hi = Math.max(0, Math.min(Math.max(start, end), text.length));
  return { text: text.slice(0, lo) + token + text.slice(hi), caret: lo + token.length };
}

/** what a template fills a draft with — structurally the composer's own template rows */
export type DraftTemplate = { subject: string | null; body: string };

/**
 * The mode switch (D178). "כתיבת הודעה חדשה" is a BLANK page: the template's
 * text — and with it the raw {{placeholders}} — must not linger in either
 * editable field. Owner ruling 10/09/2026: empty means empty, so the SUBJECT
 * clears with the body, and the preview (derived from both) empties with them.
 * It was misleading rather than merely sticky, because the preview beside the
 * editor renders the SAME text with the values resolved, so the operator saw
 * tokens and values for one message at the same moment.
 *
 * Switching back re-fills from the still-selected template. That half is not
 * cosmetic: the <select> keeps its value, so re-picking the same option fires
 * no change event and the select's own onChange would never run again.
 */
export function applyMode(
  draft: ComposerDraft,
  mode: ComposerDraft["mode"],
  template: DraftTemplate | null,
  isEmail: boolean,
): ComposerDraft {
  if (mode === "custom") return { ...draft, mode, body: "", subject: "" };
  if (!template) return { ...draft, mode };
  return { ...draft, mode, body: template.body, ...(isEmail ? { subject: template.subject ?? "" } : {}) };
}

export type SendGateInput = {
  isEmail: boolean;
  /** the channel provider (Gmail / WhatsApp) is configured for this tenant */
  providerConfigured: boolean;
  /** the guest has a valid email (or phone, on WhatsApp) */
  recipientValid: boolean;
  /** D172: the subject/body carries a variable the renderer cannot resolve */
  subjectBlocked: boolean;
  bodyBlocked: boolean;
  subject: string;
  /** the RENDERED body — an all-variables body that resolves to nothing is empty */
  renderedBody: string;
};

/** why the send button is locked — null when it is live */
export type SendBlock =
  | "provider"
  | "recipient"
  | "subject_blocked"
  | "body_blocked"
  | "subject_empty"
  | "body_empty";

/**
 * The single gate behind BOTH the button's disabled state and the footer's
 * stated reason. Order matters: the reason shown is the most upstream one, so
 * "no email address" is never hidden behind "the subject is empty".
 */
export function manualSendGate(input: SendGateInput): { canSend: boolean; block: SendBlock | null } {
  const block = ((): SendBlock | null => {
    if (!input.providerConfigured) return "provider";
    if (!input.recipientValid) return "recipient";
    if (input.subjectBlocked) return "subject_blocked";
    if (input.bodyBlocked) return "body_blocked";
    if (input.isEmail && !input.subject.trim()) return "subject_empty";
    if (!input.renderedBody.trim()) return "body_empty";
    return null;
  })();
  return { canSend: block === null, block };
}

/** the footer's warning line — the approved design states the reason, never a bare disabled button */
export function sendBlockMessage(block: SendBlock | null, isEmail: boolean): string | null {
  switch (block) {
    case "recipient":
      return isEmail ? "חסרה כתובת אימייל — לא ניתן לשלוח" : "חסר מספר טלפון תקין — לא ניתן לשלוח";
    case "provider":
      return isEmail ? "שירות Gmail טרם הוגדר — לא ניתן לשלוח" : "ספק WhatsApp טרם הוגדר — לא ניתן לשלוח";
    case "subject_blocked":
      return "הנושא מכיל משתנה שלא ניתן לשלוח";
    case "body_blocked":
      return "תוכן ההודעה מכיל משתנה שלא ניתן לשלוח";
    case "subject_empty":
      return "יש למלא נושא להודעה";
    case "body_empty":
      return "יש למלא את תוכן ההודעה";
    default:
      return null;
  }
}

/** "Sofía Airbnb" → "SA"; a single name gives one letter. Never more than two. */
export function guestInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  const letters = parts.slice(0, 2).map((p) => [...p][0] ?? "");
  return letters.join("").toUpperCase();
}

/**
 * The header's stay range, in the approved design's compact form:
 * "03–06/07/2026" when the month and year match, "03/07–02/08/2026" when only
 * the year does, and the app's plain two-date form otherwise. Date-only ISO
 * strings in, so this stays pure (no Date, no timezone).
 */
export function formatStayRange(checkIn: string, checkOut: string): string {
  const [ay, am, ad] = [checkIn.slice(0, 4), checkIn.slice(5, 7), checkIn.slice(8, 10)];
  const [by, bm, bd] = [checkOut.slice(0, 4), checkOut.slice(5, 7), checkOut.slice(8, 10)];
  if (ay === by && am === bm) return `${ad}–${bd}/${bm}/${by}`;
  if (ay === by) return `${ad}/${am}–${bd}/${bm}/${by}`;
  return `${ad}/${am}/${ay}–${bd}/${bm}/${by}`;
}
