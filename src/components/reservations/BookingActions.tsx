"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { renderTemplate } from "@/lib/messaging/templates";
import { renderManualText } from "@/lib/messaging/render-manual";
import {
  insertToken,
  manualSendGate,
  sendBlockMessage,
  guestInitials,
  formatStayRange,
  type ComposerDraft,
} from "@/lib/messaging/composer-draft";
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
  onCancelReservation,
}: {
  onEmail: () => void;
  onWhatsApp: () => void;
  onPdf: () => void;
  onPrint: () => void;
  /** D77 §9 — top "בטל הזמנה" action; omitted when not permitted/cancelled */
  onCancelReservation?: () => void;
}) {
  const [overflow, setOverflow] = useState(false);
  // DOM order = RTL right→left: Email nearest the title, Print nearest the X.
  const actions: ToolbarAction[] = [
    /* the MD header names (right→left): מייל לאורח · שליחת הודעה (chat) ·
       הורדת אישור הזמנה (download) · הדפסה · ביטול — same actions, the
       whatsapp/pdf buttons carry the MD's labels (their glyphs already are
       chat / download) */
    { key: "email", icon: "mail", label: "מייל לאורח", onClick: onEmail },
    { key: "whatsapp", icon: "whatsapp", label: "שליחת הודעה", onClick: onWhatsApp },
    { key: "pdf", icon: "download", label: "הורדת אישור הזמנה", onClick: onPdf },
    { key: "print", icon: "printer", label: "הדפסת הזמנה", onClick: onPrint },
    ...(onCancelReservation
      ? [{ key: "cancel", icon: "circle-slash" as IconName, label: "בטל הזמנה", onClick: onCancelReservation }]
      : []),
  ];
  return (
    <div className="bk-tb">
      {/* inline icons — hidden on very narrow screens (see .bk-tb-inline CSS) */}
      <div className="bk-tb-inline">
        {actions.map((a) => (
          <button key={a.key} type="button" className="bk-tb-btn" title={a.label} aria-label={a.label} onClick={a.onClick}>
            <Icon name={a.icon} size={20} />
          </button>
        ))}
        {/* the MD's vertical divider between the toolbar and the close X */}
        <span className="bk-tb-div" aria-hidden />
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
          <Icon name="more" size={20} />
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

type SendState = "idle" | "sending" | "sent" | "failed";

// The composer, rebuilt to the approved design "שליחת מייל לאורח.dc.html"
// (D178). Owner rulings 2026-09-07: it STAYS an overlay inside the booking
// drawer (the booking keeps its scroll, D53) and inherits that drawer's width;
// BOTH channels wear this design (WhatsApp swaps the email chip for a phone
// one and drops the subject); the preview stays truthful to the wire — a known
// variable with no value renders EMPTY, exactly as it will be sent, and an
// unresolvable one still blocks the send by name (D172); all 16 canonical
// variables are offered as chips.
export function MessageComposer({
  channel,
  reservationId,
  draft,
  onDraftChange,
  onEditGuest,
  onClose,
  onSent,
}: {
  channel: "email" | "whatsapp";
  reservationId: string;
  /** lifted so closing the composer to fix the guest's email keeps the draft */
  draft: ComposerDraft;
  onDraftChange: (next: ComposerDraft) => void;
  /** closes the composer and focuses the booking's own guest email field */
  onEditGuest: () => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const [ctx, setCtx] = useState<ComposerContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [pending, startSend] = useTransition();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const isEmail = channel === "email";
  const { mode, templateId, subject, body } = draft;
  const patch = (next: Partial<ComposerDraft>) => onDraftChange({ ...draft, ...next });

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
    const t = templates.find((x) => x.id === id);
    if (!t) {
      patch({ templateId: id });
      return;
    }
    patch({ templateId: id, body: t.body, ...(isEmail ? { subject: t.subject ?? "" } : {}) });
  };

  const insertVar = (key: string) => {
    const token = `{{${key}}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = insertToken(body, start, end, token);
    patch({ body: next.text });
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const vars = ctx?.variables ?? {};
  // Subject and body previews = the server's own chain (legacy vars →
  // communications renderer, D172 + addendum 2026-09-05), so the preview can
  // never show a {{group.key}} token the send would resolve — or hide one the
  // send would refuse. Without a render context the legacy pass is shown and
  // the server refuses on its own.
  const subjectRender = isEmail && ctx?.renderContext ? renderManualText(subject, vars, ctx.renderContext) : null;
  const previewSubject = subjectRender ? subjectRender.value : renderTemplate(subject, vars);
  const subjectBlocked = subjectRender !== null && !subjectRender.canSend;
  const bodyRender = ctx?.renderContext ? renderManualText(body, vars, ctx.renderContext) : null;
  const previewBody = bodyRender ? bodyRender.value : renderTemplate(body, vars);
  const bodyBlocked = bodyRender !== null && !bodyRender.canSend;

  // ONE gate behind both the button and the footer's stated reason.
  const gate = manualSendGate({
    isEmail,
    providerConfigured,
    recipientValid,
    subjectBlocked,
    bodyBlocked,
    subject,
    renderedBody: previewBody,
  });
  const canSend = gate.canSend && !pending && sendState !== "sent";
  const blockMessage = sendBlockMessage(gate.block, isEmail);

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
  // the header's booking context line: "הזמנה #4112 · חדר 201 · 03–06/07/2026"
  const contextLine = ctx
    ? [
        `הזמנה #${ctx.reservationNumber}`,
        ctx.roomNumbers ? `חדר ${ctx.roomNumbers}` : null,
        ctx.checkIn && ctx.checkOut ? formatStayRange(ctx.checkIn, ctx.checkOut) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const hasPreview = (isEmail ? previewSubject.trim().length > 0 : true) && previewBody.trim().length > 0;

  return (
    <div className="sm-panel" dir="rtl" role="dialog" aria-label={title}>
      <header className="sm-h">
        <span className="dw-icon">
          <Icon name={isEmail ? "outgoing-mail" : "whatsapp"} size={20} />
        </span>
        <div className="sm-h-txt">
          <p className="dw-title truncate">{title}</p>
          {contextLine && <p className="dw-sub ltr-num truncate">{contextLine}</p>}
        </div>
        <button type="button" className="dw-close" onClick={onClose} aria-label="חזרה להזמנה">
          <Icon name="close" size={20} />
        </button>
      </header>

      <div className="sm-body thin-scroll">
        {loadError ? (
          <div className="grid h-40 place-items-center text-center">
            <div>
              <Icon name="warning" size={24} className="mx-auto mb-2 text-status-danger" />
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
            {/* ---- recipient ---- */}
            <section className="card">
              <div className="card-hd">
                <span className="sm-sec-ic">
                  <Icon name="user" size={17} />
                </span>
                נמען
                {!recipientValid && (
                  <button type="button" className="sm-hd-link" onClick={onEditGuest}>
                    <Icon name="edit" size={17} />
                    עדכון פרטי האורח
                  </button>
                )}
              </div>
              <div className="card-bd">
                <div className="sm-rcp">
                  <span className="sm-rcp-ava">{guestInitials(ctx.guestName)}</span>
                  <div className="sm-rcp-txt">
                    <p className="sm-rcp-name truncate">{ctx.guestName}</p>
                    {ctx.sourceLabel && (
                      <p className="sm-rcp-src">
                        <Icon name="globe-filled" size={13.5} />
                        מקור: {ctx.sourceLabel}
                      </p>
                    )}
                  </div>
                  {recipientValid ? (
                    <span className="sm-pill ok">
                      <Icon name={isEmail ? "mail-read" : "phone"} size={13.5} />
                      <span className="ltr-num">{recipient}</span>
                    </span>
                  ) : (
                    <span className="sm-pill none">
                      <Icon name={isEmail ? "mail-off" : "phone"} size={13.5} />
                      {isEmail ? "אין כתובת אימייל" : "אין מספר טלפון"}
                    </span>
                  )}
                </div>
                {!recipientValid && (
                  <p className="sm-warn">
                    <Icon name="warning" size={17} />
                    {isEmail
                      ? "לאורח אין כתובת אימייל תקינה. עדכנו את כתובת האימייל בפרטי האורח — כפתור השליחה יישאר נעול עד אז."
                      : "לאורח אין מספר טלפון תקין. עדכנו את מספר הטלפון בפרטי האורח — כפתור השליחה יישאר נעול עד אז."}
                  </p>
                )}
              </div>
            </section>

            {/* ---- message content ---- */}
            <section className="card">
              <div className="card-hd">
                <span className="sm-sec-ic">
                  <Icon name="edit-note" size={17} />
                </span>
                תוכן ההודעה
              </div>
              <div className="card-bd flex flex-col gap-3">
                {!providerConfigured && (
                  <div className="sm-note">
                    <Icon name="warning" size={17} />
                    <span>
                      {isEmail
                        ? "שירות Gmail טרם הוגדר. ניתן להגדירו במסך ההגדרות."
                        : "ספק WhatsApp טרם הוגדר. ניתן לבחור GREEN-API או Twilio במסך ההגדרות."}
                    </span>
                    <a className="sm-note-link" href="/settings?section=messaging">
                      להגדרות
                    </a>
                  </div>
                )}

                <div className="sm-seg">
                  <button
                    type="button"
                    className={`sm-seg-btn${mode === "template" ? " on" : ""}`}
                    aria-pressed={mode === "template"}
                    onClick={() => patch({ mode: "template" })}
                  >
                    <Icon name="documents" size={20} />
                    בחירה מתבנית
                  </button>
                  <button
                    type="button"
                    className={`sm-seg-btn${mode === "custom" ? " on" : ""}`}
                    aria-pressed={mode === "custom"}
                    onClick={() => patch({ mode: "custom" })}
                  >
                    <Icon name="stylus-note" size={20} />
                    כתיבת הודעה חדשה
                  </button>
                </div>

                {mode === "template" && (
                  <label className="field sm-field">
                    <span className="field-label">תבנית</span>
                    <select className="field-input" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
                      <option value="">בחירת תבנית…</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    {templates.length === 0 ? (
                      <span className="field-hint">
                        אין תבניות {isEmail ? "מייל" : "WhatsApp"} פעילות. ניתן לכתוב הודעה חדשה.
                      </span>
                    ) : templateId ? (
                      <span className="field-hint">
                        {isEmail
                          ? "הנושא והתוכן מולאו מהתבנית — אפשר לערוך אותם לפני השליחה"
                          : "התוכן מולא מהתבנית — אפשר לערוך אותו לפני השליחה"}
                      </span>
                    ) : null}
                  </label>
                )}

                {isEmail && (
                  <label className="field sm-field">
                    <span className="field-label">נושא</span>
                    <input
                      className="field-input"
                      value={subject}
                      onChange={(e) => patch({ subject: e.target.value })}
                      placeholder="נושא ההודעה"
                    />
                  </label>
                )}

                <label className="field sm-field">
                  <span className="field-label">תוכן ההודעה</span>
                  <textarea
                    ref={bodyRef}
                    className="field-input"
                    value={body}
                    onChange={(e) => patch({ body: e.target.value })}
                    placeholder="כתבו את ההודעה… לחיצה על משתנה למטה מוסיפה אותו במיקום הסמן"
                  />
                </label>

                {/* D172 — a variable the renderer cannot resolve is named, not shipped */}
                {subjectBlocked && (
                  <p className="sm-blocked">
                    <Icon name="warning" size={17} />
                    הנושא מכיל משתנה שלא ניתן לשלוח — {subjectRender?.detail}
                  </p>
                )}
                {bodyBlocked && (
                  <p className="sm-blocked">
                    <Icon name="warning" size={17} />
                    תוכן ההודעה מכיל משתנה שלא ניתן לשלוח — {bodyRender?.detail}
                  </p>
                )}

                <div className="sm-vars">
                  <p className="sm-vars-hd">
                    <Icon name="variables" size={17} />
                    משתני הזמנה — לחיצה מוסיפה לתוכן
                  </p>
                  <div className="sm-vars-list">
                    {ctx.variableDefs.map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        className="sm-var"
                        title={`{{${v.key}}}`}
                        onClick={() => insertVar(v.key)}
                      >
                        <Icon name="plus" size={13.5} />
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* ---- preview: the resolved message, exactly as it goes on the wire ---- */}
            <section className="card">
              <div className="card-hd">
                <span className="sm-sec-ic">
                  <Icon name="eye" size={17} />
                </span>
                תצוגה מקדימה
                <span className="sm-pv-hint">כפי שהאורח יקבל, עם ערכי ההזמנה</span>
              </div>
              <div className="card-bd">
                {!hasPreview ? (
                  <div className="sm-pv-empty">
                    <Icon name="drafts" size={24} />
                    {isEmail
                      ? "התצוגה תופיע כאן ברגע שיהיו נושא ותוכן"
                      : "התצוגה תופיע כאן ברגע שיהיה תוכן"}
                  </div>
                ) : (
                  <div className="sm-pv-mail">
                    <div className="sm-pv-head">
                      <span>
                        אל: <b className="ltr-num">{recipientValid ? recipient : "— (חסרה כתובת)"}</b>
                      </span>
                      {isEmail && (
                        <span>
                          נושא: <b>{previewSubject}</b>
                        </span>
                      )}
                    </div>
                    <p className="sm-pv-body">{previewBody}</p>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </div>

      <footer className="dw-ft shrink-0">
        {sendState === "sent" ? (
          <span className="btn btn-primary pointer-events-none">
            <Icon name="check-circle" size={20} /> נשלח
          </span>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!canSend} onClick={doSend}>
            <Icon name="send" size={20} />
            {sendState === "sending" ? "שולח…" : isEmail ? "שליחת המייל" : "שליחת ההודעה"}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          ביטול
        </button>
        {ctx && blockMessage && (
          <span className="sm-f-warn">
            <Icon name="warning" size={17} />
            {blockMessage}
          </span>
        )}
      </footer>
    </div>
  );
}
