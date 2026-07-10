import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Refreshes the Supabase auth cookie on every request and enforces the two redirect
// rules: unauthenticated → /login, and an authenticated visitor never sees /login.
// Role-based routing (cleaner → /housekeeping/my-tasks) happens in the (dashboard)
// layout, which has DB access; the Edge middleware only knows the auth session.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isLogin = path === "/login";
  // The OAuth callback arrives unauthenticated by definition (the session is only
  // created inside the route by exchangeCodeForSession) — it must stay reachable.
  const isOauthCallback = path === "/auth/callback";
  // Provider status webhooks (Twilio / GREEN-API) are server-to-server POSTs with
  // NO user session. They authenticate via their opaque path token (+ the Twilio
  // signature), so they must bypass the login redirect to reach their handler.
  const isMessagingWebhook = path.startsWith("/api/messaging/webhook/");
  // The Channex booking webhook is the same shape: an unauthenticated
  // server-to-server POST carrying an opaque capability token (hash-compared,
  // rate-limited in the route). Without this bypass every Channex delivery was
  // 307'd to /login and swallowed as a 200 — the D76/D77 "webhook registered
  // but zero events ever received" root cause.
  const isChannelWebhook = path.startsWith("/api/channel/webhook/");

  // Redirect while carrying over any refreshed auth cookies staged on `response`
  // (a fresh NextResponse.redirect would otherwise drop a rotated refresh token).
  const redirectTo = (pathname: string) => {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    url.search = "";
    const res = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => res.cookies.set(c));
    return res;
  };

  if (!user && !isLogin && !isOauthCallback && !isMessagingWebhook && !isChannelWebhook)
    return redirectTo("/login");
  if (user && isLogin) return redirectTo("/");

  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
