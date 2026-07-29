"use client";

import { Icon, type IconName } from "@/components/shared/Icon";
import { COMMUNICATION_VARIABLES } from "@/lib/communications/variables";
import type { CommunicationRenderContext, TemplateContent } from "@/lib/communications/types";

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
                <code className="ltr-num">{`{{${variable.key}}}`}</code>
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

/** Published-version history with restore-to-draft. History itself is immutable. */
export function VersionHistoryList({ versions, canEdit, pending, onRestore }: {
  versions: TemplateVersionRow[];
  canEdit: boolean;
  pending: boolean;
  onRestore: (versionId: string) => void;
}) {
  if (versions.length === 0) {
    return <p className="gc-hint">עדיין לא פורסמה גרסה. פרסום ייצור את v1.</p>;
  }
  return (
    <>
      {versions.map((version) => (
        <div className="gc-ver" key={version.id}>
          <span className="chip chip-paid">v{version.version}</span>
          <span className="gc-ver-m">
            {/* the seeded v1 has no publisher — say so, do not print "—" */}
            <b>{version.publishedBy ? `פרסום · ${version.publishedBy}` : "גרסה ראשונית"}</b>
            <span>{dateTime(version.publishedAt)}</span>
          </span>
          {canEdit && (
            <button type="button" className="icon-btn" title="שחזור התוכן לטיוטה" disabled={pending}
              onClick={() => onRestore(version.id)}>
              <Icon name="restore" size={17} label="שחזור" />
            </button>
          )}
        </div>
      ))}
    </>
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
