"use client";

import { useState, useTransition } from "react";
import { Icon, type IconName } from "@/components/shared/Icon";
import { testChannexConnectionAction, type ChannexConnectionView } from "@/lib/channel/admin";
import { ChannexKeyReplacementForm } from "./ChannexKeyReplacementForm";

// Channex STAGING connection card (D59) — super_admin only (the page already
// gates on canManageChannels). The key is never sent back here; only the masked
// hint + sanitized status are shown.
//
// D70: the api-key input is NO LONGER permanently mounted. It used to be the only
// `type="password"` field on /channels, so the browser's password manager filled
// its saved credential for this origin into it on every page load (Chrome and
// Firefox ignore `autocomplete="off"` on password fields). The masked hint is now
// plain read-only text, and the replacement field exists only after an explicit
// "החלפת מפתח API" click — see ./ChannexKeyReplacementForm.
//
// "בדיקת חיבור" takes NO argument: it always decrypts and uses the STORED key
// server-side. Nothing typed into the replacement form can reach it.

const dtFmt = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});
const fmt = (v: string | null) => (v ? dtFmt.format(new Date(v)) : "—");

type Status = "not_configured" | "configured" | "testing" | "connected" | "failed";

function deriveStatus(v: ChannexConnectionView, testing: boolean): Status {
  if (testing) return "testing";
  if (!v.configured) return "not_configured";
  if (v.state === "ready" || v.lastTestOkAt) return "connected";
  if (v.state === "error" || v.lastTestErrorCode) return "failed";
  return "configured";
}

// §3 — one chip anatomy; the tone comes from the §3.1 triplets only.
const STATUS_META: Record<Status, { label: string; cls: string; icon: IconName }> = {
  not_configured: { label: "לא מוגדר", cls: "chip-cancelled", icon: "info" },
  configured: { label: "מוגדר — טרם נבדק", cls: "chip-approval", icon: "info" },
  testing: { label: "בודק…", cls: "chip-transfer", icon: "refresh" },
  connected: { label: "מחובר", cls: "chip-paid", icon: "shield-check" },
  failed: { label: "החיבור נכשל", cls: "chip-failed", icon: "warning" },
};

export function ChannexStagingSection({ initial }: { initial: ChannexConnectionView }) {
  const [view, setView] = useState(initial);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);

  // The replacement field is mounted ONLY while this is true. `mountId` forces a
  // brand-new component instance on every open, so a remount can never inherit a
  // previous value — not even React's.
  const [replacing, setReplacing] = useState(false);
  const [mountId, setMountId] = useState(0);

  const status = deriveStatus(view, testing);
  const meta = STATUS_META[status];

  function openReplace() {
    setMsg(null);
    setMountId((n) => n + 1);
    setReplacing(true);
  }

  // Unmounting destroys the child's state — the unsaved value is gone.
  function closeReplace() {
    setReplacing(false);
  }

  function onSaved(hint: string) {
    setReplacing(false); // unmount: the new secret is never rendered again
    setView((v) => ({
      ...v,
      configured: true,
      apiKeyHint: hint,
      state: "configured",
      lastTestOkAt: null,
      lastTestFailedAt: null,
      lastTestErrorCode: null,
      lastError: null,
    }));
    setMsg({ tone: "ok", text: "המפתח נשמר ואומת מול Channex" });
  }

  function onTest() {
    setMsg(null);
    setTesting(true);
    startTransition(async () => {
      const res = await testChannexConnectionAction();
      setTesting(false);
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      const nowIso = new Date().toISOString();
      if (res.data!.ok) {
        setView((v) => ({ ...v, state: "ready", lastTestOkAt: nowIso, lastTestErrorCode: null, lastError: null }));
        setMsg({ tone: "ok", text: `מחובר — ${res.data!.propertyCount} נכסים נגישים` });
      } else {
        setView((v) => ({
          ...v,
          state: "error",
          lastTestFailedAt: nowIso,
          lastTestErrorCode: res.data!.category ?? null,
          lastError: res.data!.message ?? null,
        }));
        setMsg({ tone: "err", text: res.data!.message ?? "החיבור נכשל" });
      }
    });
  }

  return (
    <section className="card">
      <div className="card-hd justify-between">
        <div className="flex items-center gap-2">
          <span className="h4">חיבור Channex</span>
          <span className="chip chip-approval">Staging</span>
        </div>
        <span className={`chip ${meta.cls}`}>
          <Icon name={meta.icon} size={13.5} />
          {meta.label}
        </span>
      </div>

      <div className="card-bd flex flex-col gap-4">
        {/* Sandbox warning — this is NOT the live OTA link */}
        <div className="flex items-start gap-2.5 rounded-xl border border-status-warning bg-status-warning-050 p-3">
          <Icon name="warning" size={17} className="mt-0.5 shrink-0 text-status-warning" />
          <p className="t-label leading-relaxed text-status-warning">
            זהו חיבור לסביבת הבדיקות של Channex (Staging) בלבד. הוא <strong>אינו מחובר</strong> ל-Booking.com
            או ל-Expedia האמיתיים, ואינו משפיע על מלאי, מחירים או הזמנות.
          </p>
        </div>

        {!view.secretsKeyConfigured && (
          <p className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
            מפתח ההצפנה בשרת (CHANNEL_SECRETS_KEY) אינו מוגדר — לא ניתן לשמור מפתח API עד להגדרתו.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <dt className="t-label text-faint">כתובת בסיס</dt>
          <dd className="t-secondary truncate text-text2" title={view.baseUrl}>
            <bdi className="ltr-num font-mono">{view.baseUrl}</bdi>
          </dd>
          <dt className="t-label text-faint">בדיקה מוצלחת אחרונה</dt>
          <dd className="t-secondary text-text2">
            <bdi className="ltr-num">{fmt(view.lastTestOkAt)}</bdi>
          </dd>
          <dt className="t-label text-faint">בדיקה כושלת אחרונה</dt>
          <dd className="t-secondary text-text2">
            <bdi className="ltr-num">{fmt(view.lastTestFailedAt)}</bdi>
          </dd>
        </dl>

        {status === "failed" && view.lastError && (
          <p role="alert" className="t-label rounded-lg bg-status-danger-050 px-3 py-2 text-status-danger">
            {view.lastError}
          </p>
        )}

        {/* The stored key: READ-ONLY TEXT. Never an input, never stars in a value,
            never the key itself — only the safe stored api_key_hint. */}
        <div className="flex flex-col gap-3">
          <p className="t-secondary text-text2">
            {view.configured ? (
              <>
                מפתח API מוגדר: <bdi className="ltr-num font-mono">{view.apiKeyHint}</bdi>
              </>
            ) : (
              "מפתח API לא הוגדר"
            )}
          </p>

          {/* The replacement input does not exist in the DOM until this click. */}
          {!replacing ? (
            <div>
              <button
                type="button"
                onClick={openReplace}
                disabled={!view.secretsKeyConfigured || pending}
                className="btn btn-secondary"
              >
                {view.configured ? "החלפת מפתח API" : "הגדרת מפתח API"}
              </button>
            </div>
          ) : (
            <ChannexKeyReplacementForm
              key={mountId}
              configured={view.configured}
              disabled={!view.secretsKeyConfigured}
              onCancel={closeReplace}
              onSaved={onSaved}
            />
          )}
        </div>

        {/* Test connection */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onTest}
            disabled={!view.configured || pending}
            className="btn btn-secondary"
          >
            <Icon name="refresh" size={20} />
            בדיקת חיבור
          </button>
          {msg && (
            <span
              className={`t-secondary ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}
            >
              {msg.text}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
