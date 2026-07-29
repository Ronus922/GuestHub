"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import type { CommunicationTemplateRow } from "@/app/(dashboard)/communications/data";
import {
  publishTemplateAction, restoreTemplateVersionAction, saveTemplateDraftAction,
  sendTestEmailAction, type CommunicationActionResult,
} from "@/app/(dashboard)/communications/actions";
import { STAGE_KEYS, STAGE_LABELS } from "@/lib/communications/blocks";
import { renderHtmlCommunication, renderTemplateString } from "@/lib/communications/renderer";
import { htmlTemplateContentSchema } from "@/lib/communications/schemas";
import { getVariableDefinition } from "@/lib/communications/variables";
import {
  Dialog, TestSendDialog, VariablePalette, VersionHistoryList, dateTime,
  type EditorSeed, type PreviewDataset,
} from "./editorShared";
import type { CommunicationRenderContext, HtmlTemplateContent, RenderIssue } from "@/lib/communications/types";

// ============================================================
// The HTML template editor — for operators who paste a ready-made email
// document (or fragment) instead of composing blocks. {{...}} variables still
// interpolate; the preview shows the real bytes.
//
// SECURITY INVARIANT: the pasted HTML is NEVER dangerouslySetInnerHTML'd into
// the dashboard DOM. Canvas AND preview are exclusively a sandbox="" iframe.
// ============================================================

type Props = {
  template: CommunicationTemplateRow | null;
  seed?: EditorSeed;
  datasets: PreviewDataset[];
  fallbackContext: CommunicationRenderContext;
  senderAddress: string | null;
  canEdit: boolean;
  canPublish: boolean;
  canTest: boolean;
  onClose: () => void;
};

function isHtmlContent(value: unknown): value is HtmlTemplateContent {
  return Boolean(value) && (value as HtmlTemplateContent).kind === "html"
    && typeof (value as HtmlTemplateContent).html === "string";
}

const ISSUE_LABELS: Record<RenderIssue["kind"], string> = {
  missing_required: "משתנה נדרש חסר בנתוני התצוגה",
  missing_optional: "משתנה אופציונלי ריק בנתוני התצוגה",
  unknown_variable: "משתנה לא מוכר",
  invalid_url: "קישור לא תקין",
};

