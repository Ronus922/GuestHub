import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/lib/db";

// Completes the Google OAuth flow: exchanges the PKCE code for a GoTrue session,
// then gates entry by the guesthub layer. Authentication is GoTrue's; authorization
// is ours — auth.users is SHARED by several apps on this instance, so a valid Google
// identity is not enough. Only an active guesthub user whose admin enabled
// allow_google_auth (and who belongs to a real tenant) may enter. Unknown identity,
// flag off and inactive user all collapse into ONE neutral error — the shared auth
// layer must not become an email-existence oracle. No row is ever created here:
// login is authentication only, adoption/creation happens in the staff screen.
// Redirects are built from NEXT_PUBLIC_APP_URL — behind nginx, request.url's origin
// is the internal upstream (127.0.0.1:3007), never send the browser there.
export async function GET(request: NextRequest) {
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const code = new URL(request.url).searchParams.get("code");

  // Cookie writes (session set / sign-out clear) are staged here and bound to
  // whichever redirect we end up returning — same idea as /auth/signout.
  const staged: { name: string; value: string; options: CookieOptions }[] = [];
  const finish = (path: string) => {
    const res = NextResponse.redirect(new URL(path, origin));
    staged.forEach(({ name, value, options }) =>
      res.cookies.set(name, value, options),
    );
    return res;
  };

  if (!code) return finish("/login?error=missing_code");

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          staged.push(...cookiesToSet);
        },
      },
    },
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) return finish("/login?error=exchange_failed");

  // Per-user gate for every external (non-password) provider.
  const provider = data.user.app_metadata?.provider;
  if (provider && provider !== "email") {
    const [allowed] = await sql<{ id: string }[]>`
      SELECT u.id
      FROM guesthub.users u
      JOIN guesthub.tenants t ON t.id = u.tenant_id
      WHERE u.auth_user_id = ${data.user.id}
        AND u.is_active = true
        AND u.allow_google_auth = true
      LIMIT 1`;
    if (!allowed) {
      await supabase.auth.signOut();
      return finish("/login?error=google_not_allowed");
    }
  }

  return finish("/dashboard");
}
