"use client";

import { toast } from "sonner";
import { Icon, type IconName } from "@/components/shared/Icon";
import { COMMUNICATION_VARIABLES } from "@/lib/communications/variables";
import type { CommunicationRenderContext, TemplateContent } from "@/lib/communications/types";
import type { CommunicationActionResult } from "@/app/(dashboard)/communications/actions";

// ============================================================
// Chrome shared by the three template editors (blocks / HTML / WhatsApp).
// Shared here is UI chrome only — each editor owns its interaction model.
// ============================================================

export type PreviewDataset = { id: string; label: string; context: CommunicationRenderContext };

/** Initial values for a NEW template (from the creation window). Ignored when editing an existing row. */
export type EditorSeed = {
  name?: string;
  category?: string;
  subject?: string;
  preheader?: string;
  content?: TemplateContent;
};

export function dateTime(value: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem",
  }).format(new Date(value));
}

export const VARIABLE_GROUPS: { key: string; label: string; icon: IconName }[] = [
  { key: "guest", label: "אורח", icon: "user" },
  { key: "reservation", label: "הזמנה", icon: "confirmation-number" },
  { key: "stay", label: "שהייה", icon: "date-range" },
  { key: "room", label: "חדר", icon: "rooms" },
  { key: "payment", label: "תשלום", icon: "payments" },
  { key: "property", label: "העסק", icon: "storefront" },
];

/**
 * The variables tab: grouped, searchable, draggable ({application/x-gh-variable}
 * MIME payload) and clickable. The CALLER owns caret/focus logic — the palette
 * only reports the chosen token.
 */
