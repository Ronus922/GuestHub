"use client";

import { useQueryState, parseAsStringLiteral } from "nuqs";
import { Icon } from "@/components/shared/Icon";
import { SETTINGS_GROUPS, SETTINGS_SECTION_KEYS, type SettingsSectionKey } from "./sections";
import { VatSection } from "./VatSection";
import { CurrenciesSection } from "./CurrenciesSection";
import { ExtraGuestSection } from "./ExtraGuestSection";
import { CancellationSection } from "./CancellationSection";
import { PaymentSection } from "./PaymentSection";
import { MessagingSection } from "./MessagingSection";
import { TTLockSection } from "./TTLockSection";
import { BusinessProfileSection } from "./BusinessProfileSection";
import { WorkflowStatusSection } from "./WorkflowStatusSection";
import { CheckInCheckOutSection } from "./CheckInCheckOutSection";
import type { CheckInCheckOutSettings } from "@/lib/check-in-check-out";
import type { BusinessProfileContext } from "./business-actions";
import type { WorkflowStatusDef } from "./status-actions";
import type { PaymentMethodDef } from "./payment-method-actions";
import type {
  ExtraGuestView,
  CancellationPolicyView,
  MessagingSettingsView,
  TTLockSettingsView,
} from "./types";

// Two-pane settings shell (approved design "הגדרות - פרופיל העסק.dc.html", D175):
// a 256px right-hand grouped nav card, sticky, next to the content pane; one
// column with the nav above the content under 1120px; the compact select on a
// phone. The active section lives in ?section= so it is linkable and survives a
// refresh. Data is loaded server-side (page.tsx) and passed down.
export function SettingsShell({
  propertyIdentity,
  businessProfile,
  currency,
  vatRate,
  checkInCheckOut,
  extraGuest,
  cancellationPolicies,
  paymentMethodDefs,
  canManageMessaging,
  messaging,
  canManageTTLock,
  ttlock,
  workflowStatuses,
  enabledCurrencies,
}: {
  /** canonical Business Profile identity line (formatPropertyIdentity) — never
   *  the internal tenants.name label */
  propertyIdentity: string;
  businessProfile: BusinessProfileContext | null;
  currency: string;
  enabledCurrencies: string[];
  vatRate: number;
  checkInCheckOut: CheckInCheckOutSettings;
  extraGuest: ExtraGuestView;
  cancellationPolicies: CancellationPolicyView[];
  paymentMethodDefs: PaymentMethodDef[];
  canManageMessaging: boolean;
  messaging: MessagingSettingsView | null;
  canManageTTLock: boolean;
  ttlock: TTLockSettingsView | null;
  workflowStatuses: WorkflowStatusDef[];
}) {
  const [section, setSection] = useQueryState(
    "section",
    parseAsStringLiteral(SETTINGS_SECTION_KEYS).withDefault("vat"),
  );

  // Messaging and TTLock are super_admin-only: hide their groups from the nav
  // when not allowed. Both are integration CREDENTIALS (§ guards), not screens.
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        (canManageMessaging || item.key !== "messaging") &&
        (canManageTTLock || item.key !== "ttlock"),
    ),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="sg-page" dir="rtl">
      {section !== "check-in-check-out" && (
        <div>
          <h1 className="h1">הגדרות</h1>
          <p className="t-secondary mt-1">
            {propertyIdentity} — ניהול ערכים, סטטוסים וברירות מחדל של המערכת
          </p>
        </div>
      )}

      {/* Below md the stacked nav card would push every section a full screen
          down, so the phone keeps the compact select of the mobile pass
          (D145/D146); from md up the approved grid applies. */}
      <label className="field md:hidden">
        <span className="field-label">קטגוריית הגדרות</span>
        <select
          className="field-input"
          value={section}
          onChange={(event) => setSection(event.target.value as SettingsSectionKey)}
          aria-label="בחירת קטגוריית הגדרות"
        >
          {groups.map((group) => (
            <optgroup key={group.title} label={group.title}>
              {group.items.map((item) => (
                <option key={item.key} value={item.key}>{item.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <div className="sg-grid">
        {/* right-hand settings navigation — first child = right side in RTL (like Shell's Sidebar) */}
        <nav className="card sg-nav hidden md:flex" aria-label="ניווט הגדרות">
          {groups.map((group) => (
            <div key={group.title} className="sg-grp">
              {/* 12px/700 group label, tracked .05em per the approved reference */}
              <p className="t-label sg-lbl">{group.title}</p>
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
        <div className="min-w-0">
          <SectionBody
            section={section}
            businessProfile={businessProfile}
            currency={currency}
            enabledCurrencies={enabledCurrencies}
            vatRate={vatRate}
            checkInCheckOut={checkInCheckOut}
            extraGuest={extraGuest}
            cancellationPolicies={cancellationPolicies}
            paymentMethodDefs={paymentMethodDefs}
            canManageMessaging={canManageMessaging}
            messaging={messaging}
            canManageTTLock={canManageTTLock}
            ttlock={ttlock}
            workflowStatuses={workflowStatuses}
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
  // .sg-item paints the 40px / 15px-700 row, the active surface and the 3px
  // inline-start bar (business-profile.css); the icon is the reference's 19px,
  // which <Icon> snaps to the nearest §10 size, 20.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`sg-item${active ? " on" : ""}`}
    >
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}

function SectionBody({
  section,
  businessProfile,
  currency,
  enabledCurrencies,
  vatRate,
  checkInCheckOut,
  extraGuest,
  cancellationPolicies,
  paymentMethodDefs,
  canManageMessaging,
  messaging,
  canManageTTLock,
  ttlock,
  workflowStatuses,
}: {
  section: SettingsSectionKey;
  businessProfile: BusinessProfileContext | null;
  currency: string;
  enabledCurrencies: string[];
  vatRate: number;
  checkInCheckOut: CheckInCheckOutSettings;
  extraGuest: ExtraGuestView;
  cancellationPolicies: CancellationPolicyView[];
  paymentMethodDefs: PaymentMethodDef[];
  canManageMessaging: boolean;
  messaging: MessagingSettingsView | null;
  canManageTTLock: boolean;
  ttlock: TTLockSettingsView | null;
  workflowStatuses: WorkflowStatusDef[];
}) {
  switch (section) {
    case "business":
      return businessProfile ? <BusinessProfileSection initial={businessProfile} /> : null;
    case "vat":
      return (
        <>
          <VatSection vatRate={vatRate} />
          <CurrenciesSection baseCurrency={currency} enabled={enabledCurrencies} />
        </>
      );
    case "extra-guest":
      return <ExtraGuestSection value={extraGuest} currency={currency} vatRate={vatRate} />;
    case "statuses":
      return <WorkflowStatusSection initial={workflowStatuses} />;
    case "check-in-check-out":
      return <CheckInCheckOutSection initial={checkInCheckOut} />;
    case "cancellation":
      return <CancellationSection policies={cancellationPolicies} />;
    case "payment":
      return <PaymentSection methodDefs={paymentMethodDefs} />;
    case "messaging":
      return canManageMessaging && messaging ? <MessagingSection data={messaging} /> : null;
    case "ttlock":
      return canManageTTLock && ttlock ? <TTLockSection data={ttlock} /> : null;
  }
}
