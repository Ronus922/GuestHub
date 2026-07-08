"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { CardTitle, Field } from "@/components/reservations/BookingPanel";
import { Segmented, Switch } from "./controls";
import {
  saveGmailSettingsAction,
  saveGreenApiSettingsAction,
  saveTwilioSettingsAction,
  setActiveWhatsAppProviderAction,
  testProviderConnectionAction,
  sendTestMessageAction,
  disconnectProviderAction,
  rotateWebhookTokenAction,
} from "./messaging-actions";
import type {
  MessagingSettingsView,
  GmailSettingsView,
  GreenApiSettingsView,
  TwilioSettingsView,
} from "./types";
import type { WhatsAppProviderId } from "@/lib/messaging/types";

// ============================================================
// תקשורת והודעות (D53) — super_admin settings for Gmail + WhatsApp providers.
// Secrets are never rendered: password inputs prefill a masked hint in the
// placeholder and leaving one blank keeps the stored value on the server.
// ============================================================
export function MessagingSection({ data }: { data: MessagingSettingsView }) {
  const disabled = !data.secretsKeyConfigured;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-extrabold text-ink">תקשורת והודעות</h2>
        <p className="mt-1 text-sm font-semibold text-muted">
          חיבור ספקי שליחת מייל ו-WhatsApp לשליחת אישורי הזמנה, קבלות ותזכורות לאורחים.
        </p>
      </div>

      {disabled && (
        <div className="flex items-start gap-3 rounded-2xl border border-status-warning bg-status-warning-050 p-4">
          <Icon name="warning" size={20} className="mt-0.5 shrink-0 text-status-warning" />
          <p className="text-sm font-semibold text-ink">
            מפתח ההצפנה של הסודות אינו מוגדר בשרת (MESSAGING_SECRETS_ENCRYPTION_KEY). לא ניתן לשמור פרטי
            ספקים עד להגדרתו.
          </p>
        </div>
      )}

      <GmailCard view={data.gmail} disabled={disabled} />
      <WhatsAppBlock data={data} disabled={disabled} />
    </div>
  );
}

// ---------- shared bits ----------

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    connected: { label: "מחובר", cls: "bg-status-success-050 text-status-success" },
    error: { label: "שגיאת חיבור", cls: "bg-status-danger-050 text-status-danger" },
    not_configured: { label: "לא מוגדר", cls: "bg-hover text-muted" },
  };
  const s = map[status] ?? map.not_configured;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${s.cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s.label}
    </span>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <Field label={label}>
      <input
        className="bw-fld"
        type="password"
        dir="ltr"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint ? `${hint} — הזן ערך חדש להחלפה` : undefined}
      />
    </Field>
  );
}

// Complete, one-click-copyable webhook URL. When `onRotate` is given, a refresh
// button re-mints the opaque token (leaving provider credentials untouched).
function ReadOnlyUrl({
  label,
  url,
  onRotate,
  rotating,
}: {
  label: string;
  url: string;
  onRotate?: () => void;
  rotating?: boolean;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("הכתובת הועתקה");
    } catch {
      toast.error("העתקה נכשלה — יש להעתיק ידנית");
    }
  };
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input className="bw-fld min-w-0 flex-1" dir="ltr" value={url} readOnly />
        <button
          type="button"
          aria-label="העתקת כתובת"
          onClick={copy}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line text-text2 transition-colors hover:bg-hover"
        >
          <Icon name="copy" size={16} />
        </button>
        {onRotate && (
          <button
            type="button"
            aria-label="רענון כתובת (החלפת אסימון)"
            title="רענון כתובת — יצירת אסימון חדש (ללא שינוי פרטי הספק)"
            onClick={onRotate}
            disabled={rotating}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line text-text2 transition-colors hover:bg-hover disabled:opacity-50"
          >
            <Icon name="refresh" size={16} />
          </button>
        )}
      </div>
    </Field>
  );
}

// Shown before the first save, when no token exists yet.
function WebhookHint({ label }: { label: string }) {
  return (
    <Field label={label}>
      <p className="bw-fld flex items-center text-sm font-semibold text-muted">
        כתובת ה-Webhook תיווצר לאחר שמירת החיבור.
      </p>
    </Field>
  );
}

