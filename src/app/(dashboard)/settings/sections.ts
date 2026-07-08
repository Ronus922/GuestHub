import type { IconName } from "@/components/shared/Icon";

// Right-hand settings navigation (approved design ref/screens/Settings.png):
// grouped sections, RTL. Only the sections BUILT in this phase are listed — the
// design's lookup screens (sources/statuses/currencies/languages/…) are out of
// scope here and are not stubbed (§I: do not redesign unrelated Settings sections).

export type SettingsSectionKey = "vat" | "extra-guest" | "cancellation" | "payment" | "messaging";

export type SettingsSectionDef = {
  key: SettingsSectionKey;
  label: string;
  icon: IconName;
  desc: string;
};

export type SettingsGroup = { title: string; items: SettingsSectionDef[] };

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    title: "מיסים ותמחור",
    items: [
      { key: "vat", label: "מע״מ ומיסים", icon: "finance", desc: "שיעור המע״מ של הנכס" },
      { key: "extra-guest", label: "תמחור תפוסה ואורח נוסף", icon: "users-round", desc: "ברירת מחדל לחיוב אורח נוסף" },
    ],
  },
  {
    title: "הזמנות",
    items: [
      { key: "cancellation", label: "מדיניות ביטול", icon: "circle-slash", desc: "תבניות מדיניות ביטול" },
    ],
  },
  {
    title: "תשלומים",
    items: [
      { key: "payment", label: "מדיניות תשלום", icon: "credit-card", desc: "תבניות מדיניות תשלום" },
    ],
  },
  {
    // super_admin only — filtered in SettingsShell via canManageMessaging.
    title: "תקשורת",
    items: [
      { key: "messaging", label: "תקשורת והודעות", icon: "send", desc: "Gmail ו-WhatsApp" },
    ],
  },
];

export const SETTINGS_SECTION_KEYS = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.key));
