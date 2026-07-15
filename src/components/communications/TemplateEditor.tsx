"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import type { CommunicationTemplateRow } from "@/app/(dashboard)/communications/data";
import {
  publishTemplateAction, restoreTemplateVersionAction, saveTemplateDraftAction,
  sendTestEmailAction, type CommunicationActionResult,
} from "@/app/(dashboard)/communications/actions";
import {
  ACTION_URL_OPTIONS, BLOCK_GROUPS, BLOCK_LIBRARY, BLOCK_TEXT_PLACEHOLDER,
  CONDITION_LABELS, STAGE_KEYS, STAGE_LABELS, STYLE_OPTIONS, TEXT_BLOCKS,
  blockMeta, defaultTemplateContent, makeBlock, usageLabel,
} from "@/lib/communications/blocks";
import {
  renderCommunicationBlocks, renderStructuredCommunication, renderTemplateString,
  type RenderedBlock,
} from "@/lib/communications/renderer";
import { structuredTemplateContentSchema } from "@/lib/communications/schemas";
import { COMMUNICATION_VARIABLES } from "@/lib/communications/variables";
import type {
  BlockCondition, CommunicationRenderContext, RenderedCommunication,
  StructuredTemplateContent, TemplateBlock, TemplateBlockType,
} from "@/lib/communications/types";

// ============================================================
// The template editor — ref/screens/CreateGuestCommunicationWindowes.png
//
// It is the canonical <SidePanel> (§7), NOT a second drawer: same blue bar, same
// close/Esc/focus-trap, same footer. Inside it, the reference's three columns:
//   palette (302px) · canvas (1fr) · settings (318px)     [RTL: right → left]
//
// The canvas paints the EMAIL'S OWN BYTES (renderCommunicationBlocks), so what
// the operator approves is literally what the guest receives. Preview mode goes
// further and mounts the whole document in an iframe.
//
// NOTE on width: the reference bundle sets the drawer to 50%, but it was
// captured at a 2218px viewport. Held to 50% on a real 1440px screen the canvas
// would fall under the email's own 640px, so the panel is sized to fit the
// reference's GEOMETRY (302 + 640 + 318) instead of copying its percentage.
// ============================================================

type PreviewDataset = { id: string; label: string; context: CommunicationRenderContext };

export type EditorSeed = { name?: string; category?: string; content?: StructuredTemplateContent };

type Props = {
  template: CommunicationTemplateRow | null;
  /** Initial values for a NEW template (from the creation window). Ignored when editing an existing row. */
  seed?: EditorSeed;
  datasets: PreviewDataset[];
  fallbackContext: CommunicationRenderContext;
  senderAddress: string | null;
  canEdit: boolean;
  canPublish: boolean;
  canTest: boolean;
  onClose: () => void;
};

const VARIABLE_GROUPS: { key: string; label: string; icon: IconName }[] = [
  { key: "guest", label: "אורח", icon: "user" },
  { key: "reservation", label: "הזמנה", icon: "confirmation-number" },
  { key: "stay", label: "שהייה", icon: "date-range" },
  { key: "room", label: "חדר", icon: "rooms" },
  { key: "payment", label: "תשלום", icon: "payments" },
  { key: "property", label: "העסק", icon: "storefront" },
];

function isContent(value: unknown): value is StructuredTemplateContent {
  return Boolean(value) && (value as StructuredTemplateContent).schemaVersion === 1
    && Array.isArray((value as StructuredTemplateContent).blocks);
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem",
  }).format(new Date(value));
}

