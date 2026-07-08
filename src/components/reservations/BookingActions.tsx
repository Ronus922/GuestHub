"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { renderTemplate } from "@/lib/messaging/templates";
import {
  getMessagingContextAction,
  sendBookingEmailAction,
  sendBookingWhatsAppAction,
  type ComposerContext,
} from "@/app/(dashboard)/reservations/message-actions";

// Booking header action toolbar + in-panel message composer (D53). The toolbar
// is the LEFT header cluster (ref/screens/edit-booking-modal.png): compact
// square icon-buttons over the primary header. Close (X) is SidePanel's own
// button. The composer opens as a full-panel OVERLAY — the booking stays mounted
// underneath, so closing restores the exact scroll state, and nothing navigates.

type ToolbarAction = { key: string; icon: IconName; label: string; onClick: () => void };

export function BookingToolbar({
  onEmail,
  onWhatsApp,
  onPdf,
  onPrint,
}: {
  onEmail: () => void;
  onWhatsApp: () => void;
  onPdf: () => void;
  onPrint: () => void;
}) {
  const [overflow, setOverflow] = useState(false);
  // DOM order = RTL right→left: Email nearest the title, Print nearest the X.
  const actions: ToolbarAction[] = [
    { key: "email", icon: "mail", label: "שליחת מייל", onClick: onEmail },
    { key: "whatsapp", icon: "whatsapp", label: "שליחת WhatsApp", onClick: onWhatsApp },
    { key: "pdf", icon: "download", label: "הורדת PDF", onClick: onPdf },
    { key: "print", icon: "printer", label: "הדפסת הזמנה", onClick: onPrint },
  ];
  return (
    <div className="bk-tb">
      {/* inline icons — hidden on very narrow screens (see .bk-tb-inline CSS) */}
      <div className="bk-tb-inline">
        {actions.map((a) => (
          <button key={a.key} type="button" className="bk-tb-btn" title={a.label} aria-label={a.label} onClick={a.onClick}>
            <Icon name={a.icon} size={19} />
          </button>
        ))}
      </div>
      {/* overflow menu — shown only when there isn't room for the inline row */}
      <div className="bk-tb-more">
        <button
          type="button"
          className="bk-tb-btn"
          title="פעולות"
          aria-label="פעולות נוספות"
          aria-expanded={overflow}
          onClick={() => setOverflow((v) => !v)}
        >
          <Icon name="more" size={19} />
        </button>
        {overflow && (
          <>
            <button type="button" className="bk-tb-scrim" aria-hidden onClick={() => setOverflow(false)} />
            <div className="bk-tb-menu" role="menu">
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  role="menuitem"
                  className="bk-tb-menu-item"
                  onClick={() => {
                    setOverflow(false);
                    a.onClick();
                  }}
                >
                  <Icon name={a.icon} size={17} />
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type Mode = "custom" | "template";
type SendState = "idle" | "sending" | "sent" | "failed";

export function MessageComposer({
  channel,
  reservationId,
  onClose,
  onSent,
}: {
  channel: "email" | "whatsapp";
  reservationId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [ctx, setCtx] = useState<ComposerContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("custom");
  const [templateId, setTemplateId] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [pending, startSend] = useTransition();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const isEmail = channel === "email";

  useEffect(() => {
    let alive = true;
    getMessagingContextAction(reservationId).then((res) => {
      if (!alive) return;
      if (!res.success || !res.data) {
        setLoadError(res.success ? "לא נמצאו נתונים" : res.error);
        return;
      }
      setCtx(res.data);
    });
    return () => {
      alive = false;
    };
  }, [reservationId]);

  const templates = ctx ? ctx.templates[channel] : [];
  const providerConfigured = ctx ? (isEmail ? ctx.gmailConfigured : ctx.whatsappConfigured) : false;
  const recipientValid = ctx ? (isEmail ? ctx.emailValid : ctx.phoneValid) : false;
  const recipient = ctx ? (isEmail ? ctx.email : ctx.phoneE164 ?? ctx.phone) : null;

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      if (isEmail) setSubject(t.subject ?? "");
      setBody(t.body);
    }
  };

  const insertVar = (key: string) => {
    const token = `{{${key}}}`;
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const vars = ctx?.variables ?? {};
  const previewSubject = renderTemplate(subject, vars);
  const previewBody = renderTemplate(body, vars);

  const canSend =
    !pending && providerConfigured && recipientValid && previewBody.trim().length > 0 && sendState !== "sent";

  const doSend = () =>
    startSend(async () => {
      setSendState("sending");
      const res = isEmail
        ? await sendBookingEmailAction(reservationId, { templateId: mode === "template" ? templateId || null : null, subject, body })
        : await sendBookingWhatsAppAction(reservationId, { templateId: mode === "template" ? templateId || null : null, body });
      if (!res.success || !res.data) {
        setSendState("failed");
        toast.error(res.success ? "השליחה נכשלה" : res.error);
        return;
      }
      if (res.data.ok) {
        setSendState("sent");
        toast.success(isEmail ? "המייל נשלח דרך Gmail" : "הודעת ה-WhatsApp נשלחה");
        onSent();
        setTimeout(onClose, 900);
      } else {
        setSendState("failed");
        toast.error(res.data.detail ?? "השליחה נכשלה");
      }
    });

  const title = isEmail ? "שליחת מייל לאורח" : "שליחת WhatsApp לאורח";

  return (
    <div className="bk-cmp" dir="rtl" role="dialog" aria-label={title}>
      <header className="bk-cmp-h">
        <button type="button" className="bk-cmp-back" onClick={onClose} aria-label="חזרה להזמנה">
          <Icon name="chevron-right" size={18} />
        </button>
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/15">
          <Icon name={isEmail ? "mail" : "whatsapp"} size={18} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-base font-bold">{title}</p>
          {ctx && (
            <p className="truncate text-xs text-white/80" dir="ltr">
              {ctx.guestName} · {recipient ?? "—"}
            </p>
          )}
        </div>
      </header>

      <div className="bk-cmp-body thin-scroll">
        {loadError ? (
          <div className="grid h-40 place-items-center text-center">
            <div>
              <Icon name="warning" size={26} className="mx-auto mb-2 text-status-danger" />
              <p className="font-semibold text-ink">{loadError}</p>
            </div>
          </div>
        ) : !ctx ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-white/70" />
            ))}
          </div>
        ) : (
          <>
            {/* recipient + provider validation */}
            {!providerConfigured && (
              <div className="bk-cmp-alert warn">
                <Icon name="warning" size={16} />
                <span>
                  {isEmail
                    ? "שירות Gmail טרם הוגדר. ניתן להגדירו במסך ההגדרות."
                    : "ספק WhatsApp טרם הוגדר. ניתן לבחור GREEN-API או Twilio במסך ההגדרות."}
                </span>
                <a className="bk-cmp-alert-link" href="/settings?section=messaging">
                  להגדרות
                </a>
              </div>
            )}
            {providerConfigured && !recipientValid && (
              <div className="bk-cmp-alert danger">
                <Icon name="warning" size={16} />
                <span>
                  {isEmail
                    ? "לאורח אין כתובת אימייל תקינה. עדכן אותה בפרטי האורח לפני השליחה."
                    : "לאורח אין מספר טלפון תקין. עדכן אותו בפרטי האורח לפני השליחה."}
                </span>
              </div>
            )}

            <div className="bk-cmp-recipient">
              <Icon name={isEmail ? "mail" : "phone"} size={16} className="text-primary" />
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-ink">{ctx.guestName}</p>
                <p className="truncate text-xs text-muted" dir="ltr">
                  {recipient ?? "—"}
                </p>
              </div>
            </div>

            {/* mode tabs */}
            <div className="bk-cmp-tabs">
              <button type="button" className={`bk-cmp-tab ${mode === "custom" ? "on" : ""}`} onClick={() => setMode("custom")}>
                כתיבת הודעה חדשה
              </button>
              <button type="button" className={`bk-cmp-tab ${mode === "template" ? "on" : ""}`} onClick={() => setMode("template")}>
                בחירה מתבנית
              </button>
            </div>

            {mode === "template" && (
              <label className="bw-fg">
                <span className="bw-lbl">תבנית</span>
                <select className="bw-fld" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                  <option value="">בחר תבנית…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {templates.length === 0 && <span className="bw-hint">אין תבניות {isEmail ? "מייל" : "WhatsApp"} פעילות. ניתן לכתוב הודעה חדשה.</span>}
              </label>
            )}

            {isEmail && (
              <label className="bw-fg">
                <span className="bw-lbl">נושא</span>
                <input className="bw-fld" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="נושא ההודעה" />
              </label>
            )}

            <label className="bw-fg">
              <span className="bw-lbl">תוכן ההודעה</span>
              <textarea
                ref={bodyRef}
                className="bw-fld bk-cmp-textarea"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="כתוב את ההודעה… ניתן לשלב משתנים כמו {{guest_first_name}}"
              />
            </label>

            {/* variable helper chips */}
            <div className="bk-cmp-vars">
              <span className="bk-cmp-vars-lbl">שדות הזמנה:</span>
              {ctx.variableDefs.map((v) => (
                <button key={v.key} type="button" className="bk-cmp-var" title={`{{${v.key}}}`} onClick={() => insertVar(v.key)}>
                  {v.label}
                </button>
              ))}
            </div>

            {/* preview (variables resolved from the real booking) */}
            <div className="bk-cmp-preview">
              <div className="bk-cmp-preview-h">
                <Icon name="eye" size={15} />
                תצוגה מקדימה
              </div>
              {isEmail && previewSubject && <p className="bk-cmp-preview-subj">{previewSubject}</p>}
              <p className="bk-cmp-preview-body">{previewBody || "—"}</p>
            </div>
          </>
        )}
      </div>

      <footer className="bk-cmp-f">
        <button type="button" className="bw-btn bw-btn-ghost" onClick={onClose}>
          ביטול
        </button>
        <span className="flex-1" />
        {sendState === "sent" ? (
          <span className="bk-cmp-ok">
            <Icon name="check-circle" size={16} /> נשלח
          </span>
        ) : (
          <button type="button" className="bw-btn bw-btn-primary" disabled={!canSend} onClick={doSend}>
            <Icon name="send" size={15} />
            {sendState === "sending" ? "שולח…" : "שליחה"}
          </button>
        )}
      </footer>
    </div>
  );
}
