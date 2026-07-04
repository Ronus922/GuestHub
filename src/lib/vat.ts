// Tenant VAT-rate rules (D41): a display-only percentage stored in
// tenants.settings->vat_rate. Pure so the settings action, the booking UI
// and scripts/check-cards.mjs share one definition. Totals stay
// VAT-inclusive; changing the rate never recalculates reservations.

export const VAT_MIN = 0;
export const VAT_MAX = 50;
export const DEFAULT_VAT_RATE = 18;

// Accepts a percentage (number or numeric string), up to two decimals,
// within [VAT_MIN, VAT_MAX]. Returns null for anything invalid.
export function parseVatRate(input: unknown): number | null {
  const n =
    typeof input === "number"
      ? input
      : typeof input === "string" && input.trim() !== ""
        ? Number(input.trim())
        : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < VAT_MIN || n > VAT_MAX) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded !== n) return null; // more than two decimals
  return rounded;
}

// "18" / "17.5" — no unnecessary trailing zeros
export function formatVatRate(rate: number): string {
  return String(Math.round(rate * 100) / 100);
}

// the VAT portion already INCLUDED in a gross total at the given rate
export function includedVatAmount(grossTotal: number, rate: number): number {
  if (rate <= 0) return 0;
  return Math.round(grossTotal - grossTotal / (1 + rate / 100));
}
