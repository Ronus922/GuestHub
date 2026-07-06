// Runnable checks for the payment LEDGER + canonical balance semantics (D52
// §6/§7/§9). Source-level assertions that:
//   * the payments ledger is authoritative — paid_amount/balance are recomputed
//     from SUM(amount) FILTER (WHERE status='paid'), never incremented in place;
//   * every payment-moving action reconciles via recomputePaymentAggregates;
//   * the balance is NEVER floored on a display surface — a credit shows as a
//     credit through the ONE shared formatBalance() (calendar tooltip + panel);
//   * the D52 migrations remove CVV (count-only) and reconcile the ledger.
// No DB required — pure + source. Usage: node scripts/check-payments.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// comment-stripped source (rules are about code, not the notes)
const src = (p) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---- ledger.ts: ONE authoritative derivation, canonical collected status ----
const ledger = src("src/lib/payments/ledger.ts");
assert.ok(/COLLECTED_PAYMENT_STATUS = "paid"/.test(ledger),
  "the canonical collected-money status is 'paid'");
assert.ok(/SUM\(amount\) FILTER \(WHERE status = \$\{COLLECTED_PAYMENT_STATUS\}\)/.test(ledger),
  "paid amount = SUM of ledger rows with the canonical collected status");
assert.ok(/paid_amount = x\.paid/.test(ledger) && /balance = res\.total_price - x\.paid/.test(ledger),
  "paid_amount + balance are DERIVED caches; balance = total - paid (NOT floored)");
assert.ok(!/paid_amount\s*[+\-]=|balance\s*[+\-]=|paid_amount\s*=\s*[^,\n]*paid_amount/.test(ledger),
  "the ledger never increments paid_amount/balance in place (no += / -= / self-reference)");

// ---- reservation actions: every payment-moving path reconciles via the ledger ----
const actions = src("src/app/(dashboard)/reservations/actions.ts");
const cardActions = src("src/app/(dashboard)/reservations/card-actions.ts");
for (const [name, s] of [["actions", actions], ["card-actions", cardActions]]) {
  // no source may set paid_amount from an incremental expression (drift)
  assert.ok(!/paid_amount\s*=\s*[^,\n]*paid_amount/i.test(s),
    `${name}: paid_amount is never computed from its own previous value`);
}
// create + update + external record all call the single recompute
assert.ok((actions.match(/recomputePaymentAggregates\(/g) || []).length >= 2,
  "create AND update reconcile paid/balance via recomputePaymentAggregates");
assert.ok(/recomputePaymentAggregates\(/.test(cardActions),
  "recording an external payment reconciles via recomputePaymentAggregates");
// payments are inserted with the canonical captured status
assert.ok(/INSERT INTO guesthub\.payments[\s\S]*?'paid'/.test(actions),
  "captured payments are inserted with status='paid'");

// ---- calendar tooltip: balance NOT floored; shared formatter (D52 §7) ----
const tooltip = src("src/app/(dashboard)/calendar/ReservationTooltip.tsx");
assert.ok(!/Math\.max\(0,\s*stay\.total_price\s*-\s*stay\.paid_amount\)/.test(tooltip),
  "the calendar tooltip no longer floors a negative balance to zero");
assert.ok(/formatBalance\(stay\.total_price,\s*stay\.paid_amount\)/.test(tooltip),
  "the tooltip balance comes from the shared formatBalance()");

// ---- edit panel: balance tile uses the shared formatter, not a floored calc ----
const editPanel = src("src/components/reservations/EditReservationPanel.tsx");
assert.ok(/formatBalance\(total,\s*paidAfter\)/.test(editPanel),
  "the reservation panel balance/credit comes from the shared formatBalance()");
// the balance TILE renders bal.amount + a credit label — never a floored calc.
// (A residual Math.max(0, total - paidAfter) is the CHARGE amount, which is
// correctly floored — you cannot charge a negative amount.)
assert.ok(/bal\.kind === "credit" \? "זיכוי ללקוח" : "יתרה לתשלום"/.test(editPanel),
  "the balance tile label switches to a customer-credit label on overpayment");
assert.ok(/bal\.kind === "credit" \? "-" : ""}₪\{Math\.round\(bal\.amount\)/.test(editPanel),
  "the balance tile shows the credit amount with a sign, from the shared formatter");

// ---- D52 migrations ----
const m018 = readFileSync("db/migrations/018_remove_stored_cvv.sql", "utf8");
assert.ok(/DROP COLUMN IF EXISTS cvv_encrypted/.test(m018), "018 drops reservation_cards.cvv_encrypted");
assert.ok(/DROP COLUMN IF EXISTS card_cvv_encrypted/.test(m018), "018 drops channel card_cvv_encrypted");
assert.ok(/RAISE NOTICE/.test(m018) && /count\(cvv_encrypted\)/.test(m018),
  "018 records COUNT-only remediation, never a value");
assert.ok(!/SELECT[^;]*cvv_encrypted[^;]*(?<!count\(cvv_encrypted\))\bvalue\b/i.test(m018),
  "018 never selects a raw CVV value");

const m019 = readFileSync("db/migrations/019_payment_status_ledger_reconcile.sql", "utf8");
assert.ok(/UPDATE payments SET status = 'paid'[\s\S]*WHERE status = 'partial'/.test(m019),
  "019 relabels mislabeled 'partial' payment rows to 'paid'");
assert.ok(/CHECK \(status IN \('paid','pending','failed','voided','refunded'\)\)/.test(m019),
  "019 pins payment-row status to the canonical set");
assert.ok(/paid_amount = l\.paid/.test(m019) && /balance\s*=\s*res\.total_price - l\.paid/.test(m019),
  "019 rebuilds paid_amount/balance from the ledger (not floored)");

console.log("check-payments: ledger authority, non-floored balance, and D52 migrations verified ✔");