export function TemplateEditor({
  template, seed, datasets, fallbackContext, senderAddress, canEdit, canPublish, canTest, onClose,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState(template?.name ?? seed?.name ?? "תבנית חדשה");
  const [subject, setSubject] = useState(template?.subject ?? "ההזמנה שלכם אושרה – {{reservation.number}}");
  const [preheader, setPreheader] = useState(template?.preheader ?? "");
  const [sender, setSender] = useState(template?.senderDisplayName ?? "");
  const [replyTo, setReplyTo] = useState(template?.replyTo ?? "");
  const [stage, setStage] = useState(template?.category ?? seed?.category ?? "reservation");
  const [language, setLanguage] = useState(template?.language ?? "he");
  const [content, setContent] = useState<StructuredTemplateContent>(
    isContent(template?.draftContent) ? template.draftContent
      : seed?.content ?? defaultTemplateContent(),
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"blocks" | "variables">("blocks");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<CommunicationActionResult | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [testTo, setTestTo] = useState(senderAddress ?? "");
  const [pending, startTransition] = useTransition();

  // Drag-and-drop + direct-editing state.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [varHint, setVarHint] = useState(false);
  // The active drag payload for BLOCK drags (palette→canvas or canvas reorder).
  // Variable drags carry their token in dataTransfer instead, so a variable drag
  // never trips the canvas block-insertion indicator.
  const drag = useRef<{ kind: "new"; type: TemplateBlockType } | { kind: "move"; id: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  type FieldKind = "subject" | "preheader" | "block" | "label" | "url";
  // The field a variable click inserts into. Captured on focus; the palette
  // buttons preventDefault on mousedown so focus (and the caret) survive the click.
  const activeField = useRef<{ kind: FieldKind; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);

  const context = useMemo(
    () => datasets.find((d) => d.id === datasetId)?.context ?? fallbackContext,
    [datasetId, datasets, fallbackContext],
  );

  const selectedBlock = content.blocks.find((b) => b.id === selected) ?? null;

  // A labeled select bound to one style token on the selected block (§8).
  const styleSelect = (
    field: keyof TemplateBlock["data"], label: string,
    opts: readonly { value: string; label: string }[], def: string,
  ) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        className="field-input"
        disabled={!canEdit}
        value={String(selectedBlock?.data[field] ?? def)}
        onChange={(e) => patchData({ [field]: e.target.value } as Partial<TemplateBlock["data"]>)}
      >
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
  const fieldToggle = (
    field: keyof TemplateBlock["data"], label: string, defaultOn: boolean,
  ) => {
    const on = selectedBlock?.data[field] === undefined ? defaultOn : Boolean(selectedBlock?.data[field]);
    return (
      <span className="gc-toggle">
        <button type="button" className="gc-sw" role="switch" disabled={!canEdit}
          aria-checked={on} aria-label={label}
          onClick={() => patchData({ [field]: !on } as Partial<TemplateBlock["data"]>)} />
        {label}
      </span>
    );
  };

  // The renderer parses STRICTLY — it is the same code that produces what a guest
  // receives, and it must refuse malformed content. But mid-edit content is
  // legitimately invalid for a keystroke or two (clear the button's label and it
  // has no label), and a throw inside useMemo would tear the editor down and take
  // the unsaved template with it. So validate first, and hold the last good render.
  const invalid = useMemo(() => {
    const parsed = structuredTemplateContentSchema.safeParse(content);
    return parsed.success ? null : "יש בלוק עם שדה חסר או ארוך מדי — השלימו אותו כדי לראות תצוגה ולפרסם";
  }, [content]);

  const lastGood = useRef<{ blocks: RenderedBlock[]; doc: RenderedCommunication } | null>(null);
  const render = useMemo(() => {
    if (invalid) return lastGood.current;
    const next = {
      blocks: renderCommunicationBlocks(content, context, { highlight: true }),
      doc: renderStructuredCommunication(content, context, { preheader }),
    };
    lastGood.current = next;
    return next;
  }, [content, context, preheader, invalid]);

  const blocks = render?.blocks ?? [];
  const emailDoc = render?.doc ?? null;
  const renderedSubject = useMemo(() => renderTemplateString(subject, context), [subject, context]);

  const touch = () => setDirty(true);
  const patch = (updater: (blocks: TemplateBlock[]) => TemplateBlock[]) => {
    setContent((current) => ({ ...current, blocks: updater(current.blocks) }));
    touch();
  };
  const patchSelected = (change: Partial<TemplateBlock>) =>
    patch((blocks) => blocks.map((b) => (b.id === selected ? { ...b, ...change } : b)));
  const patchData = (change: Partial<TemplateBlock["data"]>) =>
    patch((blocks) => blocks.map((b) => (b.id === selected ? { ...b, data: { ...b.data, ...change } } : b)));

  const insertBlockAt = (type: TemplateBlockType, at: number) => {
    const block = makeBlock(type, `${type}-${crypto.randomUUID().slice(0, 8)}`);
    patch((blocks) => [...blocks.slice(0, at), block, ...blocks.slice(at)]);
    setSelected(block.id);
    // A dropped text block should be typeable at once (§3).
    if (TEXT_BLOCKS.includes(type)) setEditingId(block.id);
  };
  const addBlock = (type: TemplateBlockType) => insertBlockAt(type, content.blocks.length);
  const moveBlockTo = (id: string, at: number) =>
    patch((blocks) => {
      const from = blocks.findIndex((b) => b.id === id);
      if (from < 0) return blocks;
      const without = [...blocks.slice(0, from), ...blocks.slice(from + 1)];
      const target = at > from ? at - 1 : at;
      return [...without.slice(0, target), blocks[from], ...without.slice(target)];
    });
  const moveBlock = (id: string, direction: -1 | 1) =>
    patch((blocks) => {
      const index = blocks.findIndex((b) => b.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= blocks.length) return blocks;
      const next = [...blocks];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const duplicateBlock = (id: string) =>
    patch((blocks) => {
      const index = blocks.findIndex((b) => b.id === id);
      if (index < 0) return blocks;
      const copy = { ...blocks[index], id: `${blocks[index].type}-${crypto.randomUUID().slice(0, 8)}` };
      return [...blocks.slice(0, index + 1), copy, ...blocks.slice(index + 1)];
    });
  const removeBlock = (id: string) => {
    patch((blocks) => blocks.filter((b) => b.id !== id));
    if (selected === id) setSelected(null);
    if (editingId === id) setEditingId(null);
  };

  // Compute the insertion slot from the pointer Y over the stacked block list.
  const canvasDragOver = (e: React.DragEvent) => {
    if (!drag.current || !canvasRef.current) return;
    e.preventDefault();
    const els = [...canvasRef.current.querySelectorAll<HTMLElement>("[data-blk]")];
    let idx = els.length;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { idx = i; break; }
    }
    setDropIndex(idx);
  };
  const canvasDrop = (e: React.DragEvent) => {
    const payload = drag.current;
    if (!payload) return;
    e.preventDefault();
    const at = dropIndex ?? content.blocks.length;
    if (payload.kind === "new") insertBlockAt(payload.type, at);
    else moveBlockTo(payload.id, at);
    drag.current = null;
    setDropIndex(null);
  };
  const endDrag = () => { drag.current = null; setDropIndex(null); };

  const applyField = (kind: FieldKind, next: string) => {
    if (kind === "subject") setSubject(next);
    else if (kind === "preheader") setPreheader(next);
    else if (kind === "label") patchData({ label: next });
    else if (kind === "url") patchData({ url: next });
    else patchData({ text: next });
    touch();
  };

  /** Splice a token into a text field at `pos`, restore focus + caret. */
  const spliceToken = (el: HTMLInputElement | HTMLTextAreaElement, kind: FieldKind, token: string, pos: number) => {
    const end = el.selectionEnd != null && el.selectionEnd >= pos ? el.selectionEnd : pos;
    applyField(kind, `${el.value.slice(0, pos)}${token}${el.value.slice(end)}`);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos + token.length, pos + token.length);
    });
  };

  // Click-to-insert: into the currently focused field. When nothing is focused,
  // say so — never silently do nothing (§6).
  const insertVariable = (token: string) => {
    const field = activeField.current;
    if (!field || !field.el.isConnected) { setVarHint(true); return; }
    setVarHint(false);
    spliceToken(field.el, field.kind, token, field.el.selectionStart ?? field.el.value.length);
  };

  // Drop-to-insert: at the caret the browser placed under the pointer during the
  // drag (selectionStart reflects it for inputs/textareas), else at the end.
  const onFieldDrop = (e: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>, kind: FieldKind) => {
    const token = e.dataTransfer.getData("application/x-gh-variable");
    if (!token) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    setVarHint(false);
    spliceToken(el, kind, token, el.selectionStart ?? el.value.length);
  };
  const allowVarDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-gh-variable")) { e.preventDefault(); e.stopPropagation(); }
  };

  const payload = {
    id: template?.id, name, subject, senderDisplayName: sender, replyTo,
    preheader, category: stage, language, content,
  };

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

  // The app has ONE dialog language. A native confirm() would drop unstyled LTR
  // browser chrome into an RTL panel and block the thread.
  const requestClose = () => {
    if (dirty) { setDiscardOpen(true); return; }
    onClose();
  };

  const versions = template?.versions ?? [];
  const latestVersion = versions[0] ?? null;
  const usedLabel = usageLabel(template?.usedBy ?? 0);
  const versionChip = template?.version
    ? `v${template.version} · ${template.state === "published" ? "פורסמה" : "טיוטה"}`
    : "v1 · טיוטה";

  const palette = BLOCK_LIBRARY.filter((b) => !search || b.label.includes(search));
  const variables = COMMUNICATION_VARIABLES.filter(
    (v) => !search || v.label.includes(search) || v.key.includes(search.toLowerCase()),
  );

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
      subtitle="תקשורת אורחים ← תבניות · עורך תוכן בלבד — טריגר, תזמון ותנאי שליחה מוגדרים במסך האוטומציות"
      icon="documents"
      widthClassName="w-[min(1400px,96vw)]"
      bodyClassName="p-0 overflow-hidden bg-surface"
      headerChips={
        <>
          <span className="chip chip-onbrand"><Icon name="mail" size={13.5} /> אימייל</span>
          <span className="chip chip-onbrand"><Icon name="category" size={13.5} /> {STAGE_LABELS[stage]}</span>
          <span className="chip chip-onbrand"><Icon name="tag" size={13.5} /> {versionChip}</span>
          {latestVersion && (
            <span className="chip chip-onbrand">
              <Icon name="publish" size={13.5} />
              פורסמה {dateTime(latestVersion.publishedAt)}
              {latestVersion.publishedBy ? ` · ${latestVersion.publishedBy}` : ""}
            </span>
          )}
          <span className="chip chip-onbrand"><Icon name="automations" size={13.5} /> {usedLabel}</span>
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
            <p className="t-body">
              יש שינויים בתבנית שטרם נשמרו. סגירת החלון תשליך אותם.
            </p>
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
            <button type="button" className="btn btn-primary" disabled={pending || !canEdit || Boolean(invalid)}
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
      <div className="gc-b3">
        {/* ---------- RIGHT: blocks / variables ---------- */}
        <aside className="gc-col gc-col-start">
          <div className="gc-colhd">
            <div className="gc-seg">
              <button type="button" className="gc-segb" aria-pressed={tab === "blocks"} onClick={() => setTab("blocks")}>
                <Icon name="blocks" size={17} /> בלוקים
              </button>
              <button type="button" className="gc-segb" aria-pressed={tab === "variables"} onClick={() => setTab("variables")}>
                <Icon name="variables" size={17} /> משתנים
              </button>
            </div>
          </div>
          <input
            className="field-input gc-select"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש בלוק או משתנה"
            aria-label="חיפוש בלוק או משתנה"
          />

          {tab === "blocks" ? (
            <>
              <p className="gc-hint">גררו בלוק לקנבס, או הוסיפו בלחיצה. הסדר נקבע בגרירה או בחיצי הבלוק שעל הקנבס.</p>
              {BLOCK_GROUPS.map((group) => {
                const items = palette.filter((b) => b.group === group);
                if (!items.length) return null;
                return (
                  <div key={group}>
                    <h3 className="gc-cat">{group}</h3>
                    <div className="gc-lib">
                      {items.map((block) => (
                        <button
                          key={block.type}
                          type="button"
                          className="gc-libc"
                          disabled={!canEdit}
                          draggable={canEdit}
                          onDragStart={(e) => {
                            drag.current = { kind: "new", type: block.type };
                            e.dataTransfer.effectAllowed = "copy";
                            e.dataTransfer.setData("text/plain", block.label);
                          }}
                          onDragEnd={endDrag}
                          onClick={() => addBlock(block.type)}
                          title={`גרירה או הוספה: ${block.label}`}
                        >
                          <Icon name="plus-circle" size={17} className="gc-libc-add" />
                          <Icon name={block.icon} size={20} />
                          <span>{block.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <p className="gc-hint">גררו משתנה לשדה טקסט, או לחצו כדי להוסיף במיקום הסמן.</p>
              {varHint && (
                <p className="gc-varhint" role="status">
                  <Icon name="touch" size={17} />
                  בחרו שדה טקסט או בלוק שאליו תרצו להוסיף את המשתנה
                </p>
              )}
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
                        onClick={() => insertVariable(`{{${variable.key}}}`)}
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
          )}
        </aside>

        {/* ---------- CENTRE: canvas ---------- */}
        <section className="gc-col gc-col-canvas">
          <div className="gc-tools">
            <div className="gc-seg">
              <button type="button" className="gc-segb" aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
                <Icon name="edit" size={17} /> עריכה
              </button>
              <button type="button" className="gc-segb" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
                <Icon name="eye" size={17} /> תצוגה מקדימה
              </button>
            </div>
            <div className="gc-tools">
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
              <div className="gc-seg">
                <button type="button" className="gc-segb gc-seg-icon" aria-pressed={device === "desktop"}
                  onClick={() => setDevice("desktop")} title="מחשב">
                  <Icon name="computer" size={17} label="מחשב" />
                </button>
                <button type="button" className="gc-segb gc-seg-icon" aria-pressed={device === "phone"}
                  onClick={() => setDevice("phone")} title="נייד">
                  <Icon name="smartphone" size={17} label="נייד" />
                </button>
              </div>
            </div>
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

          {/* the mail sheet — also the block drop zone (palette→canvas + reorder) */}
          <div
            ref={canvasRef}
            className={`gc-mail${device === "phone" ? " is-phone" : ""}`}
            onDragOver={canvasDragOver}
            onDrop={canvasDrop}
          >
            <div className="gc-envelope">
              <p><b>מאת</b> <span>{sender || "שם העסק"} <span className="ltr-num">&lt;{senderAddress ?? "ערוץ טרם חובר"}&gt;</span></span></p>
              <p><b>אל</b> <span className="ltr-num">{String(context.values["guest.email"] ?? "guest@example.com")}</span></p>
              <p><b>נושא</b> <span className="gc-envelope-s">{renderedSubject.value || "—"}</span></p>
              {preheader && <p className="gc-envelope-p">{renderTemplateString(preheader, context).value}</p>}
            </div>

            {mode === "preview" ? (
              <iframe
                className="block w-full border-0"
                style={{ height: 720 }}
                sandbox=""
                srcDoc={emailDoc?.html ?? ""}
                title="תצוגה מקדימה של האימייל"
              />
            ) : blocks.length === 0 ? (
              <p className="gc-canvas-empty">
                <Icon name="blocks" size={24} />
                גררו בלוק לכאן או הוסיפו אותו מרשימת הבלוקים כדי להתחיל
              </p>
            ) : (
              blocks.map((block, index) => {
                const source = content.blocks[index];
                const meta = blockMeta(block.type);
                const fullBleed = block.type === "logo_header" || block.type === "contact";
                const isSelected = selected === block.id;
                const editable = TEXT_BLOCKS.includes(block.type);
                const isEditing = editingId === block.id && editable;
                return (
                  <div key={block.id} data-blk={block.id}>
                    {dropIndex === index && <div className="gc-dropline" aria-hidden="true" />}
                    <div
                      className={`gc-blk is-editable${isSelected ? " is-sel" : ""}${block.visible ? "" : " is-off"}`}
                      onClick={() => { setSelected(block.id); setVarHint(false); setEditingId(editable ? block.id : null); }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(block.id); } }}
                      aria-pressed={isSelected}
                      aria-label={meta?.label ?? block.type}
                    >
                      {isSelected && (
                        <>
                          <span className="gc-blk-tag">{meta?.label}</span>
                          <span className="gc-blk-tb" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="gc-blk-grip" title="גרירה לסידור מחדש" aria-label="גרירה לסידור מחדש"
                              draggable={canEdit}
                              onDragStart={(e) => { drag.current = { kind: "move", id: block.id }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", meta?.label ?? ""); }}
                              onDragEnd={endDrag}>
                              <Icon name="drag" size={13.5} label="גרירה" />
                            </button>
                            <button type="button" title="הזזה למעלה" disabled={!canEdit || index === 0}
                              onClick={() => moveBlock(block.id, -1)}><Icon name="arrow-up" size={13.5} label="הזזה למעלה" /></button>
                            <button type="button" title="הזזה למטה" disabled={!canEdit || index === blocks.length - 1}
                              onClick={() => moveBlock(block.id, 1)}><Icon name="arrow-down" size={13.5} label="הזזה למטה" /></button>
                            <button type="button" title="שכפול" disabled={!canEdit}
                              onClick={() => duplicateBlock(block.id)}><Icon name="copy" size={13.5} label="שכפול" /></button>
                            <button type="button" title={source?.enabled ? "הסתרה" : "הצגה"} disabled={!canEdit}
                              onClick={() => patchSelected({ enabled: !source?.enabled })}>
                              <Icon name={source?.enabled ? "eye-off" : "eye"} size={13.5} label={source?.enabled ? "הסתרה" : "הצגה"} />
                            </button>
                            <button type="button" title="מחיקה" disabled={!canEdit}
                              onClick={() => removeBlock(block.id)}><Icon name="trash" size={13.5} label="מחיקה" /></button>
                          </span>
                        </>
                      )}
                      {/* Direct editing: a text/heading/signature block becomes an inline
                          field on click (§7). It is an INPUT, not a second renderer —
                          the canvas still paints the renderer's bytes everywhere else. */}
                      {isEditing ? (
                        <textarea
                          className="gc-inline"
                          autoFocus
                          disabled={!canEdit}
                          value={source?.data.text ?? ""}
                          placeholder={BLOCK_TEXT_PLACEHOLDER[block.type]}
                          onClick={(e) => e.stopPropagation()}
                          onFocus={(e) => { activeField.current = { kind: "block", el: e.currentTarget }; }}
                          onChange={(e) => patchData({ text: e.target.value })}
                          onDragOver={allowVarDrop}
                          onDrop={(e) => onFieldDrop(e, "block")}
                          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setEditingId(null); e.currentTarget.blur(); } }}
                          onBlur={() => setEditingId(null)}
                        />
                      ) : block.html ? (
                        <div className={fullBleed ? undefined : "gc-blk-pad"} dangerouslySetInnerHTML={{ __html: block.html }} />
                      ) : (
                        <p className="gc-blk-pad gc-blk-ghost">
                          <Icon name="eye-off" size={17} />
                          {meta?.label} — לא ייכלל בהודעה בנתוני התצוגה הנוכחיים
                        </p>
                      )}
                    </div>
                    {dropIndex === index + 1 && index === blocks.length - 1 && <div className="gc-dropline" aria-hidden="true" />}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* ---------- LEFT: settings / block properties ---------- */}
        <aside className="gc-col gc-col-end">
          {selectedBlock ? (
            <>
              <div className="gc-colhd">
                <Icon name="filter" size={20} /> מאפיינים — {blockMeta(selectedBlock.type)?.label}
                <button type="button" className="icon-btn" style={{ marginInlineStart: "auto" }}
                  onClick={() => setSelected(null)} title="חזרה להגדרות התבנית">
                  <Icon name="close" size={17} label="סגירה" />
                </button>
              </div>

              <span className="gc-toggle">
                <button type="button" className="gc-sw" role="switch" aria-checked={selectedBlock.enabled}
                  disabled={!canEdit} onClick={() => patchSelected({ enabled: !selectedBlock.enabled })}
                  aria-label="הצג את הבלוק" />
                <Icon name="eye" size={17} /> הצג את הבלוק
              </span>

              {TEXT_BLOCKS.includes(selectedBlock.type) && (
                <label className="field">
                  <span className="field-label">תוכן</span>
                  <textarea
                    className="field-input"
                    rows={6}
                    disabled={!canEdit}
                    value={selectedBlock.data.text ?? ""}
                    placeholder={BLOCK_TEXT_PLACEHOLDER[selectedBlock.type]}
                    onFocus={(e) => { activeField.current = { kind: "block", el: e.currentTarget }; }}
                    onDragOver={allowVarDrop}
                    onDrop={(e) => onFieldDrop(e, "block")}
                    onChange={(e) => patchData({ text: e.target.value })}
                  />
                  <span className="field-hint">אפשר להקליד ישירות בקנבס, או לשלב משתנים מלשונית ״משתנים״</span>
                </label>
              )}

              {selectedBlock.type === "cancellation_policy" && (
                <p className="gc-note">
                  <Icon name="info" size={17} />
                  הבלוק מציג את מדיניות הביטול של ההזמנה עצמה — הטקסט נמשך מההזמנה ואינו נכתב כאן.
                </p>
              )}

              {TEXT_BLOCKS.includes(selectedBlock.type) && (
                <>
                  <div className="field">
                    <span className="field-label">יישור</span>
                    <div className="gc-seg">
                      {([["start", "align-start", "ימין"], ["center", "align-center", "מרכז"], ["end", "align-end", "שמאל"]] as const).map(([value, icon, t]) => (
                        <button key={value} type="button" className="gc-segb gc-seg-icon" disabled={!canEdit}
                          aria-pressed={(selectedBlock.data.align ?? "start") === value}
                          onClick={() => patchData({ align: value })} title={t}>
                          <Icon name={icon} size={17} label={t} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="gc-two">
                    {styleSelect("fontSize", "גודל טקסט", STYLE_OPTIONS.fontSize, selectedBlock.type === "heading" ? "xl" : "base")}
                    {styleSelect("fontWeight", "עובי", STYLE_OPTIONS.fontWeight, selectedBlock.type === "heading" ? "black" : "medium")}
                  </div>
                  <div className="gc-two">
                    {styleSelect("lineHeight", "גובה שורה", STYLE_OPTIONS.lineHeight, "normal")}
                    {styleSelect("textColor", "צבע טקסט", STYLE_OPTIONS.textColor, selectedBlock.type === "signature" ? "muted" : "ink")}
                  </div>
                  <div className="gc-two">
                    {styleSelect("background", "רקע", STYLE_OPTIONS.background, "none")}
                    {styleSelect("padding", "ריווח פנימי", STYLE_OPTIONS.padding, "none")}
                  </div>
                </>
              )}

              {selectedBlock.type === "action_button" && (
                <>
                  <label className="field">
                    <span className="field-label">טקסט הכפתור</span>
                    <input className="field-input" disabled={!canEdit} value={selectedBlock.data.label ?? ""}
                      onFocus={(e) => { activeField.current = { kind: "label", el: e.currentTarget }; }}
                      onDragOver={allowVarDrop} onDrop={(e) => onFieldDrop(e, "label")}
                      onChange={(e) => patchData({ label: e.target.value })} placeholder="לצפייה בהזמנה" />
                  </label>
                  <label className="field">
                    <span className="field-label">קישור יעד</span>
                    <input className="field-input ltr-num" disabled={!canEdit}
                      value={selectedBlock.data.url ?? (selectedBlock.data.urlVariable ? `{{${selectedBlock.data.urlVariable}}}` : "")}
                      onFocus={(e) => { activeField.current = { kind: "url", el: e.currentTarget }; }}
                      onDragOver={allowVarDrop} onDrop={(e) => onFieldDrop(e, "url")}
                      onChange={(e) => patchData({ url: e.target.value, urlVariable: undefined })}
                      placeholder="https://…  או  {{reservation.manage_url}}" />
                    <span className="gc-quickvars">
                      {ACTION_URL_OPTIONS.map((option) => (
                        <button key={option.value} type="button" className="gc-chipbtn" disabled={!canEdit}
                          onClick={() => patchData({ url: `{{${option.value}}}`, urlVariable: undefined })}>
                          <Icon name="link" size={13.5} /> {option.label}
                        </button>
                      ))}
                    </span>
                    <span className="field-hint">קישור קבוע או משתנה. אם היעד ריק בהזמנה, הכפתור לא ייכלל בהודעה.</span>
                  </label>
                  {canPublish && !selectedBlock.data.url?.trim() && !selectedBlock.data.urlVariable && (
                    <p className="field-msg" role="alert">
                      <Icon name="warning" size={13.5} /> לכפתור אין יעד — לא ניתן לפרסם אותו כך.
                    </p>
                  )}
                  <div className="field">
                    <span className="field-label">יישור</span>
                    <div className="gc-seg">
                      {([["start", "align-start", "ימין"], ["center", "align-center", "מרכז"], ["end", "align-end", "שמאל"]] as const).map(([value, icon, t]) => (
                        <button key={value} type="button" className="gc-segb gc-seg-icon" disabled={!canEdit}
                          aria-pressed={(selectedBlock.data.align ?? "center") === value}
                          onClick={() => patchData({ align: value })} title={t}>
                          <Icon name={icon} size={17} label={t} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="gc-two">
                    {styleSelect("buttonWidth", "רוחב", STYLE_OPTIONS.buttonWidth, "auto")}
                    {styleSelect("buttonRadius", "פינות", STYLE_OPTIONS.buttonRadius, "md")}
                  </div>
                  <div className="gc-two">
                    {styleSelect("buttonBg", "צבע רקע", STYLE_OPTIONS.buttonBg, "brand")}
                    {styleSelect("buttonText", "צבע טקסט", STYLE_OPTIONS.buttonText, "white")}
                  </div>
                </>
              )}

              {selectedBlock.type === "reservation_details" && (
                <div className="field">
                  <span className="field-label">שדות מוצגים</span>
                  {fieldToggle("showSource", "מקור הזמנה", false)}
                  {fieldToggle("showCreatedAt", "תאריך יצירה", false)}
                  {fieldToggle("showTimes", "שעות צ׳ק-אין וצ׳ק-אאוט", true)}
                  {fieldToggle("showNights", "מספר לילות", true)}
                  {fieldToggle("showGuests", "מספר אורחים", false)}
                  <span className="field-hint">שם האורח, מספר ההזמנה ותאריכי ההגעה/עזיבה מוצגים תמיד. השעות נמשכות מהגדרות הנכס.</span>
                </div>
              )}

              {selectedBlock.type === "payment_summary" && (
                <div className="field">
                  <span className="field-label">שדות מוצגים</span>
                  {fieldToggle("showTotal", "סכום כולל", true)}
                  {fieldToggle("showPaid", "שולם", true)}
                  {fieldToggle("showBalance", "יתרה לתשלום", true)}
                  <span className="field-hint">הסכומים והמטבע נמשכים מההזמנה ומוצגים כפי שהאורח יראה.</span>
                </div>
              )}

              <label className="field">
                <span className="field-label">תנאי הצגה</span>
                <select className="field-input" disabled={!canEdit} value={selectedBlock.condition}
                  onChange={(e) => patchSelected({ condition: e.target.value as BlockCondition })}>
                  {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                {selectedBlock.condition !== "always" && (
                  <span className="field-hint">
                    {blocks.find((b) => b.id === selectedBlock.id)?.visible
                      ? "בנתוני התצוגה הנוכחיים הבלוק מוצג"
                      : "בנתוני התצוגה הנוכחיים הבלוק אינו מוצג"}
                  </span>
                )}
              </label>

              <div className="flex gap-2">
                <button type="button" className="btn btn-secondary btn-sm" disabled={!canEdit}
                  onClick={() => duplicateBlock(selectedBlock.id)}><Icon name="copy" size={17} /> שכפול</button>
                <button type="button" className="btn btn-danger btn-sm" disabled={!canEdit}
                  onClick={() => removeBlock(selectedBlock.id)}><Icon name="trash" size={17} /> מחיקה</button>
              </div>
            </>
          ) : (
            <>
              <div className="gc-colhd"><Icon name="filter" size={20} /> הגדרות התבנית</div>
              <p className="gc-note">
                <Icon name="touch" size={17} />
                בחרו בלוק בקנבס כדי לערוך את המאפיינים שלו. בינתיים — הגדרות התבנית:
              </p>

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

              <label className="field">
                <span className="field-label">כתובת שולח (From)</span>
                <input className="field-input ltr-num" readOnly disabled value={senderAddress ?? "ערוץ האימייל טרם חובר"} />
                <span className="field-hint">מוגדרת ב״ערוצי שליחה״ ומשותפת לכל התבניות — לקריאה בלבד</span>
              </label>

              <div className="gc-colhd"><Icon name="history" size={20} /> היסטוריית גרסאות</div>
              {versions.length === 0 ? (
                <p className="gc-hint">עדיין לא פורסמה גרסה. פרסום ייצור את v1.</p>
              ) : (
                versions.map((version) => (
                  <div className="gc-ver" key={version.id}>
                    <span className="chip chip-paid">v{version.version}</span>
                    <span className="gc-ver-m">
                      {/* the seeded v1 has no publisher — say so, do not print "—" */}
                      <b>{version.publishedBy ? `פרסום · ${version.publishedBy}` : "גרסה ראשונית"}</b>
                      <span>{dateTime(version.publishedAt)}</span>
                    </span>
                    {canEdit && (
                      <button type="button" className="icon-btn" title="שחזור התוכן לטיוטה" disabled={pending}
                        onClick={() => run(() => restoreTemplateVersionAction(version.id))}>
                        <Icon name="restore" size={17} label="שחזור" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </>
          )}

          {invalid && <p className="field-msg" role="alert">{invalid}</p>}

          {notice && (
            <p className={notice.success ? "gc-note" : "field-msg"} role="status">
              {notice.success ? notice.message : notice.error}
            </p>
          )}
        </aside>
      </div>
    </SidePanel>
  );
}

/** The ONE in-panel dialog (§8 .modal), rendered into SidePanel's overlay slot. */
function Dialog({
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

function TestSendDialog({
  to, setTo, datasets, datasetId, setDatasetId, pending, onCancel, onSend,
}: {
  to: string; setTo: (v: string) => void;
  datasets: PreviewDataset[]; datasetId: string; setDatasetId: (v: string) => void;
  pending: boolean; onCancel: () => void; onSend: () => void;
}) {
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());
  return (
    <Dialog
      icon="send"
      title="שליחת אימייל לבדיקה"
      confirmLabel="שליחת בדיקה"
      confirmIcon="send"
      disabled={!valid}
      pending={pending}
      onCancel={onCancel}
      onConfirm={onSend}
    >
      <label className="field">
        <span className="field-label">כתובת אימייל</span>
        <input className="field-input ltr-num" type="email" value={to} placeholder="name@example.com"
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
