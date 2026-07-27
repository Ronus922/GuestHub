#!/usr/bin/env node
// ============================================================
// check:card-save-flow — the V2 card contract (D108/D109 + audit §9 fixes):
//
//   1. Choosing "כרטיס אשראי" OPENS the card fields when nothing usable is
//      stored — one-directional; no method choice ever hides/locks them.
//   2. A card-save failure is VISIBLE where the operator typed (role="alert"),
//      never only a toast (complaint 8: "לא נשמר" without a trace).
//   3. A manual replacement never inherits the previous (channel) card's
//      charge window / provider ref; a channel re-ingest never keeps a stale
//      manual CVV (behavioral twin lives in check:channel-card-ingest).
//   4. הערות חיוב is gone from the card UI (D109) — the content moved to
//      reservation notes by migration 059; the column stays deprecated.
//   5. The notes card sits ABOVE the cancellation-policy card (complaint 11),
//      in the edit panel AND the create flow's step 4.
//
// Static source pins on the tree under test (guard-roots compliant).
// ============================================================
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
console.log(`# tree under test: ${ROOT}`);
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let n = 0;
const ok = (msg) => { n++; console.log(`✓ ${n}. ${msg}`); };

const editPanel = read("src/components/reservations/EditReservationPanel.tsx");
const bookPanel = read("src/components/reservations/BookingPanel.tsx");
const cardFields = read("src/components/reservations/CardFields.tsx");
const cardActions = read("src/app/(dashboard)/reservations/card-actions.ts");
const cardIngest = read("src/lib/channel/card-ingest.ts");
const revisions = read("src/lib/channel/revisions.ts");
const cardRules = read("src/lib/card-rules.ts");
const migration = read("db/migrations/059_billing_notes_to_reservation_notes.sql");

// ---- 1. D108: payment method opens the card fields (never closes them) ----
{
  const sel = editPanel.slice(editPanel.indexOf('Field label="אמצעי תשלום"'));
  const onChange = sel.slice(0, sel.indexOf("</Field>"));
  assert.ok(/credit_card.*&&.*setReplacingCard\(true\)|setReplacingCard\(true\)/s.test(onChange),
    "edit: choosing credit_card enters manual card entry");
  assert.ok(!/setReplacingCard\(false\)/.test(onChange),
    "edit: no method choice ever CLOSES the card section");
  assert.ok(/!cardMeta && !guarantee/.test(onChange),
    "edit: a stored card / channel guarantee is never auto-replaced by a method click");
  assert.ok(/disabled=\{method !== "credit_card"\}|method !== "credit_card"/.test(bookPanel),
    "create: the card fields activate with the credit-card method (§15)");
  ok("D108 — payment method opens card entry; one-directional, stored cards safe");
}

// ---- 2. complaint 8: failure is visible where the operator typed ----
{
  assert.ok(/setCardError\(msg\)/.test(editPanel), "save failure lands in inline state");
  assert.ok(/\{cardError && \(\s*<p role="alert"/.test(editPanel),
    "the failure renders as role=\"alert\" beside the card fields");
  assert.ok(/CARD_VAULT_KEY חסר/.test(cardActions),
    "a missing vault is an explicit operator-facing message, not a swallow");
  ok("card-save failure is loud: inline role=\"alert\" + explicit vault message");
}

// ---- 3. audit §9: stale-window / stale-CVV fixes are pinned in the SQL ----
{
  const upsert = cardActions.slice(cardActions.indexOf("ON CONFLICT (reservation_id)"));
  for (const frag of ["available_from = NULL", "available_until = NULL", "provider_reservation_ref = NULL"]) {
    assert.ok(upsert.includes(frag), `manual replace clears ${frag}`);
  }
  assert.ok(/cvv_encrypted = NULL/.test(cardIngest),
    "channel re-ingest clears a stale manual CVV (card-ingest)");
  assert.ok(/cvv_encrypted = NULL/.test(revisions),
    "staged-card attach clears a stale manual CVV (revisions)");
  ok("a replaced card never inherits the previous card's window, ref or CVV");
}

// ---- 4. D109: הערות חיוב is out of the card UI; migration moves the data ----
{
  assert.ok(!/הערות חיוב <span/.test(cardFields) && !/billingNotes: e\.target\.value/.test(cardFields),
    "CardFields renders no billing-notes textarea");
  assert.ok(!/billingNotes: cc\.billingNotes/.test(editPanel) && !/billingNotes: cc\.billingNotes/.test(bookPanel),
    "neither panel sends billingNotes anymore");
  assert.ok(/\[הערת חיוב\] /.test(migration) && /billing_notes = NULL/.test(migration),
    "migration 059 moves the content into reservation notes and empties the source");
  assert.ok(/position\(/.test(migration), "migration 059 is idempotent (position guard)");
  ok("D109 — billing notes moved to reservation notes; column deprecated, UI gone");
}

// ---- 5. complaint 11: notes ABOVE cancellation policy, both flows ----
{
  const notesIdx = editPanel.indexOf('title="הערות להזמנה"');
  const policyIdx = editPanel.indexOf('title="מדיניות ביטול (בעת ההזמנה)"');
  assert.ok(notesIdx > 0 && policyIdx > 0 && notesIdx < policyIdx,
    "edit: the notes card renders above the cancellation-policy card");
  const createNotes = bookPanel.indexOf('label="הערות להזמנה"');
  const createPolicy = bookPanel.indexOf('title="מדיניות ביטול"');
  assert.ok(createNotes > 0 && createPolicy > 0 && createNotes < createPolicy,
    "create step 4: notes above the cancellation-policy card");
  ok("complaint 11 — notes above cancellation policy in both flows");
}

// ---- 6. the CVV field itself stays (D87) and the mode machine stays pure ----
{
  assert.ok(/CVV/.test(cardFields), "the manual CVV field (D87) still exists");
  assert.ok(/payment method is still NOT an input to THIS resolver/i.test(cardRules) ||
            /NOT an input/i.test(cardRules.slice(cardRules.indexOf("state model"), cardRules.indexOf("resolveCardMode"))),
    "resolveCardMode stays pure — the D108 coupling lives in the UI layer only");
  ok("D87 CVV entry intact; the card-mode machine stays pure");
}

console.log(`\nALL ${n} CARD-SAVE-FLOW CHECKS PASSED`);
