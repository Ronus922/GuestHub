"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/shared/Icon";
import {
  setActiveProviderAction,
  type ProviderChoice,
  type SelectableProvider,
} from "@/lib/channel/provider-admin";

// D79 — the ONE working provider. Radio semantics (exactly one), beds24 is
// listed first and is the default. Switching stops the dormant provider's
// sync/import at the worker+webhook level, not just visually.

const PROVIDER_META: Record<SelectableProvider, { title: string; note: string }> = {
  beds24: { title: "Beds24", note: "ברירת המחדל — הספק העובד" },
  hospitable: { title: "Hospitable", note: "גיבוי — מחובר, רדום" },
  channex: { title: "Channex", note: "גיבוי — מוסתר" },
};

export function ProviderSelectorSection({ initial }: { initial: ProviderChoice[] }) {
  const [choices, setChoices] = useState(initial);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function onPick(provider: SelectableProvider) {
    const current = choices.find((c) => c.isActive)?.provider;
    if (provider === current || pending) return;
    setMsg(null);
    startTransition(async () => {
      const res = await setActiveProviderAction({ provider });
      if (!res.success) {
        setMsg({ tone: "err", text: res.error });
        return;
      }
      setChoices((prev) => prev.map((c) => ({ ...c, isActive: c.provider === provider })));
      setMsg({
        tone: "ok",
        text: `${PROVIDER_META[provider].title} הוא כעת הספק הפעיל — שאר הספקים רדומים`,
      });
    });
  }

  return (
    <div className="card">
      <div className="card-hd flex items-center gap-2">
        <Icon name="channels" size={18} className="text-muted" />
        <h2 className="h3">ספק פעיל</h2>
      </div>
      <div className="card-bd flex flex-col gap-3">
        <p className="t-secondary">
          ספק <strong>אחד</strong> עובד בכל רגע — מסנכרן מחירים ומייבא הזמנות. השאר נשארים
          מחוברים כגיבוי רדום (לא דוחפים, לא מייבאים).
        </p>
        <div className="flex flex-col gap-2">
          {choices.map((c) => (
            <label
              key={c.provider}
              className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors ${
                c.isActive ? "border-primary bg-primary-050" : "border-line hover:bg-hover"
              }`}
            >
              <input
                type="radio"
                name="active-provider"
                checked={c.isActive}
                onChange={() => onPick(c.provider)}
                disabled={pending}
                className="h-4 w-4 accent-[var(--primary,#4f46e5)]"
              />
              <span className="font-bold text-ink">{PROVIDER_META[c.provider].title}</span>
              <span className="t-label text-muted">{PROVIDER_META[c.provider].note}</span>
              {c.isActive && (
                <span className="chip chip-paid me-auto">
                  <span className="dot" />
                  פעיל
                </span>
              )}
            </label>
          ))}
        </div>
        {msg && (
          <p
            className={`t-label rounded-lg px-3 py-2 ${
              msg.tone === "ok"
                ? "bg-status-success-050 text-status-success"
                : "bg-status-danger-050 text-status-danger"
            }`}
          >
            {msg.text}
          </p>
        )}
      </div>
    </div>
  );
}
