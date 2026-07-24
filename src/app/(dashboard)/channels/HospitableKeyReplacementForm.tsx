"use client";

import { useState, useTransition } from "react";
import { saveHospitableApiKeyAction } from "@/lib/channel/hospitable-admin";

// ============================================================
// Hospitable PAT REPLACEMENT form — mirror of ChannexKeyReplacementForm (D70).
// The parent mounts it only after an explicit "החלפת טוקן PAT" click and
// unmounts it on cancel/success, so React destroys this state — there is
// nowhere for a stale or autofilled value to survive.
//
// Same defences as the Channex form, strongest first:
//  1. the field does not exist in the DOM until the operator asks for it;
//  2. `autocomplete="new-password"` — managers offer to GENERATE, not fill;
//  3. a unique, non-generic name/id no password-manager heuristic matches;
//  4. vendor opt-outs (1Password / LastPass / Dashlane) that cost nothing.
// ============================================================

// Not `password`, `apiKey`, `key`, `secret` or `credential` — every one of those
// is a password-manager fill heuristic.
const FIELD_NAME = "hospitable-pat-replacement-value";

export function HospitableKeyReplacementForm({
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
      const res = await saveHospitableApiKeyAction({ apiKey: trimmed });
      if (!res.success) {
        setError(res.error);
        return; // the previous token is untouched; the form stays open to retry
      }
      const hint = `••••${trimmed.slice(-4)}`;
      setValue("");
      onSaved(hint);
    });
  }

  return (
    <form
      name="hospitable-pat-replacement"
      autoComplete="off"
      onSubmit={submit}
      className="field rounded-xl border border-line bg-hover p-4"
    >
      <label htmlFor={FIELD_NAME} className="field-label">
        {configured ? "טוקן PAT חדש" : "טוקן PAT"}
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
        placeholder="Personal Access Token מ-Hospitable"
        disabled={disabled || pending}
        aria-describedby="hospitable-pat-help"
        className="field-input ltr-num min-w-[240px]"
        dir="ltr"
      />

      <p id="hospitable-pat-help" className="field-hint">
        הטוקן נשמר מוצפן ולא יוצג שוב לאחר מכן. תוקפו (שנה מרגע ההנפקה) מפוענח
        אוטומטית ומוצג בכרטיס החיבור.
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
          {pending ? "שומר…" : configured ? "שמור טוקן חדש" : "שמור טוקן"}
        </button>
        <button type="button" onClick={cancel} disabled={pending} className="btn btn-secondary">
          ביטול
        </button>
      </div>
    </form>
  );
}
