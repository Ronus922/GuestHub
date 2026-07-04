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
