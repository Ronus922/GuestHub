"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Icon } from "@/components/shared/Icon";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { loginAction, type LoginState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      <Icon name="login" size={20} />
      {pending ? "מתחבר…" : "כניסה"}
    </button>
  );
}

export function LoginForm({ initialError }: { initialError?: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  // Starts Supabase Google OAuth. The callback (/auth/callback) exchanges the code
  // and enforces the guesthub gate (active user + allow_google_auth) server-side.
  async function signInWithGoogle() {
    setGoogleError(null);
    setGoogleLoading(true);
    const supabase = createSupabaseBrowserClient();
    const base = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${base}/auth/callback` },
    });
    if (error) {
      setGoogleError("שגיאה בהתחברות עם Google. נסו שוב.");
      setGoogleLoading(false);
    }
  }

  const errorMessage = state.error ?? googleError ?? initialError;

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {/* אימייל או שם משתמש — .field/.field-label/.field-input (§5) */}
      <div className="field">
        <label htmlFor="identifier" className="field-label">
          אימייל או שם משתמש
        </label>
        <div className="relative">
          <input
            id="identifier"
            name="identifier"
            type="text"
            autoComplete="username"
            dir="ltr"
            placeholder="name@hotel.co.il"
            className="field-input ps-4 pe-11 text-end"
          />
          <Icon
            name="user"
            size={20}
            className="pointer-events-none absolute start-0 top-1/2 ms-3.5 -translate-y-1/2 text-faint"
          />
        </div>
      </div>

      {/* סיסמה */}
      <div className="field">
        <div className="flex items-center justify-between">
          <label htmlFor="password" className="field-label">
            סיסמה
          </label>
          <a href="#" className="t-label text-primary hover:text-primary-dark">
            שכחת סיסמה?
          </a>
        </div>
        <div className="relative">
          <Icon
            name="lock"
            size={20}
            className="pointer-events-none absolute start-0 top-1/2 ms-3.5 -translate-y-1/2 text-faint"
          />
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            className="field-input ps-11 pe-11 text-start"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="icon-btn absolute end-0 top-1/2 me-1 -translate-y-1/2"
          >
            <Icon
              name={showPassword ? "eye-off" : "eye"}
              size={20}
              label={showPassword ? "הסתר סיסמה" : "הצג סיסמה"}
            />
          </button>
        </div>
      </div>

      {/* זכור אותי */}
      <label className="flex items-center gap-2 text-sm text-text2 select-none">
        <input
          type="checkbox"
          name="remember"
          defaultChecked
          className="h-4 w-4 rounded-[7px] accent-primary"
        />
        זכור אותי במכשיר זה
      </label>

      {errorMessage ? (
        <p
          role="alert"
          className="rounded-xl bg-status-danger-050 px-4 py-3 text-sm font-semibold text-status-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      <SubmitButton />

      {/* מפריד */}
      <div className="t-label flex items-center gap-3 text-faint">
        <span className="h-px flex-1 bg-line" />
        או
        <span className="h-px flex-1 bg-line" />
      </div>

      {/* Google — the provider's REAL brand mark, not a Material glyph: §10 governs
          the icon set, and Google's sign-in branding requires the multi-colour G */}
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={googleLoading}
        className="btn btn-secondary w-full"
      >
        <GoogleGlyph />
        {googleLoading ? "מפנה ל-Google…" : "התחבר עם Google"}
      </button>

      <p className="text-center text-sm text-muted">
        אין לך חשבון?{" "}
        <a href="#" className="font-semibold text-primary hover:text-primary-dark">
          התחל ניסיון חינם
        </a>
      </p>
    </form>
  );
}

// Google's official multi-colour "G". A genuine external-provider logo is the one
// §10 exception — it must keep its own brand colours, so the hex values below are
// Google's, not GuestHub tokens, and the <svg> stays outside the <Icon> mapper.
function GoogleGlyph() {
  return (
    // ds-allow: external-provider logo (§10)
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      {/* ds-allow: external-provider logo (§10) */}
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      {/* ds-allow: external-provider logo (§10) */}
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      {/* ds-allow: external-provider logo (§10) */}
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      {/* ds-allow: external-provider logo (§10) */}
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
