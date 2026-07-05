import { sql } from "@/lib/db";
import { DEFAULT_VAT_RATE, parseVatRate } from "@/lib/vat";

// Tenant-level business settings live in guesthub.tenants.settings (jsonb).
// One reader per setting keeps callers honest about defaults (D41).

export async function getTenantVatRate(tenantId: string): Promise<number> {
  const [row] = await sql<{ vat_rate: string | null }[]>`
    SELECT settings->>'vat_rate' AS vat_rate
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  return parseVatRate(row?.vat_rate) ?? DEFAULT_VAT_RATE;
}

// Canonical property currency (tenants.currency). Commercial modules REFERENCE
// this — they never store their own currency.
export async function getTenantCurrency(tenantId: string): Promise<string> {
  const [row] = await sql<{ currency: string }[]>`
    SELECT currency FROM guesthub.tenants WHERE id = ${tenantId}`;
  return row?.currency ?? "ILS";
}