export function VariablePalette({ search, canEdit, onInsert }: {
  search: string;
  canEdit: boolean;
  onInsert: (token: string) => void;
}) {
  const variables = COMMUNICATION_VARIABLES.filter(
    (v) => !search || v.label.includes(search) || v.key.includes(search.toLowerCase()),
  );
  return (
    <>
      {VARIABLE_GROUPS.map((group) => {
        const items = variables.filter((v) => v.group === group.key);
        if (!items.length) return null;
        return (
          <div key={group.key} className="flex flex-col gap-1.5">
            <h3 className="gc-varg"><Icon name={group.icon} size={13.5} /> {group.label}</h3>
            {items.map((variable) => (
              <button
                key={variable.key}
                type="button"
                className="gc-var"
                disabled={!canEdit}
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData("application/x-gh-variable", `{{${variable.key}}}`);
                  e.dataTransfer.setData("text/plain", `{{${variable.key}}}`);
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInsert(`{{${variable.key}}}`)}
                title={`הוספת ${variable.label}`}
              >
                <span>{variable.label}</span>
                {/* a long token breaks after its group's dot, never mid-word */}
                <code className="ltr-num">
                  {`{{${variable.key.split(".")[0]}.`}<wbr />{`${variable.key.split(".").slice(1).join(".")}}}`}
                </code>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}

export type TemplateVersionRow = {
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string | null;
};

/** D207 — the template's state in words: "פעילה" (has a current version), "בארכיון", or never saved. */
export function templateStateLabel(state: string): string {
  if (state === "published") return "פעילה";
  if (state === "archived") return "בארכיון";
  return "לא פעילה — שמירה תפעיל אותה";
}

/** Version history with restore (D207: the restored content becomes the current version). History itself is immutable. */
export function VersionHistoryList({ versions, canEdit, pending, onRestore }: {
  versions: TemplateVersionRow[];
  canEdit: boolean;
  pending: boolean;
  onRestore: (version: TemplateVersionRow) => void;
}) {
  if (versions.length === 0) {
    return <p className="gc-hint">התבנית עדיין לא נשמרה. כל שמירה תופיע כאן, עם התאריך ומי שמר.</p>;
  }
  // D205 — a version is named by WHEN it was published and BY WHOM; the
  // internal version number is never shown.
  return (
    <>
      {versions.map((version) => (
        <div className="gc-ver" key={version.id}>
          <span className="gc-ver-m">
            <b><time className="ltr-num" dateTime={version.publishedAt}>{dateTime(version.publishedAt)}</time></b>
            {/* the seeded first version has no publisher — say so, do not print "—" */}
            <span>{version.publishedBy ? `נשמרה ע״י ${version.publishedBy}` : "גרסה ראשונית"}</span>
          </span>
          {canEdit && (
            <button type="button" className="icon-btn" title="שחזור — התוכן הזה יהיה הפעיל" disabled={pending}
              onClick={() => onRestore(version)}>
              <Icon name="restore" size={17} label="שחזור" />
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/** D205 — a refusal names a field; move the operator to it (data-tpl-field on each editor control). */
export function focusTemplateField(field: string | undefined): void {
  if (!field) return;
  const el = document.querySelector<HTMLElement>(`[data-tpl-field="${field}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
}

/**
 * D205 follow-up / D207 — שמירה (or a restore) succeeded: the app's toast
 * (Shell <Toaster>) says so, also when the editor closes right after.
 */
export function announceTemplateSaved(result: CommunicationActionResult, close?: () => void): void {
  if (!result.success) return;
  toast.success(result.message ?? "נשמר");
  close?.();
}

/**
 * D207 — the ONE save action of every template editor: שמירה = a new version
 * that is live at once. When active automations send this template, a note
 * beside the button says the change reaches them now (no confirm dialog).
 */
export function TemplateSaveControls({ blocker, disabled, pending, liveAutomations, onSave }: {
  blocker: string | null;
  disabled: boolean;
  pending: boolean;
  liveAutomations: string[];
  onSave: () => void;
}) {
  return (
    <>
      <button type="button" className="btn btn-primary" data-tpl-save=""
        disabled={pending || disabled || Boolean(blocker)}
        title={blocker ?? undefined}
        onClick={onSave}>
        <Icon name="save" size={17} /> שמירה
      </button>
      {liveAutomations.length > 0 && (
        <span className="gc-hint flex items-center gap-1" role="note">
          <Icon name="automations" size={13.5} />
          השינוי ייכנס מיד לאוטומציה: {liveAutomations.join(", ")}
        </span>
      )}
    </>
  );
}

/** D207 — restore asks first: the chosen version's content becomes the live one. */
export function RestoreVersionDialog({ version, pending, onCancel, onConfirm }: {
  version: TemplateVersionRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog icon="restore" title="שחזור גרסה" confirmLabel="שחזור" confirmIcon="restore"
      disabled={pending} onCancel={onCancel} onConfirm={onConfirm}>
      <p className="t-body">
        התוכן מ-<time className="ltr-num" dateTime={version.publishedAt}>{dateTime(version.publishedAt)}</time> יהיה
        התבנית הפעילה מיד — גם באוטומציות ובשליחה הידנית. שינויים שלא נשמרו בעורך יאבדו.
      </p>
    </Dialog>
  );
}

/** The ONE in-panel dialog (§8 .modal), rendered into SidePanel's overlay slot. */
export function Dialog({
  icon, title, confirmLabel, confirmIcon, danger, disabled, pending, onCancel, onConfirm, children,
}: {
  icon: IconName; title: string; confirmLabel: string; confirmIcon?: IconName;
  danger?: boolean; disabled?: boolean; pending?: boolean;
  onCancel: () => void; onConfirm: () => void; children: React.ReactNode;
}) {
  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal">
        <header className="md-hd">
          <span className="md-icon"><Icon name={icon} size={24} /></span>
          <h2 className="md-title">{title}</h2>
        </header>
        <div className="md-bd flex flex-col gap-4">{children}</div>
        <footer className="md-ft">
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={disabled || pending}
            onClick={onConfirm}
          >
            {confirmIcon && <Icon name={confirmIcon} size={17} />}
            {pending ? "שולח…" : confirmLabel}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>ביטול</button>
        </footer>
      </div>
    </div>
  );
}

export function TestSendDialog({
  to, setTo, datasets, datasetId, setDatasetId, pending, onCancel, onSend,
  title = "שליחת אימייל לבדיקה", inputLabel = "כתובת אימייל",
  inputType = "email", placeholder = "name@example.com", validate,
}: {
  to: string; setTo: (v: string) => void;
  datasets: PreviewDataset[]; datasetId: string; setDatasetId: (v: string) => void;
  pending: boolean; onCancel: () => void; onSend: () => void;
  title?: string; inputLabel?: string; inputType?: string; placeholder?: string;
  validate?: (value: string) => boolean;
}) {
  const valid = validate
    ? validate(to.trim())
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());
  return (
    <Dialog
      icon="send"
      title={title}
      confirmLabel="שליחת בדיקה"
      confirmIcon="send"
      disabled={!valid}
      pending={pending}
      onCancel={onCancel}
      onConfirm={onSend}
    >
      <label className="field">
        <span className="field-label">{inputLabel}</span>
        <input className="field-input ltr-num" type={inputType} value={to} placeholder={placeholder}
          onChange={(e) => setTo(e.target.value)} />
      </label>
      {datasets.length > 0 && (
        <label className="field">
          <span className="field-label">הזמנה לדוגמה</span>
          <select className="field-input" value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
            {datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>{dataset.label}</option>
            ))}
          </select>
        </label>
      )}
      <p className="gc-note">
        <Icon name="info" size={17} />
        השליחה מיועדת לבדיקה בלבד ולא תירשם כהודעה שנשלחה לאורח.
      </p>
    </Dialog>
  );
}
