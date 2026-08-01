"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { STATUS_COLORS } from "@/lib/status-colors";
import { Field, FormGrid, SettingsCard } from "./controls";
import {
  saveTTLockConnectionAction,
  testTTLockConnectionAction,
  clearTTLockConnectionAction,
} from "./ttlock-actions";
import type { TTLockSettingsView } from "./types";

// ============================================================
// מנעולים חכמים (D120) — super_admin settings for the TTLock Open Platform
// connection. Secrets are never rendered: the stored value shows as a masked
// hint under the field, and leaving an input blank keeps it on the server.
//
// SCOPE: the CONNECTION only. No lock list, no passcodes, no rotation — those
// are a later task and are deliberately absent rather than stubbed.
// ============================================================
export function TTLockSection({ data }: { data: TTLockSettingsView }) {
  const disabled = !data.secretsKeyConfigured;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="h2 text-ink">מנעולים חכמים</h2>
        <p className="t-secondary mt-1">
          חיבור לחשבון TTLock של הנכס, לניהול קודי כניסה לדירות.
        </p>
      </div>

      {disabled && (
        <div
          className="flex items-start gap-3 rounded-2xl border p-4"
          style={{
            background: STATUS_COLORS.approval.bg,
            borderColor: STATUS_COLORS.approval.bd,
            color: STATUS_COLORS.approval.tx,
          }}
        >
          <Icon name="warning" size={20} className="mt-0.5 shrink-0" />
          <p className="text-sm font-semibold">
            מפתח ההצפנה של הסודות אינו מוגדר בשרת (TTLOCK_SECRETS_KEY). לא ניתן לשמור את פרטי החיבור עד
            להגדרתו.
          </p>
        </div>
      )}

      <ConnectionCard data={data} disabled={disabled} />
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; chip: string }> = {
    connected: { label: "מחובר", chip: STATUS_COLORS.paid.chip },
    error: { label: "שגיאת חיבור", chip: STATUS_COLORS.failed.chip },
    not_configured: { label: "לא מוגדר", chip: STATUS_COLORS.cancelled.chip },
  };
  const s = map[status] ?? map.not_configured;
  return (
    <span className={`chip shrink-0 ${s.chip}`}>
      <span className="dot" />
      {s.label}
    </span>
  );
}

function SecretField({
  label,
  value,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** masked tail of the STORED value, or "" when nothing is stored */
  hint: string;
  disabled: boolean;
}) {
  return (
    <Field label={label}>
      <input
        className="field-input"
        type="password"
        dir="ltr"
        autoComplete="new-password"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint ? "הזן ערך חדש להחלפה" : undefined}
      />
      {/* the stored secret is DESCRIBED, never placed in the input */}
      <span className="field-hint">{hint ? `שמור בשרת: ${hint}` : "לא הוגדר"}</span>
    </Field>
  );
}

function ConnectionCard({ data, disabled }: { data: TTLockSettingsView; disabled: boolean }) {
  const view = data.connection;
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<null | "save" | "test" | "clear">(null);

  const [region, setRegion] = useState<"eu" | "global">(view.region);
  const [clientId, setClientId] = useState(view.clientId);
  const [username, setUsername] = useState(view.username);
  // secret inputs — blank keeps the stored value
  const [clientSecret, setClientSecret] = useState("");
  const [password, setPassword] = useState("");

  const anyBusy = busy !== null;

  const save = () => {
    setBusy("save");
    start(async () => {
      const res = await saveTTLockConnectionAction({ region, clientId, username, clientSecret, password });
      setBusy(null);
      if (res.success) {
        toast.success("פרטי החיבור נשמרו");
        setClientSecret("");
        setPassword("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  const test = () => {
    setBusy("test");
    start(async () => {
      const res = await testTTLockConnectionAction();
      setBusy(null);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      // The message is already the specific Hebrew sentence the server built —
      // either the lock count or hebrewMessageFor(errcode). Never a raw code.
      if (res.data?.ok) toast.success(res.data.message);
      else toast.error(res.data?.message ?? "החיבור נכשל");
      router.refresh();
    });
  };

  const clear = () => {
    setBusy("clear");
    start(async () => {
      const res = await clearTTLockConnectionAction();
      setBusy(null);
      if (res.success) {
        toast.success("החיבור נותק");
        setClientSecret("");
        setPassword("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <SettingsCard icon="lock" title="חיבור TTLock" action={<StatusChip status={view.status} />}>
      <FormGrid>
        <Field label="אזור השרת" required>
          <select
            className="field-input"
            value={region}
            disabled={disabled}
            onChange={(e) => setRegion(e.target.value as "eu" | "global")}
          >
            <option value="eu">אירופה</option>
            <option value="global">גלובלי</option>
          </select>
          {/* the region is not cosmetic — the wrong one reports as a wrong secret */}
          <span className="field-hint">
            האזור שבו נרשמה האפליקציה. אזור שגוי מדווח כמו סוד שגוי.
          </span>
        </Field>

        <Field label="מזהה אפליקציה (Client ID)" required>
          <input
            className="field-input"
            dir="ltr"
            disabled={disabled}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </Field>

        <Field label="שם משתמש בחשבון TTLock" required>
          <input
            className="field-input"
            dir="ltr"
            autoComplete="username"
            disabled={disabled}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>

        <SecretField
          label="סוד האפליקציה (Client Secret)"
          value={clientSecret}
          onChange={setClientSecret}
          hint={view.secretHint}
          disabled={disabled}
        />

        <SecretField
          label="סיסמת החשבון"
          value={password}
          onChange={setPassword}
          hint={view.configured ? "••••••••" : ""}
          disabled={disabled}
        />
      </FormGrid>

      {view.statusDetail && (
        <p className="field-hint mt-3 text-start">
          תוצאת הבדיקה האחרונה: {view.statusDetail}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={disabled || anyBusy} onClick={save}>
          <Icon name="check" size={20} />
          {busy === "save" ? "שומר…" : "שמירה"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || anyBusy || !view.configured}
          onClick={test}
        >
          <Icon name="refresh" size={20} />
          {busy === "test" ? "בודק…" : "בדיקת חיבור"}
        </button>
        {view.configured && (
          <button
            type="button"
            className="btn btn-danger ms-auto"
            disabled={disabled || anyBusy}
            onClick={clear}
          >
            <Icon name="trash" size={20} />
            {busy === "clear" ? "מנתק…" : "ניתוק"}
          </button>
        )}
      </div>
    </SettingsCard>
  );
}
