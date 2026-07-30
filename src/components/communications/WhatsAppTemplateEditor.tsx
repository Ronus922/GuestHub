"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import type { CommunicationTemplateRow } from "@/app/(dashboard)/communications/data";
import {
  publishTemplateAction, restoreTemplateVersionAction, saveTemplateDraftAction,
  sendTestWhatsAppAction, type CommunicationActionResult,
} from "@/app/(dashboard)/communications/actions";
import { STAGE_KEYS, STAGE_LABELS } from "@/lib/communications/blocks";
import { renderWhatsAppCommunication } from "@/lib/communications/renderer";
import { getVariableDefinition } from "@/lib/communications/variables";
import {
  Dialog, TestSendDialog, VariablePalette, VersionHistoryList, dateTime,
  type EditorSeed, type PreviewDataset,
} from "./editorShared";
import type { CommunicationRenderContext, RenderIssue, WhatsAppTemplateContent } from "@/lib/communications/types";

// ============================================================
// The WhatsApp template editor. A WhatsApp message is plain text + variables —
// deliberately NOT the block/HTML email model: no subject, no preheader, no
// sender identity, no markup. The preview is a chat bubble whose content is a
// TEXT NODE (never innerHTML).
// ============================================================

const MAX_LEN = 4096;

type Props = {
  template: CommunicationTemplateRow | null;
  seed?: EditorSeed;
  datasets: PreviewDataset[];
  fallbackContext: CommunicationRenderContext;
  /** Live readiness of the tenant's WhatsApp provider — gates test sends honestly. */
  whatsappReady: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canTest: boolean;
  onClose: () => void;
};

function isWhatsAppContent(value: unknown): value is WhatsAppTemplateContent {
  return Boolean(value) && (value as WhatsAppTemplateContent).kind === "whatsapp_text"
    && typeof (value as WhatsAppTemplateContent).text === "string";
}

/** D115 — two different severities, never conflated: an empty value is
 *  information (the send still happens), a skip is a warning. */
const ISSUE_LABELS: Record<RenderIssue["kind"], string> = {
  missing_required: "משתנה חובה חסר בנתוני התצוגה — השליחה תדולג להזמנות כאלה",
  missing_optional: "ריק בנתוני התצוגה — ההודעה תישלח עם ערך ריק",
  unknown_variable: "משתנה לא מוכר — השליחה תדולג",
  invalid_url: "קישור לא תקין — השליחה תדולג",
};

