import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Clears the Supabase session and returns to /login. Used both by explicit logout
// and as the escape hatch when a valid GoTrue session has no active guesthub user
// (prevents the /login ↔ / redirect loop). Cookies are bound to the redirect response
// so the session-clearing cookies actually reach the browser.
export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  await supabase.auth.signOut();
  return response;
}
