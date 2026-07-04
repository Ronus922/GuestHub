import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client — used only for the auth session (sign-in / sign-out).
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
