import { sql } from "@/lib/db";
import {
  resolveBusinessProfile,
  type BusinessProfile,
  type StoredBusinessProfile,
} from "@/lib/business/profile";

// Canonical, tenant-scoped server accessor for the Business Profile. THE single
// read path for business/property identity — every consumer (settings screen,
// /channels display, Channex PUT, guest-facing PDFs/messaging) reads through
// here instead of touching tenants.name or channex_profile JSON directly. The
// profile is stored in tenants.settings->'business_profile'; canonical currency/
// timezone come from the tenant columns and are merged in by resolve*.

type TenantProfileRow = {
  name: string;
  currency: string;
  timezone: string;
  business_profile: StoredBusinessProfile | null;
};

export async function getBusinessProfile(tenantId: string): Promise<BusinessProfile | null> {
  const [row] = await sql<TenantProfileRow[]>`
    SELECT name, currency, timezone, settings->'business_profile' AS business_profile
    FROM guesthub.tenants WHERE id = ${tenantId}`;
  if (!row) return null;
  return resolveBusinessProfile(
    { tenantId, currency: row.currency, timezone: row.timezone, fallbackName: row.name },
    row.business_profile,
  );
}

// The public display name of the accommodation for guest-facing surfaces
// (PDFs, confirmations, messaging sender). Falls back to the tenant name — never
// to the literal application name "GuestHub". Safe to call for any tenant.
export async function getPublicPropertyName(tenantId: string, fallback: string): Promise<string> {
  const p = await getBusinessProfile(tenantId);
  return p?.publicPropertyName ?? fallback;
}
