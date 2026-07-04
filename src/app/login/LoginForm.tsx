"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Icon } from "@/components/shared/Icon";
import { loginAction, type LoginState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary w-full" disabled={pending}>
      <Icon name="login" size={18} />
      {pending ? "מתחבר…" : "כניסה"}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const [googleNote, setGoogleNote] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {/* אימייל או שם משתמש */}
      <div className="flex flex-col gap-2">
        <label htmlFor="identifier" className="text-sm font-medium text-text2">
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
            className="field text-right ps-4 pe-11"
          />
          <Icon
            name="user"
            size={18}
            className="pointer-events-none absolute start-0 top-1/2 -translate-y-1/2 ms-3.5 text-faint"
          />
        </div>
      </div>

      {/* סיסמה */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label htmlFor="password" className="text-sm font-medium text-text2">
            סיסמה
          </label>
          <a
            href="#"
            className="text-sm font-medium text-primary hover:text-primary-dark"
          >
            שכחת סיסמה?
          </a>
        </div>
        <div className="relative">
          <Icon
            name="lock"
            size={18}
            className="pointer-events-none absolute start-0 top-1/2 -translate-y-1/2 ms-3.5 text-faint"
          />
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            className="field ps-11 pe-11 text-right"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "הסתר סיסמה" : "הצג סיסמה"}
            className="absolute end-0 top-1/2 -translate-y-1/2 me-2 grid h-11 w-11 place-items-center rounded-lg text-faint hover:text-muted"
          >
            <Icon name={showPassword ? "eye-off" : "eye"} size={18} />
          </button>
        </div>
      </div>

      {/* זכור אותי */}
      <label className="flex items-center gap-2 text-sm text-text2 select-none">
        <input
          type="checkbox"
          name="remember"
          defaultChecked
          className="h-4 w-4 rounded accent-primary"
        />
        זכור אותי במכשיר זה
      </label>

      {state.error ? (
        <p className="rounded-lg bg-status-danger-050 px-4 py-2.5 text-sm text-status-danger">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />

      {/* מפריד */}
      <div className="flex items-center gap-3 text-xs text-faint">
        <span className="h-px flex-1 bg-line" />
        או
        <span className="h-px flex-1 bg-line" />
      </div>

      {/* Google */}
      <button
        type="button"
        onClick={() => setGoogleNote(true)}
        className="btn btn-outline w-full"
      >
        <GoogleGlyph />
        התחבר עם Google
      </button>
      {googleNote ? (
        <p className="-mt-2 text-center text-xs text-faint">
          התחברות Google תופעל בשלב הבא
        </p>
      ) : null}

      <p className="text-center text-sm text-muted">
        אין לך חשבון?{" "}
        <a href="#" className="font-semibold text-primary hover:text-primary-dark">
          התחל ניסיון חינם
        </a>
      </p>
    </form>
  );
}

// Google multi-color "G" — inline SVG (self-contained, no external asset).
function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
