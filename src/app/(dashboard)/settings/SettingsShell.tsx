"use client";

import { useQueryState, parseAsStringLiteral } from "nuqs";
import { Icon } from "@/components/shared/Icon";
import { SETTINGS_GROUPS, SETTINGS_SECTION_KEYS, type SettingsSectionKey } from "./sections";
import { VatSection } from "./VatSection";
import { ExtraGuestSection } from "./ExtraGuestSection";
import { CancellationSection } from "./CancellationSection";
import { PaymentSection } from "./PaymentSection";
import type { ExtraGuestView, CancellationPolicyView, PaymentPolicyView, PaymentMethodRef } from "./types";

// Two-pane settings shell (approved design): right-hand grouped nav + content
// pane. The active section lives in ?section= so it is linkable and survives a
// refresh. Data is loaded server-side (page.tsx) and passed down.
export function SettingsShell({
  tenantName,
  currency,
  vatRate,
  extraGuest,
  cancellationPolicies,
  paymentPolicies,
  paymentMethods,
}: {
  tenantName: string;
  currency: string;
  vatRate: number;
  extraGuest: ExtraGuestView;
  cancellationPolicies: CancellationPolicyView[];
  paymentPolicies: PaymentPolicyView[];
  paymentMethods: PaymentMethodRef[];
}) {
  const [section, setSection] = useQueryState(
    "section",
    parseAsStringLiteral(SETTINGS_SECTION_KEYS).withDefault("vat"),
  );

  return (
    <div className="flex flex-col gap-5 p-[26px]" dir="rtl">
      <div>
        <h1 className="text-2xl font-extrabold text-ink">הגדרות</h1>
        <p className="mt-1 text-sm font-semibold text-muted">
          {tenantName} · ניהול ערכים, סטטוסים וברירות מחדל של המערכת
        </p>
      </div>

      <div className="flex flex-col gap-5 lg:flex-row-reverse lg:items-start">
        {/* right-hand settings navigation */}
        <nav className="shrink-0 rounded-2xl border border-line bg-surface p-3 lg:w-[280px]" aria-label="ניווט הגדרות">
          {SETTINGS_GROUPS.map((group) => (
            <div key={group.title} className="mb-3 last:mb-0">
              <p className="px-3 pb-1 text-[11px] font-bold tracking-wide text-faint">{group.title}</p>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <SettingsNavRow
                      active={section === item.key}
                      icon={item.icon}
                      label={item.label}
                      onClick={() => setSection(item.key)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* content pane */}
        <div className="min-w-0 flex-1">
          <SectionBody
            section={section}
            currency={currency}
            vatRate={vatRate}
            extraGuest={extraGuest}
            cancellationPolicies={cancellationPolicies}
            paymentPolicies={paymentPolicies}
            paymentMethods={paymentMethods}
          />
        </div>
      </div>
    </div>
  );
}

function SettingsNavRow({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-sm transition-colors ${
        active ? "bg-primary-050 font-semibold text-primary" : "text-text2 hover:bg-hover"
      }`}
    >
      {active && <span className="pointer-events-none absolute inset-y-2 start-0 w-1 rounded-full bg-primary" />}
      <Icon name={icon} size={20} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function SectionBody({
  section,
  currency,
  vatRate,
  extraGuest,
  cancellationPolicies,
  paymentPolicies,
  paymentMethods,
}: {
  section: SettingsSectionKey;
  currency: string;
  vatRate: number;
  extraGuest: ExtraGuestView;
  cancellationPolicies: CancellationPolicyView[];
  paymentPolicies: PaymentPolicyView[];
  paymentMethods: PaymentMethodRef[];
}) {
  switch (section) {
    case "vat":
      return <VatSection vatRate={vatRate} />;
    case "extra-guest":
      return <ExtraGuestSection value={extraGuest} currency={currency} vatRate={vatRate} />;
    case "cancellation":
      return <CancellationSection policies={cancellationPolicies} />;
    case "payment":
      return <PaymentSection policies={paymentPolicies} methods={paymentMethods} />;
  }
}