// Save / test-connection / test-message / disconnect button row, shared by all
// three provider cards. `busy` marks which action is currently pending.
function ProviderActions({
  disabled,
  configured,
  saveDisabled,
  busy,
  onSave,
  onTest,
  onSendTest,
  onDisconnect,
}: {
  disabled: boolean;
  configured: boolean;
  saveDisabled?: boolean;
  busy: null | "save" | "test" | "send" | "disconnect" | "rotate";
  onSave: () => void;
  onTest: () => void;
  onSendTest: () => void;
  onDisconnect: () => void;
}) {
  const anyBusy = busy !== null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="bw-btn bw-btn-primary"
        disabled={disabled || anyBusy || saveDisabled}
        onClick={onSave}
      >
        <Icon name="check" size={16} />
        {busy === "save" ? "שומר…" : "שמירת הגדרות"}
      </button>
      <button
        type="button"
        className="bw-btn bw-btn-o"
        disabled={disabled || anyBusy || !configured}
        onClick={onTest}
      >
        <Icon name="wifi" size={16} />
        {busy === "test" ? "בודק…" : "בדיקת חיבור"}
      </button>
      <button
        type="button"
        className="bw-btn bw-btn-o"
        disabled={disabled || anyBusy || !configured}
        onClick={onSendTest}
      >
        <Icon name="send" size={16} />
        {busy === "send" ? "שולח…" : "שליחת הודעת בדיקה"}
      </button>
      {configured && (
        <button
          type="button"
          className="bw-btn bw-btn-danger ms-auto"
          disabled={disabled || anyBusy}
          onClick={onDisconnect}
        >
          <Icon name="trash" size={16} />
          {busy === "disconnect" ? "מנתק…" : "ניתוק"}
        </button>
      )}
    </div>
  );
}

function toastTestResult(res: Awaited<ReturnType<typeof testProviderConnectionAction>>) {
  if (!res.success) {
    toast.error(res.error);
    return;
  }
  if (res.data?.ok) toast.success(res.data.detail || "החיבור תקין");
  else toast.error(res.data?.detail || "החיבור נכשל");
}

function toastSendResult(res: Awaited<ReturnType<typeof sendTestMessageAction>>) {
  if (!res.success) {
    toast.error(res.error);
    return;
  }
  if (res.data?.ok) toast.success(res.data.detail || "הודעת הבדיקה נשלחה");
  else toast.error(res.data?.detail || "שליחת הודעת הבדיקה נכשלה");
}

// ---------- Gmail ----------