export function WhatsAppTemplateEditor({
  template, seed, datasets, fallbackContext, whatsappReady, canEdit, canPublish, canTest, onClose,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState(template?.name ?? seed?.name ?? "");
  const [stage, setStage] = useState(template?.category ?? seed?.category ?? "reservation");
  const [language, setLanguage] = useState(template?.language ?? "he");
  const [text, setText] = useState(() => {
    if (isWhatsAppContent(template?.draftContent)) return template.draftContent.text;
    if (isWhatsAppContent(seed?.content)) return seed.content.text;
    return "";
  });

  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<CommunicationActionResult | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [varHint, setVarHint] = useState(false);
  const [pending, startTransition] = useTransition();

  const messageRef = useRef<HTMLTextAreaElement | null>(null);

  const context = useMemo(
    () => datasets.find((d) => d.id === datasetId)?.context ?? fallbackContext,
    [datasetId, datasets, fallbackContext],
  );

  const content: WhatsAppTemplateContent = useMemo(
    () => ({ schemaVersion: 1, kind: "whatsapp_text", text }),
    [text],
  );

  const rendered = useMemo(() => renderWhatsAppCommunication(content, context), [content, context]);

  const touch = () => setDirty(true);

  const spliceToken = (token: string) => {
    const el = messageRef.current;
    if (!el) { setVarHint(true); return; }
    setVarHint(false);
    const pos = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? pos;
    setText(`${el.value.slice(0, pos)}${token}${el.value.slice(end)}`);
    touch();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos + token.length, pos + token.length);
    });
  };

  const onFieldDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const token = e.dataTransfer.getData("application/x-gh-variable");
    if (!token) return;
    e.preventDefault();
    e.stopPropagation();
    setVarHint(false);
    const el = e.currentTarget;
    const pos = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? pos;
    setText(`${el.value.slice(0, pos)}${token}${el.value.slice(end)}`);
    touch();
  };
  const allowVarDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-gh-variable")) { e.preventDefault(); e.stopPropagation(); }
  };

  const payload = {
    id: template?.id, channel: "whatsapp" as const, name, category: stage, language, content,
  };

  const publishBlocker = text.trim().length === 0
    ? "התבנית ריקה — כתבו את תוכן ההודעה לפני פרסום"
    : text.length > MAX_LEN
      ? "ההודעה ארוכה מדי"
      : null;

  const run = (action: () => Promise<CommunicationActionResult>, onDone?: () => void) =>
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      if (result.success) {
        setDirty(false);
        onDone?.();
        router.refresh();
      }
    });

  const requestClose = () => {
    if (dirty) { setDiscardOpen(true); return; }
    onClose();
  };

  const versions = template?.versions ?? [];
  const latestVersion = versions[0] ?? null;
  const versionChip = template?.version
    ? `v${template.version} · ${template.state === "published" ? "פורסמה" : "טיוטה"}`
    : "v1 · טיוטה";

  return (
    <SidePanel
      open
      onClose={requestClose}
      title={name || "תבנית"}
      titleSlot={
        <input
          className="dw-title min-w-0 rounded-xl border-[1.5px] border-white/30 bg-white/15 px-3 py-1 outline-none placeholder:text-white/55 focus:border-white"
          value={name}
          onChange={(e) => { setName(e.target.value); touch(); }}
          disabled={!canEdit}
          aria-label="שם התבנית"
          placeholder="שם התבנית"
        />
      }
      subtitle="תקשורת אורחים ← תבניות · הודעת WhatsApp — טקסט ומשתנים בלבד, ללא נושא וללא HTML"
      icon="whatsapp"
      widthClassName="w-[min(1100px,96vw)]"
      bodyClassName="p-0 overflow-hidden bg-surface"
      headerChips={
        <>
          <span className="chip chip-onbrand"><Icon name="whatsapp" size={13.5} /> WhatsApp</span>
          <span className="chip chip-onbrand"><Icon name="category" size={13.5} /> {STAGE_LABELS[stage]}</span>
          <span className="chip chip-onbrand"><Icon name="tag" size={13.5} /> {versionChip}</span>
          {latestVersion && (
            <span className="chip chip-onbrand">
              <Icon name="publish" size={13.5} />
              פורסמה {dateTime(latestVersion.publishedAt)}
              {latestVersion.publishedBy ? ` · ${latestVersion.publishedBy}` : ""}
            </span>
          )}
        </>
      }
      overlay={
        discardOpen ? (
          <Dialog
            icon="warning"
            title="שינויים שלא נשמרו"
            confirmLabel="סגירה בלי לשמור"
            danger
            onCancel={() => setDiscardOpen(false)}
            onConfirm={onClose}
          >
            <p className="t-body">יש שינויים בתבנית שטרם נשמרו. סגירת החלון תשליך אותם.</p>
          </Dialog>
        ) : testOpen ? (
          <TestSendDialog
            title="שליחת הודעת בדיקה ב-WhatsApp"
            inputLabel="מספר טלפון"
            inputType="tel"
            placeholder="050-1234567"
            validate={(value) => value.replace(/\D/g, "").length >= 9}
            to={testTo}
            setTo={setTestTo}
            datasets={datasets}
            datasetId={datasetId}
            setDatasetId={setDatasetId}
            pending={pending}
            onCancel={() => setTestOpen(false)}
            onSend={() => run(
              () => sendTestWhatsAppAction({ ...payload, to: testTo, reservationId: datasetId || null }),
              () => setTestOpen(false),
            )}
          />
        ) : undefined
      }
      footer={
        <>
          {canPublish && (
            <button type="button" className="btn btn-primary"
              disabled={pending || !canEdit || Boolean(publishBlocker)}
              title={publishBlocker ?? undefined}
              onClick={() => run(() => publishTemplateAction(payload))}>
              <Icon name="publish" size={17} /> פרסום
            </button>
          )}
          {canEdit && (
            <button type="button" className="btn btn-secondary" disabled={pending || text.length > MAX_LEN}
              onClick={() => run(() => saveTemplateDraftAction(payload), () => { if (!template) onClose(); })}>
              <Icon name="draft" size={17} /> שמירת טיוטה
            </button>
          )}
          {canTest && (
            <button type="button" className="btn btn-secondary"
              disabled={pending || !whatsappReady || !text.trim()}
              title={whatsappReady ? undefined : "אין ספק WhatsApp מחובר — חברו ספק בהגדרות ההודעות"}
              onClick={() => setTestOpen(true)}>
              <Icon name="send" size={17} /> שליחת בדיקה
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={requestClose}>ביטול</button>
          <span className="gc-dirty">
            <i className={`gc-dot${dirty ? " is-dirty" : ""}`} aria-hidden="true" />
            {pending ? "שומר…" : dirty ? "יש שינויים שטרם נשמרו" : "אין שינויים"}
          </span>
        </>
      }
    >
      <div className="gc-b2">
        {/* ---------- RIGHT: variables ---------- */}
        <aside className="gc-col gc-col-start">
          <div className="gc-colhd"><Icon name="variables" size={20} /> משתנים</div>
          <input
            className="field-input gc-select"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש משתנה"
            aria-label="חיפוש משתנה"
          />
          <p className="gc-hint">גררו משתנה להודעה, או לחצו כדי להוסיף במיקום הסמן.</p>
          <p className="gc-hint">
            משתנה חסר נשלח ריק. <code className="ltr-num">{"{{guest.first_name|אורח}}"}</code> קובע
            ערך חלופי, <code className="ltr-num">{"{{guest.email!}}"}</code> מסמן חובה — הזמנה בלי ערך תדולג.
          </p>
          {varHint && (
            <p className="gc-varhint" role="status">
              <Icon name="touch" size={17} />
              הציבו את הסמן בתוך ההודעה כדי להוסיף את המשתנה
            </p>
          )}
          <VariablePalette search={search} canEdit={canEdit} onInsert={spliceToken} />

          <div className="gc-colhd"><Icon name="history" size={20} /> היסטוריית גרסאות</div>
          <VersionHistoryList versions={versions} canEdit={canEdit} pending={pending}
            onRestore={(versionId) => run(() => restoreTemplateVersionAction(versionId))} />
        </aside>

        {/* ---------- MAIN: message + preview ---------- */}
        <section className="gc-col gc-col-canvas">
          <div className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="whatsapp" size={20} /> תוכן ההודעה
              <span className="gc-ph-d">טקסט חופשי, אימוג׳י ומשתני {"{{...}}"}</span>
            </div>
            <div className="card-bd flex flex-col gap-3">
              <label className="field">
                <span className="gc-label-row">
                  <span className="field-label">הודעה</span>
                  <span className={`gc-cnt${text.length > MAX_LEN ? " is-over" : ""}`}>
                    {text.length.toLocaleString("he-IL")}/{MAX_LEN.toLocaleString("he-IL")} תווים
                  </span>
                </span>
                <textarea
                  ref={messageRef}
                  className="field-input"
                  dir="auto"
                  rows={12}
                  disabled={!canEdit}
                  value={text}
                  placeholder={"שלום {{guest.first_name}},\nכתבו כאן את תוכן ההודעה…"}
                  onDragOver={allowVarDrop}
                  onDrop={onFieldDrop}
                  onChange={(e) => { setText(e.target.value); touch(); }}
                  aria-label="תוכן הודעת ה-WhatsApp"
                />
                {text.length > MAX_LEN && (
                  <span className="field-msg" role="alert">ההודעה חורגת מהאורך המרבי של WhatsApp</span>
                )}
              </label>
            </div>
          </div>

          {/* live preview — a chat bubble; the content is a TEXT NODE, never innerHTML */}
          <div className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="eye" size={20} /> תצוגה מקדימה
              {datasets.length > 0 && (
                <select
                  className="field-input gc-select"
                  style={{ marginInlineStart: "auto" }}
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                  aria-label="הזמנה לתצוגה"
                >
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>{dataset.label}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="card-bd">
              <div className="gc-wa-chat" dir="rtl">
                <div className="gc-wa-bubble" dir="auto">
                  {rendered.text || "ההודעה ריקה — התצוגה תתעדכן בזמן הכתיבה"}
                </div>
              </div>
            </div>
          </div>

          {/* issues */}
          {rendered.issues.length > 0 && (
            <div className="card">
              <div className="card-hd flex items-center gap-2"><Icon name="warning" size={20} /> בדיקות תוכן</div>
              <div className="card-bd flex flex-col gap-2">
                {rendered.issues.map((issue) => (
                  <p key={`${issue.kind}:${issue.key}`}
                    className={issue.kind === "missing_optional" ? "gc-hint" : "field-msg"}
                    role={issue.kind === "missing_optional" ? undefined : "alert"}>
                    <code className="ltr-num">{`{{${issue.key}}}`}</code>
                    {" — "}
                    {getVariableDefinition(issue.key)?.label ?? ""} {ISSUE_LABELS[issue.kind]}
                  </p>
                ))}
                {!rendered.canSend && (
                  <p className="field-msg" role="alert">משתנה חובה (!) חסר או משתנה לא מוכר — השליחה תדולג עבור הזמנות כאלה.</p>
                )}
              </div>
            </div>
          )}

          <div className="gc-meta-grid">
            <label className="field">
              <span className="field-label">שלב בחיי ההזמנה</span>
              <select className="field-input" disabled={!canEdit} value={stage}
                onChange={(e) => { setStage(e.target.value); touch(); }}>
                {STAGE_KEYS.map((key) => <option key={key} value={key}>{STAGE_LABELS[key]}</option>)}
              </select>
              <span className="field-hint">לסינון וארגון בלבד — אינו טריגר לשליחה</span>
            </label>
            <label className="field">
              <span className="field-label">שפה</span>
              <select className="field-input" disabled={!canEdit} value={language}
                onChange={(e) => { setLanguage(e.target.value as "he" | "en"); touch(); }}>
                <option value="he">עברית</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>

          {notice && (
            <p className={notice.success ? "gc-note" : "field-msg"} role="status">
              {notice.success ? notice.message : notice.error}
            </p>
          )}
        </section>
      </div>
    </SidePanel>
  );
}
