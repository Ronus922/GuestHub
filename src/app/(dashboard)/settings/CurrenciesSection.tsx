"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { updateEnabledCurrenciesAction } from "./actions";
import { SettingsCard } from "./controls";

// המטבעות המופעלים להזמנות (D107): settings.enabled_currencies. The base
// property currency is fixed (rate tables + Beds24 publish in it); enabling
// another currency lets a reservation be PRICED in it — with a manual price
// on every room, enforced server-side. No conversion happens anywhere.
export function CurrenciesSection({
  baseCurrency,
  enabled,
}: {
  baseCurrency: string;
  enabled: string[];
}) {
  const [list, setList] = useState<string[]>(enabled);
  const [draft, setDraft] = useState("");
  const [saving, startSaving] = useTransition();
  const valid = /^[A-Za-z]{3}$/.test(draft.trim());

  const persist = (next: string[]) =>
    startSaving(async () => {
      const res = await updateEnabledCurrenciesAction(next);
      if (res.success) {
        setList([...new Set([baseCurrency, ...next])]);
        toast.success("רשימת המטבעות נשמרה");
      } else toast.error(res.error);
    });

  return (
    <div className="mt-6 max-w-xl">
      <SettingsCard icon="finance" title="מטבעות להזמנות">
        <p className="text-sm text-muted">
          מטבע הנכס הוא <b className="ltr-num">{baseCurrency}</b> — טבלאות התעריפים והערוצים
          עובדים בו תמיד. הזמנה במטבע מופעל אחר דורשת מחיר ידני לכל חדר, ואינה מומרת.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {list.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-field px-3 py-1.5 text-sm font-semibold"
            >
              <span className="ltr-num">{c}</span>
              {c !== baseCurrency && (
                <button
                  type="button"
                  aria-label={`הסרת ${c}`}
                  className="text-muted hover:text-status-danger"
                  disabled={saving}
                  onClick={() => persist(list.filter((x) => x !== c))}
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <input
            className="field-input ltr-num w-28 text-center uppercase"
            placeholder="USD"
            maxLength={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="קוד מטבע להוספה"
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !valid || list.includes(draft.trim().toUpperCase())}
            onClick={() => {
              persist([...list, draft.trim().toUpperCase()]);
              setDraft("");
            }}
          >
            הוספה
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}