function GmailCard({ view, disabled }: { view: GmailSettingsView; disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<null | "save" | "test" | "send" | "disconnect">(null);

  const [mode, setMode] = useState<"oauth" | "smtp">(view.mode);
  const [senderEmail, setSenderEmail] = useState(view.senderEmail);
  const [senderName, setSenderName] = useState(view.senderName);
  const [replyTo, setReplyTo] = useState(view.replyTo);
  const [smtpHost, setSmtpHost] = useState(view.smtpHost || "smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState(view.smtpPort ? String(view.smtpPort) : "465");
  const [smtpSecure, setSmtpSecure] = useState(view.smtpSecure);
  // secret inputs — blank keeps the stored value
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [appPassword, setAppPassword] = useState("");

  const clearSecrets = () => {
    setClientId("");
    setClientSecret("");
    setRefreshToken("");
    setAppPassword("");
  };

  const save = () => {
    setBusy("save");
    start(async () => {
      const res = await saveGmailSettingsAction({
        mode,
        senderEmail,
        senderName,
        replyTo,
        smtpHost,
        smtpPort: smtpPort.trim() ? Number(smtpPort) : null,
        smtpSecure,
        secrets: { clientId, clientSecret, refreshToken, appPassword },
      });
      setBusy(null);
      if (res.success) {
        toast.success("הגדרות Gmail נשמרו");
        clearSecrets();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  const test = () => {
    setBusy("test");
    start(async () => {
      const res = await testProviderConnectionAction("gmail");
      setBusy(null);
      toastTestResult(res);
      router.refresh();
    });
  };

  const sendTest = () => {
    const target = window.prompt("כתובת אימייל לשליחת הודעת בדיקה");
    if (!target) return;
    setBusy("send");
    start(async () => {
      const res = await sendTestMessageAction("gmail", target);
      setBusy(null);
      toastSendResult(res);
    });
  };

  const disconnect = () => {
    if (!window.confirm("לנתק את חשבון Gmail? פרטי ההתחברות יימחקו.")) return;
    setBusy("disconnect");
    start(async () => {
      const res = await disconnectProviderAction("gmail");
      setBusy(null);
      if (res.success) {
        toast.success("חשבון Gmail נותק");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <section className="bw-card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <CardTitle icon="mail" title="הגדרות Gmail" />
        <StatusChip status={view.status} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-bold text-text2">שיטת חיבור</span>
        <Segmented
          value={mode}
          onChange={setMode}
          ariaLabel="שיטת חיבור Gmail"
          options={[
            { value: "oauth", label: "OAuth (מומלץ)" },
            { value: "smtp", label: "SMTP" },
          ]}
        />
      </div>

      {mode === "oauth" ? (
        <>
          <div className="bw-grid2">
            <PasswordField label="Client ID" value={clientId} onChange={setClientId} hint={view.secretHints.clientId} />
            <PasswordField
              label="Client Secret"
              value={clientSecret}
              onChange={setClientSecret}
              hint={view.secretHints.clientSecret}
            />
            <Field label="כתובת מייל שולח" required>
              <input className="bw-fld" dir="ltr" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} />
            </Field>
            <Field label="שם תצוגה">
              <input className="bw-fld" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
            </Field>
            <Field label="כתובת לתשובה (Reply-To)">
              <input className="bw-fld" dir="ltr" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="bw-btn bw-btn-o"
              disabled={disabled}
              onClick={() => {
                window.location.href = "/api/messaging/gmail/oauth";
              }}
            >
              <Icon name="link" size={16} />
              התחבר לחשבון Gmail
            </button>
          </div>
        </>
      ) : (
        <div className="bw-grid2">
          <Field label="כתובת Gmail" required>
            <input className="bw-fld" dir="ltr" value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)} />
          </Field>
          <PasswordField
            label="App Password"
            value={appPassword}
            onChange={setAppPassword}
            hint={view.secretHints.appPassword}
          />
          <Field label="שרת SMTP">
            <input className="bw-fld" dir="ltr" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
          </Field>
          <Field label="פורט">
            <input
              className="bw-fld"
              dir="ltr"
              inputMode="numeric"
              value={smtpPort}
              onChange={(e) => setSmtpPort(e.target.value)}
            />
          </Field>
          <Field label="שם תצוגה">
            <input className="bw-fld" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-ink">
              <Switch checked={smtpSecure} onChange={setSmtpSecure} label="TLS/SSL" /> חיבור מוצפן (TLS/SSL)
            </label>
          </div>
        </div>
      )}

      <ProviderActions
        disabled={disabled || pending}
        configured={view.configured}
        busy={busy}
        onSave={save}
        onTest={test}
        onSendTest={sendTest}
        onDisconnect={disconnect}
      />
    </section>
  );
}

// ---------- WhatsApp (active-provider selector + GREEN-API / Twilio cards) ----------

function WhatsAppBlock({ data, disabled }: { data: MessagingSettingsView; disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [active, setActive] = useState<WhatsAppProviderId>(data.activeWhatsApp);

  const changeActive = (provider: WhatsAppProviderId) => {
    const prev = active;
    setActive(provider);
    start(async () => {
      const res = await setActiveWhatsAppProviderAction(provider);
      if (res.success) {
        toast.success("ספק ה-WhatsApp הפעיל עודכן");
        router.refresh();
      } else {
        toast.error(res.error);
        setActive(prev);
      }
    });
  };

  return (
    <section className="bw-card">
      <CardTitle icon="whatsapp" title="WhatsApp" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-bold text-text2">ספק פעיל</span>
        <Segmented
          value={active}
          onChange={changeActive}
          ariaLabel="בחירת ספק WhatsApp פעיל"
          options={[
            { value: "green_api", label: "GREEN-API" },
            { value: "twilio", label: "Twilio" },
            { value: "disabled", label: "מושבת" },
          ]}
        />
        {pending && <span className="text-xs text-faint">מעדכן…</span>}
      </div>

      <div className="flex flex-col gap-4">
        <GreenApiCard view={data.greenApi} webhookBaseUrl={data.webhookBaseUrl} disabled={disabled} />
        <TwilioCard view={data.twilio} webhookBaseUrl={data.webhookBaseUrl} disabled={disabled} />
      </div>
    </section>
  );
}

function GreenApiCard({
  view,
  webhookBaseUrl,
  disabled,
}: {
  view: GreenApiSettingsView;
  webhookBaseUrl: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<null | "save" | "test" | "send" | "disconnect" | "rotate">(null);

  const [instanceId, setInstanceId] = useState(view.instanceId);
  const [apiHost, setApiHost] = useState(view.apiHost || "https://api.green-api.com");
  const [senderNumber, setSenderNumber] = useState(view.senderNumber);
  const [apiToken, setApiToken] = useState("");

  const webhookUrl = `${webhookBaseUrl}/api/messaging/webhook/green-api/${view.webhookToken}`;

  const save = () => {
    setBusy("save");
    start(async () => {
      const res = await saveGreenApiSettingsAction({ apiHost, instanceId, senderNumber, apiToken });
      setBusy(null);
      if (res.success) {
        toast.success("הגדרות GREEN-API נשמרו");
        setApiToken("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  const rotate = () => {
    if (!window.confirm("לרענן את כתובת ה-Webhook? הכתובת הקודמת תפסיק לעבוד ותצטרך לעדכן אותה אצל הספק.")) return;
    setBusy("rotate");
    start(async () => {
      const res = await rotateWebhookTokenAction("green_api");
      setBusy(null);
      if (res.success) {
        toast.success("כתובת ה-Webhook רועננה");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  const test = () => {
    setBusy("test");
    start(async () => {
      const res = await testProviderConnectionAction("green_api");
      setBusy(null);
      toastTestResult(res);
      router.refresh();
    });
  };

  const sendTest = () => {
    const target = window.prompt("מספר WhatsApp לשליחת הודעת בדיקה (כולל קידומת מדינה)");
    if (!target) return;
    setBusy("send");
    start(async () => {
      const res = await sendTestMessageAction("green_api", target);
      setBusy(null);
      toastSendResult(res);
    });
  };

  const disconnect = () => {
    if (!window.confirm("לנתק את חיבור GREEN-API? ה-API token יימחק.")) return;
    setBusy("disconnect");
    start(async () => {
      const res = await disconnectProviderAction("green_api");
      setBusy(null);
      if (res.success) {
        toast.success("חיבור GREEN-API נותק");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-base font-extrabold text-ink">GREEN-API</span>
        <StatusChip status={view.status} />
      </div>
      <div className="bw-grid2">
        <Field label="Instance ID" required>
          <input className="bw-fld" dir="ltr" value={instanceId} onChange={(e) => setInstanceId(e.target.value)} />
        </Field>
        <PasswordField label="API Token" value={apiToken} onChange={setApiToken} hint={view.secretHints.apiToken} />
        <Field label="API Host">
          <input className="bw-fld" dir="ltr" value={apiHost} onChange={(e) => setApiHost(e.target.value)} />
        </Field>
        <Field label="מספר שולח">
          <input className="bw-fld" dir="ltr" value={senderNumber} onChange={(e) => setSenderNumber(e.target.value)} />
        </Field>
        {view.webhookToken ? (
          <ReadOnlyUrl label="כתובת Webhook" url={webhookUrl} onRotate={rotate} rotating={busy === "rotate"} />
        ) : (
          <WebhookHint label="כתובת Webhook" />
        )}
      </div>
      <ProviderActions
        disabled={disabled || pending}
        configured={view.configured}
        busy={busy}
        onSave={save}
        onTest={test}
        onSendTest={sendTest}
        onDisconnect={disconnect}
      />
    </div>
  );
}

function TwilioCard({
  view,
  webhookBaseUrl,
  disabled,
}: {
  view: TwilioSettingsView;
  webhookBaseUrl: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<null | "save" | "test" | "send" | "disconnect" | "rotate">(null);

  const [fromNumber, setFromNumber] = useState(view.fromNumber);
  const [messagingServiceSid, setMessagingServiceSid] = useState(view.messagingServiceSid);
  const [statusCallbackUrl, setStatusCallbackUrl] = useState(view.statusCallbackUrl);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");

  // The callback URL carries an OPAQUE server-generated token (never the account
  // SID). Complete and copyable — the real auth remains the X-Twilio-Signature.
  const callbackUrl = `${webhookBaseUrl}/api/messaging/webhook/twilio/${view.webhookToken}`;

  const rotate = () => {
    if (!window.confirm("לרענן את כתובת ה-Status Callback? הכתובת הקודמת תפסיק לעבוד ותצטרך לעדכן אותה ב-Twilio.")) return;
    setBusy("rotate");
    start(async () => {
      const res = await rotateWebhookTokenAction("twilio");
      setBusy(null);
      if (res.success) {
        toast.success("כתובת ה-Webhook רועננה");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  const save = () => {
    setBusy("save");
    start(async () => {
      const res = await saveTwilioSettingsAction({
        fromNumber,
        messagingServiceSid,
        statusCallbackUrl,
        accountSid,
        authToken,
      });
      setBusy(null);
      if (res.success) {
        toast.success("הגדרות Twilio נשמרו");
        setAccountSid("");
        setAuthToken("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  const test = () => {
    setBusy("test");
    start(async () => {
      const res = await testProviderConnectionAction("twilio");
      setBusy(null);
      toastTestResult(res);
      router.refresh();
    });
  };

  const sendTest = () => {
    const target = window.prompt("מספר WhatsApp לשליחת הודעת בדיקה (כולל קידומת מדינה)");
    if (!target) return;
    setBusy("send");
    start(async () => {
      const res = await sendTestMessageAction("twilio", target);
      setBusy(null);
      toastSendResult(res);
    });
  };

  const disconnect = () => {
    if (!window.confirm("לנתק את חיבור Twilio? פרטי ההתחברות יימחקו.")) return;
    setBusy("disconnect");
    start(async () => {
      const res = await disconnectProviderAction("twilio");
      setBusy(null);
      if (res.success) {
        toast.success("חיבור Twilio נותק");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-base font-extrabold text-ink">Twilio</span>
        <StatusChip status={view.status} />
      </div>
      <div className="bw-grid2">
        <PasswordField label="Account SID" value={accountSid} onChange={setAccountSid} hint={view.secretHints.accountSid} />
        <PasswordField label="Auth Token" value={authToken} onChange={setAuthToken} hint={view.secretHints.authToken} />
        <Field label="מספר שולח WhatsApp" required>
          <input className="bw-fld" dir="ltr" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} />
        </Field>
        <Field label="Messaging Service SID">
          <input
            className="bw-fld"
            dir="ltr"
            value={messagingServiceSid}
            onChange={(e) => setMessagingServiceSid(e.target.value)}
          />
        </Field>
        <Field label="Status Callback URL">
          <input
            className="bw-fld"
            dir="ltr"
            value={statusCallbackUrl}
            onChange={(e) => setStatusCallbackUrl(e.target.value)}
          />
        </Field>
        {view.webhookToken ? (
          <ReadOnlyUrl
            label="כתובת Status Callback (מומלצת)"
            url={callbackUrl}
            onRotate={rotate}
            rotating={busy === "rotate"}
          />
        ) : (
          <WebhookHint label="כתובת Status Callback (מומלצת)" />
        )}
      </div>
      <ProviderActions
        disabled={disabled || pending}
        configured={view.configured}
        busy={busy}
        onSave={save}
        onTest={test}
        onSendTest={sendTest}
        onDisconnect={disconnect}
      />
    </div>
  );
}
