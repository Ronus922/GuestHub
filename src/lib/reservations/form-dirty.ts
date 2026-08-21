// ============================================================
// THE dirty-state fingerprint of a form that is open on screen.
//
// "Dirty" is a claim about THE OPERATOR, not about the data: it means a person
// typed, picked or changed something since this form opened. It is the only
// thing standing between a stray Escape and twenty minutes of typing — and it
// is also the only thing that can stop a wizard from interrogating someone who
// changed nothing. Both directions are real damage, and the second feeds the
// first: a form that asks "לצאת בלי לשמור?" when there is nothing to save
// teaches people to click the question away, which is exactly how the honest
// one gets dismissed.
//
// A form fills fields in BY ITSELF — the tenant's default payment method, the
// live quote copied into "שולם", the card holder taken from the guest's name.
// Those are the FORM's writes, not the operator's. Comparing them like ordinary
// input made a wizard that had only just opened report unsaved work: the quote
// landed a few hundred milliseconds after open, "שולם" moved from 0 to the
// total, and from that moment every exit route asked a question that had no
// answer. Such a field goes through autoFilled(), which hides its value while
// the form still owns it and reveals it the instant the operator takes over.
//
// PURE — no React, no imports, nothing to mock. scripts/check-closure-dirty.mjs
// compiles this module and CALLS it, so the rule is proven rather than quoted.
// ============================================================

/** The stand-in for a field the form filled in and nobody has touched. A NUL
 *  prefix, so nothing a person could type into a form collides with it. */
export const AUTO_FILLED = "\u0000auto-filled";

/** What an auto-derived field contributes to the fingerprint: nothing while it
 *  is still the form's own doing, its real value once the operator has taken it
 *  over. `touched` is the same flag the form already keeps in order to stop
 *  overwriting a hand-edited field — one source of truth for "this is theirs
 *  now", so the two can never disagree. */
export function autoFilled(touched: boolean, value: unknown): unknown {
  return touched ? value : AUTO_FILLED;
}

/** The fingerprint itself. Compared as a whole, BY VALUE — two objects that
 *  read the same are the same, whoever built them.
 *
 *  `key` is dropped: React list identities are regenerated on every open (a
 *  stay row gets a fresh one each time), so they describe the render and never
 *  the content. Leaving them in would make every form dirty the moment it
 *  opened, which is the same defect this module exists to end. */
export function formFingerprint(fields: readonly unknown[]): string {
  return JSON.stringify(fields, (k, v) => (k === "key" ? undefined : v));
}
