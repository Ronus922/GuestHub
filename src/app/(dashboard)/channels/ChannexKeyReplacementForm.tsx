"use client";

import { useState, useTransition } from "react";
import { saveChannexApiKeyAction } from "@/lib/channel/admin";

// ============================================================
// Channex api-key REPLACEMENT form (D70). A separate component on purpose: the
// parent mounts it only after an explicit "החלפת מפתח API" click and unmounts it
// on cancel/success, so React destroys this state — there is nowhere for a stale
// or autofilled value to survive.
//
// WHY IT EXISTS. The old card kept a `type="password"` input permanently mounted
// with `autoComplete="off"`. Chrome and Firefox deliberately IGNORE autocomplete
//="off" on password fields, so the browser's password manager filled its saved
// credential for this origin into the only password field on /channels. The
// value never came from GuestHub — but one click on "החלף מפתח" would have
// overwritten the real Channex key with it.
//
// The defences, strongest first:
//  1. the field does not exist in the DOM until the operator asks for it —
//     password managers fill on page load, so there is nothing to fill;
//  2. `autocomplete="new-password"` tells the browser this is not a login field
//     (managers offer to GENERATE, they do not fill a saved credential);
//  3. a unique, non-generic name/id that no password manager heuristic matches;
//  4. vendor opt-outs (1Password / LastPass / Dashlane) that cost nothing;
//  5. the server verifies the candidate key against Channex BEFORE persisting,
//     so even a filled-and-submitted value can never replace a working key.
//
// Deliberately NOT added: an off-screen decoy input. It is unverifiable here,
// browser-version dependent, and a screen-reader hazard — the four defences
// above are structural. (ponytail: no ceremony we cannot prove works.)
// ============================================================

// Not `password`, `apiKey`, `key`, `secret` or `credential` — every one of those
// is a password-manager fill heuristic.
const FIELD_NAME = "channex-api-key-replacement-value";

export function ChannexKeyReplacementForm({
  configured,
  disabled,
  onCancel,
  onSaved,
}: {
  configured: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSaved: (hint: string) => void;
}) {
  // Always starts empty. Nothing seeds it: no prop, no defaultValue, no effect.
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = value.trim();

  function cancel() {
    setValue(""); // clear before the parent unmounts us
    setError(null);
    onCancel();
  }

  // Save happens ONLY from this explicit submit — a browser that fills the field
  // cannot submit it, and the button stays disabled while it is empty.
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await saveChannexApiKeyAction({ apiKey: trimmed });
      if (!res.success) {
        setError(res.error);
        return; // the previous key is untouched; the form stays open to retry
      }
      const hint = `••••${trimmed.slice(-4)}`;
      setValue("");
      onSaved(hint);
    });
  }

  return (
    <form
      name="channex-api-key-replacement"
      autoComplete="off"
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-line bg-hover p-4"
    >
      <label htmlFor={FIELD_NAME} className="text-sm font-semibold text-text2">
        {configured ? "מפתח API חדש" : "מפתח API"}
      </label>

      <input
        id={FIELD_NAME}
        name={FIELD_NAME}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="user-api-key מ-Channex"
        disabled={disabled || pending}
        aria-describedby="channex-key-help"
        className="bw-fld min-w-[240px] flex-1 px-3 py-2 disabled:opacity-60"
        dir="ltr"
      />

      <p id="channex-key-help" className="text-xs text-muted">
        המפתח נשמר מוצפן, נבדק מול Channex לפני השמירה, ולא יוצג שוב לאחר מכן.
      </p>

      {error && (
        <p role="alert" className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={disabled || pending || trimmed === ""}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {pending ? "בודק ושומר…" : configured ? "שמור מפתח חדש" : "שמור מפתח"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={pending}
          className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-text2 transition hover:bg-surface disabled:opacity-50"
        >
          ביטול
        </button>
      </div>
    </form>
  );
}