export function HtmlTemplateEditor({
  template, seed, datasets, fallbackContext, senderAddress, canEdit, canPublish, canTest, onClose,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState(template?.name ?? seed?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? seed?.subject ?? "");
  const [preheader, setPreheader] = useState(template?.preheader ?? seed?.preheader ?? "");
  const [sender, setSender] = useState(template?.senderDisplayName ?? "");
  const [replyTo, setReplyTo] = useState(template?.replyTo ?? "");
  const [stage, setStage] = useState(template?.category ?? seed?.category ?? "reservation");
  const [language, setLanguage] = useState(template?.language ?? "he");
  const [html, setHtml] = useState(() => {
    if (isHtmlContent(template?.draftContent)) return template.draftContent.html;
    if (isHtmlContent(seed?.content)) return seed.content.html;
    return "";
  });

  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<CommunicationActionResult | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [testTo, setTestTo] = useState(senderAddress ?? "");
  const [pending, startTransition] = useTransition();

  type FieldKind = "subject" | "preheader" | "html";
  const activeField = useRef<{ kind: FieldKind; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const [varHint, setVarHint] = useState(false);

  const context = useMemo(
    () => datasets.find((d) => d.id === datasetId)?.context ?? fallbackContext,
    [datasetId, datasets, fallbackContext],
  );

  const content: HtmlTemplateContent = useMemo(
    () => ({ schemaVersion: 1, kind: "html", html }),
    [html],
  );

  // Same validate-first pattern as the blocks editor: the schema refuses
  // <script>, and a schema failure blocks save/publish with a visible reason.
  const invalid = useMemo(() => {
    const parsed = htmlTemplateContentSchema.safeParse(content);
    if (parsed.success) return null;
    return parsed.error.issues.some((i) => i.message.includes("script"))
      ? "תגיות script אינן מותרות בתבנית — הסירו אותן כדי לשמור ולפרסם"
      : "תוכן ה-HTML ארוך מדי או לא תקין";
  }, [content]);

  const rendered = useMemo(
    () => renderHtmlCommunication(content, context, { highlight: mode === "edit", preheader }),
    [content, context, mode, preheader],
  );
  const renderedSubject = useMemo(() => renderTemplateString(subject, context), [subject, context]);

  const touch = () => setDirty(true);

  const applyField = (kind: FieldKind, next: string) => {
    if (kind === "subject") setSubject(next);
    else if (kind === "preheader") setPreheader(next);
    else setHtml(next);
    touch();
  };

  const spliceToken = (el: HTMLInputElement | HTMLTextAreaElement, kind: FieldKind, token: string, pos: number) => {
    const end = el.selectionEnd != null && el.selectionEnd >= pos ? el.selectionEnd : pos;
    applyField(kind, `${el.value.slice(0, pos)}${token}${el.value.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos + token.length, pos + token.length);
    });
  };

  const insertVariable = (token: string) => {
    const field = activeField.current;
    if (!field || !field.el.isConnected) { setVarHint(true); return; }
    setVarHint(false);
    spliceToken(field.el, field.kind, token, field.el.selectionStart ?? field.el.value.length);
  };

  const onFieldDrop = (e: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>, kind: FieldKind) => {
    const token = e.dataTransfer.getData("application/x-gh-variable");
    if (!token) return;
    e.preventDefault();
    e.stopPropagation();
    setVarHint(false);
    spliceToken(e.currentTarget, kind, token, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
  };
  const allowVarDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-gh-variable")) { e.preventDefault(); e.stopPropagation(); }
  };

  const payload = {
    id: template?.id, channel: "email" as const, name, subject,
    senderDisplayName: sender, replyTo, preheader, category: stage, language, content,
  };

  const publishBlocker = subject.trim().length < 2
    ? "נדרש נושא לפרסום"
    : html.trim().length === 0
      ? "התבנית ריקה — הדביקו תוכן HTML לפני פרסום"
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
      subtitle="תקשורת אורחים ← תבניות · עורך HTML — הדביקו מסמך שלם או פרגמנט; משתני {{...}} ימולאו בשליחה"
      icon="documents"
      widthClassName="w-[min(1400px,96vw)]"
      bodyClassName="p-0 overflow-hidden bg-surface"
      headerChips={
        <>
          <span className="chip chip-onbrand"><Icon name="mail" size={13.5} /> אימייל · HTML</span>
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
            to={testTo}
            setTo={setTestTo}
            datasets={datasets}
            datasetId={datasetId}
            setDatasetId={setDatasetId}
            pending={pending}
            onCancel={() => setTestOpen(false)}
            onSend={() => run(
              () => sendTestEmailAction({ ...payload, to: testTo, reservationId: datasetId || null }),
              () => setTestOpen(false),
            )}
          />
        ) : undefined
      }
      footer={
        <>
          {canPublish && (
            <button type="button" className="btn btn-primary"
              disabled={pending || !canEdit || Boolean(invalid) || Boolean(publishBlocker)}
              title={publishBlocker ?? undefined}
              onClick={() => run(() => publishTemplateAction(payload))}>
              <Icon name="publish" size={17} /> פרסום
            </button>
          )}
          {canEdit && (
            <button type="button" className="btn btn-secondary" disabled={pending || Boolean(invalid)}
              onClick={() => run(() => saveTemplateDraftAction(payload), () => { if (!template) onClose(); })}>
              <Icon name="draft" size={17} /> שמירת טיוטה
            </button>
          )}
          {canTest && (
            <button type="button" className="btn btn-secondary" disabled={pending || Boolean(invalid)}
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
          <p className="gc-hint">גררו משתנה לשדה או לקוד, או לחצו כדי להוסיף במיקום הסמן.</p>
          {varHint && (
            <p className="gc-varhint" role="status">
              <Icon name="touch" size={17} />
              בחרו שדה טקסט או את אזור הקוד שאליו תרצו להוסיף את המשתנה
            </p>
          )}
          <VariablePalette search={search} canEdit={canEdit} onInsert={insertVariable} />

          <div className="gc-colhd"><Icon name="history" size={20} /> היסטוריית גרסאות</div>
          <VersionHistoryList versions={versions} canEdit={canEdit} pending={pending}
            onRestore={(versionId) => run(() => restoreTemplateVersionAction(versionId))} />
        </aside>

        {/* ---------- MAIN: meta + code/preview ---------- */}
        <section className="gc-col gc-col-canvas">
          <div className="gc-tools">
            <div className="gc-seg">
              <button type="button" className="gc-segb" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
                <Icon name="edit" size={17} /> קוד
              </button>
              <button type="button" className="gc-segb" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
                <Icon name="eye" size={17} /> תצוגה מקדימה
              </button>
            </div>
            {datasets.length > 0 && (
              <select
                className="field-input gc-select"
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

          {/* פרטי האימייל */}
          <div className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="subject" size={20} /> פרטי האימייל
              <span className="gc-ph-d">שם שולח, נושא וטקסט מקדים</span>
            </div>
            <div className="card-bd flex flex-col gap-3">
              <div className="gc-meta-grid">
                <label className="field">
                  <span className="field-label">שם השולח</span>
                  <input className="field-input" value={sender} disabled={!canEdit}
                    onChange={(e) => { setSender(e.target.value); touch(); }}
                    placeholder="ברירת המחדל של הערוץ" />
                </label>
                <label className="field">
                  <span className="field-label">כתובת Reply-To</span>
                  <input className="field-input ltr-num" type="email" value={replyTo} disabled={!canEdit}
                    onChange={(e) => { setReplyTo(e.target.value); touch(); }}
                    placeholder="ברירת המחדל של הערוץ" />
                </label>
              </div>
              <label className="field">
                <span className="gc-label-row">
                  <span className="field-label">נושא האימייל</span>
                  <span className="gc-cnt">{subject.length} תווים</span>
                </span>
                <input className="field-input" value={subject} disabled={!canEdit}
                  onFocus={(e) => { activeField.current = { kind: "subject", el: e.currentTarget }; }}
                  onDragOver={allowVarDrop} onDrop={(e) => onFieldDrop(e, "subject")}
                  onChange={(e) => { setSubject(e.target.value); touch(); }} />
              </label>
              <label className="field">
                <span className="gc-label-row">
                  <span className="field-label">טקסט מקדים (Preheader)</span>
                  <span className="gc-cnt">{preheader.length} תווים</span>
                </span>
                <input className="field-input" value={preheader} disabled={!canEdit}
                  onFocus={(e) => { activeField.current = { kind: "preheader", el: e.currentTarget }; }}
                  onDragOver={allowVarDrop} onDrop={(e) => onFieldDrop(e, "preheader")}
                  onChange={(e) => { setPreheader(e.target.value); touch(); }}
                  placeholder="התקציר שמופיע ליד הנושא בתיבת הדואר" />
              </label>
            </div>
          </div>

          <div className="gc-mail">
            <div className="gc-envelope">
              <p><b>מאת</b> <span>{sender || "שם העסק"} <span className="ltr-num">&lt;{senderAddress ?? "ערוץ טרם חובר"}&gt;</span></span></p>
              <p><b>אל</b> <span className="ltr-num">{String(context.values["guest.email"] ?? "guest@example.com")}</span></p>
              <p><b>נושא</b> <span className="gc-envelope-s">{renderedSubject.value || "—"}</span></p>
            </div>

            {mode === "edit" ? (
              <textarea
                className="field-input gc-code"
                dir="ltr"
                spellCheck={false}
                disabled={!canEdit}
                value={html}
                placeholder={"<!doctype html>\n<html dir=\"rtl\" lang=\"he\">…\n\nאפשר להדביק מסמך שלם או פרגמנט. משתנים: {{guest.first_name}}"}
                onFocus={(e) => { activeField.current = { kind: "html", el: e.currentTarget }; }}
                onDragOver={allowVarDrop}
                onDrop={(e) => onFieldDrop(e, "html")}
                onChange={(e) => { setHtml(e.target.value); touch(); }}
                aria-label="תוכן HTML של התבנית"
              />
            ) : html.trim() ? (
              <iframe
                className="block w-full border-0"
                style={{ height: 720 }}
                sandbox=""
                srcDoc={rendered.html}
                title="תצוגה מקדימה של האימייל"
              />
            ) : (
              <p className="gc-canvas-empty">
                <Icon name="code" size={24} />
                אין עדיין תוכן — עברו למצב קוד והדביקו את ה-HTML של האימייל
              </p>
            )}
          </div>

          {/* issues */}
          {(invalid || rendered.issues.length > 0) && (
            <div className="card">
              <div className="card-hd flex items-center gap-2"><Icon name="warning" size={20} /> בדיקות תוכן</div>
              <div className="card-bd flex flex-col gap-2">
                {invalid && <p className="field-msg" role="alert">{invalid}</p>}
                {rendered.issues.map((issue) => (
                  <p key={`${issue.kind}:${issue.key}:${issue.detail ?? ""}`}
                    className={issue.kind === "missing_optional" ? "gc-hint" : "field-msg"}
                    role={issue.kind === "missing_optional" ? undefined : "alert"}>
                    {/* a document-scan finding points at an ATTRIBUTE, not a variable —
                        showing it as {{html.href}} would send the author hunting for a
                        token that does not exist. detail names the attribute and value. */}
                    <code className="ltr-num">{issue.detail ?? `{{${issue.key}}}`}</code>
                    {" — "}
                    {getVariableDefinition(issue.key)?.label ?? ""} {ISSUE_LABELS[issue.kind]}
                  </p>
                ))}
                {!rendered.canSend && (
                  <p className="field-msg" role="alert">משתנה נדרש חסר או לא מוכר — שליחה תדולג עבור הזמנות כאלה.</p>
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
