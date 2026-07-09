"use client";

import { useState, useTransition } from "react";
import { Icon, type IconName } from "@/components/shared/Icon";
import {
  saveChannexApiKeyAction,
  testChannexConnectionAction,
  type ChannexConnectionView,
} from "@/lib/channel/admin";

// Channex STAGING connection card (D59) — super_admin only (the page already
// gates on canManageChannels). Lets the operator save/replace the api-key and
// run a real server-side "Test connection". The key is never sent back here;
// only the masked hint + sanitized status are shown.

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

const STATUS_META: Record<Status, { label: string; cls: string; icon: IconName }> = {
  not_configured: { label: "לא מוגדר", cls: "bg-hover text-muted", icon: "info" },
  configured: { label: "מוגדר — טרם נבדק", cls: "bg-status-warning-050 text-status-warning", icon: "info" },
  testing: { label: "בודק…", cls: "bg-primary-050 text-primary", icon: "refresh" },
  connected: { label: "מחובר", cls: "bg-status-success-050 text-status-success", icon: "shield-check" },
  failed: { label: "החיבור נכשל", cls: "bg-status-danger-050 text-status-danger", icon: "warning" },
};

export function ChannexStagingSection({ initial }: { initial: ChannexConnectionView }) {
  const [view, setView] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);

  const status = deriveStatus(view, testing);
  const meta = STATUS_META[status];

  function onSave() {
    setMsg(null);
    startTransition(async () => {
      const res = await saveChannexApiKeyAction({ apiKey });
      if (!res.success) return setMsg({ tone: "err", text: res.error });
      const hint = `••••${apiKey.trim().slice(-4)}`;
      setApiKey("");
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
      setMsg({ tone: "ok", text: "המפתח נשמר" });
    });
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
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-ink">חיבור Channex</h2>
          <span className="rounded-full bg-status-warning-050 px-2 py-0.5 text-xs font-bold text-status-warning">
            Staging
          </span>
        </div>
        <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${meta.cls}`}>
          <Icon name={meta.icon} size={14} />
          {meta.label}
        </span>
      </div>

      {/* Sandbox warning — this is NOT the live OTA link */}
      <div className="flex items-start gap-2.5 rounded-xl border border-status-warning bg-status-warning-050 p-3">
        <Icon name="warning" size={18} className="mt-0.5 shrink-0 text-status-warning" />
        <p className="text-xs font-semibold leading-relaxed text-status-warning">
          זהו חיבור לסביבת הבדיקות של Channex (Staging) בלבד. הוא <strong>אינו מחובר</strong> ל-Booking.com
          או ל-Expedia האמיתיים, ואינו משפיע על מלאי, מחירים או הזמנות.
        </p>
      </div>

      {!view.secretsKeyConfigured && (
        <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
          מפתח ההצפנה בשרת (CHANNEL_SECRETS_KEY) אינו מוגדר — לא ניתן לשמור מפתח API עד להגדרתו.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-faint">כתובת בסיס</dt>
        <dd className="truncate font-mono text-xs text-text2" title={view.baseUrl}>{view.baseUrl}</dd>
        <dt className="text-faint">מפתח API</dt>
        <dd className="font-semibold text-text2">{view.apiKeyHint ?? "לא הוגדר"}</dd>
        <dt className="text-faint">בדיקה מוצלחת אחרונה</dt>
        <dd className="font-semibold text-text2">{fmt(view.lastTestOkAt)}</dd>
        <dt className="text-faint">בדיקה כושלת אחרונה</dt>
        <dd className="font-semibold text-text2">{fmt(view.lastTestFailedAt)}</dd>
      </dl>

      {status === "failed" && view.lastError && (
        <p className="rounded-lg bg-status-danger-050 px-3 py-2 text-xs font-semibold text-status-danger">
          {view.lastError}
        </p>
      )}

      {/* Save / replace key */}
      <div className="flex flex-col gap-2">
        <label htmlFor="channex-key" className="text-sm font-semibold text-text2">
          {view.configured ? "החלפת מפתח API" : "מפתח API"}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="channex-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={view.configured ? "הדבק מפתח חדש להחלפה" : "user-api-key מ-Channex"}
            disabled={!view.secretsKeyConfigured || pending}
            className="bw-fld min-w-[240px] flex-1 disabled:opacity-60"
            dir="ltr"
          />
          <button
            type="button"
            onClick={onSave}
            disabled={!view.secretsKeyConfigured || pending || apiKey.trim() === ""}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            {view.configured ? "החלף מפתח" : "שמור מפתח"}
          </button>
        </div>
      </div>

      {/* Test connection */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onTest}
          disabled={!view.configured || pending}
          className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-bold text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="refresh" size={16} />
          בדיקת חיבור
        </button>
        {msg && (
          <span
            className={`text-sm font-semibold ${msg.tone === "ok" ? "text-status-success" : "text-status-danger"}`}
          >
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}
