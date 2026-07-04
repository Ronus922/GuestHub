import "server-only";
import { createClient } from "@supabase/supabase-js";

// Service-role Supabase client for admin auth operations (create/delete/ban users).
// SERVER ONLY — never import from a client component. Reaches GoTrue via the local
// Kong gateway (SUPABASE_ADMIN_URL) so seeding/admin calls don't depend on external DNS.
export function createSupabaseAdminClient() {
  return createClient(
    process.env.SUPABASE_ADMIN_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
