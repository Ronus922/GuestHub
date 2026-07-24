"use client";

import { useState, useTransition } from "react";
import { setupBeds24Action } from "@/lib/channel/beds24-admin";

// ============================================================
// Beds24 INVITE-CODE form — mirror of HospitableKeyReplacementForm (D77 → D78).
// The parent mounts it only after an explicit "הגדרת חיבור" click and unmounts
// it on cancel/success, so React destroys this state — there is nowhere for a
// stale or autofilled value to survive.
//
// The invite code is SINGLE-USE: the server exchanges it once for a refresh
// token (stored encrypted) and the code itself is never stored, audited or
// displayable again. Same defences as the Channex/Hospitable forms:
//  1. the field does not exist in the DOM until the operator asks for it;
//  2. `autocomplete="new-password"` — managers offer to GENERATE, not fill;
//  3. a unique, non-generic name/id no password-manager heuristic matches;
//  4. vendor opt-outs (1Password / LastPass / Dashlane) that cost nothing.
// ============================================================

// Not `password`, `apiKey`, `key`, `secret` or `credential` — every one of those
// is a password-manager fill heuristic.
const FIELD_NAME = "beds24-invite-code-exchange-value";

export function Beds24InviteCodeForm({
  configured,
  disabled,
  onCancel,
  onSaved,
}: {
  configured: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSaved: () => void;
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

  // Exchange happens ONLY from this explicit submit — a browser that fills the
  // field cannot submit it, and the button stays disabled while it is empty.
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await setupBeds24Action({ inviteCode: trimmed });
      if (!res.success) {
        setError(res.error);
        return; // the previous credential is untouched; the form stays open to retry
      }
      setValue("");
      onSaved();
    });
  }

  return (
    <form
      name="beds24-invite-code-exchange"
      autoComplete="off"
      onSubmit={submit}
      className="field rounded-xl border border-line bg-hover p-4"
    >
      <label htmlFor={FIELD_NAME} className="field-label">
        {configured ? "קוד הזמנה חדש (invite code)" : "קוד הזמנה (invite code)"}
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
        placeholder="Invite Code מ-Beds24"
        disabled={disabled || pending}
        aria-describedby="beds24-invite-help"
        className="field-input ltr-num min-w-[240px]"
        dir="ltr"
      />

      <p id="beds24-invite-help" className="field-hint">
        מפיקים את הקוד בממשק Beds24: SETTINGS &gt; MARKETPLACE &gt; API &gt; generate
        invite code. הקוד חד-פעמי — הוא מוחלף מיד בטוקן רענון שנשמר מוצפן, ולא
        נשמר או יוצג שוב.
      </p>

      {error && (
        <p role="alert" className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={disabled || pending || trimmed === ""}
          className="btn btn-primary"
        >
          {pending ? "מחליף…" : configured ? "החלפת חיבור" : "הגדרת חיבור"}
        </button>
        <button type="button" onClick={cancel} disabled={pending} className="btn btn-secondary">
          ביטול
        </button>
      </div>
    </form>
  );
}
