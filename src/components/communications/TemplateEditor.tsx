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
  CONDITION_LABELS, STAGE_KEYS, STAGE_LABELS, TEXT_BLOCKS,
  blockMeta, defaultTemplateContent, makeBlock, usageLabel,
} from "@/lib/communications/blocks";
import { renderCommunicationBlocks, renderStructuredCommunication, renderTemplateString } from "@/lib/communications/renderer";
import { COMMUNICATION_VARIABLES } from "@/lib/communications/variables";
import type {
  BlockCondition, CommunicationRenderContext, StructuredTemplateContent,
  TemplateBlock, TemplateBlockType,
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

type Props = {
  template: CommunicationTemplateRow | null;
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
  template, datasets, fallbackContext, senderAddress, canEdit, canPublish, canTest, onClose,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState(template?.name ?? "תבנית חדשה");
  const [subject, setSubject] = useState(template?.subject ?? "ההזמנה שלכם אושרה – {{reservation.number}}");
  const [preheader, setPreheader] = useState(template?.preheader ?? "");
  const [sender, setSender] = useState(template?.senderDisplayName ?? "");
  const [replyTo, setReplyTo] = useState(template?.replyTo ?? "");
  const [stage, setStage] = useState(template?.category ?? "reservation");
  const [language, setLanguage] = useState(template?.language ?? "he");
  const [content, setContent] = useState<StructuredTemplateContent>(
    isContent(template?.draftContent) ? template.draftContent : defaultTemplateContent(),
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

  // The field a variable click inserts into. Captured on focus; the palette
  // buttons preventDefault on mousedown so focus (and the caret) survive the click.
  const activeField = useRef<{ kind: "subject" | "preheader" | "block"; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);

  const context = useMemo(
    () => datasets.find((d) => d.id === datasetId)?.context ?? fallbackContext,
    [datasetId, datasets, fallbackContext],
  );

  const selectedBlock = content.blocks.find((b) => b.id === selected) ?? null;
  const blocks = useMemo(
    () => renderCommunicationBlocks(content, context, { highlight: true }),
    [content, context],
  );
  const emailDoc = useMemo(
    () => renderStructuredCommunication(content, context, { preheader }),
    [content, context, preheader],
  );
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

  const addBlock = (type: TemplateBlockType) => {
    const block = makeBlock(type, `${type}-${crypto.randomUUID().slice(0, 8)}`);
    patch((blocks) => [...blocks, block]);
    setSelected(block.id);
  };
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
  };

  const insertVariable = (token: string) => {
    const field = activeField.current;
    if (!field) return;
    const { el, kind } = field;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`;
    if (kind === "subject") setSubject(next);
    else if (kind === "preheader") setPreheader(next);
    else patchData({ text: next });
    touch();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
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
            <button type="button" className="btn btn-primary" disabled={pending || !canEdit}
              onClick={() => run(() => publishTemplateAction(payload))}>
              <Icon name="publish" size={17} /> פרסום
            </button>
          )}
          {canEdit && (
            <button type="button" className="btn btn-secondary" disabled={pending}
              onClick={() => run(() => saveTemplateDraftAction(payload), () => { if (!template) onClose(); })}>
              <Icon name="draft" size={17} /> שמירת טיוטה
            </button>
          )}
          {canTest && (
            <button type="button" className="btn btn-secondary" disabled={pending}
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
              <p className="gc-hint">הוסיפו בלוק בלחיצה. הסדר נקבע בסרגל הבלוק שעל הקנבס.</p>
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
                          onClick={() => addBlock(block.type)}
                          title={`הוספת ${block.label}`}
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
              <p className="gc-hint">לחיצה מוסיפה למיקום הסמן בשדה הטקסט הפעיל.</p>
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
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertVariable(`{{${variable.key}}}`)}
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
                  onChange={(e) => { setSubject(e.target.value); touch(); }} />
              </label>
              <label className="field">
                <span className="gc-label-row">
                  <span className="field-label">טקסט מקדים (Preheader)</span>
                  <span className="gc-cnt">{preheader.length} תווים</span>
                </span>
                <input className="field-input" value={preheader} disabled={!canEdit}
                  onFocus={(e) => { activeField.current = { kind: "preheader", el: e.currentTarget }; }}
                  onChange={(e) => { setPreheader(e.target.value); touch(); }}
                  placeholder="התקציר שמופיע ליד הנושא בתיבת הדואר" />
              </label>
            </div>
          </div>

          {/* the mail sheet */}
          <div className={`gc-mail${device === "phone" ? " is-phone" : ""}`}>
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
                srcDoc={emailDoc.html}
                title="תצוגה מקדימה של האימייל"
              />
            ) : (
              blocks.map((block, index) => {
                const source = content.blocks[index];
                const meta = blockMeta(block.type);
                const fullBleed = block.type === "logo_header" || block.type === "contact";
                const isSelected = selected === block.id;
                return (
                  <div
                    key={block.id}
                    className={`gc-blk is-editable${isSelected ? " is-sel" : ""}${block.visible ? "" : " is-off"}`}
                    onClick={() => setSelected(block.id)}
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
                    {/* the block's OWN bytes — the same string the email carries. A block
                        that renders to nothing (condition unmet, or a variable the data has
                        no value for) would otherwise be a blank strip the operator cannot
                        explain, so it says out loud why it will not be sent. */}
                    {block.html ? (
                      <div className={fullBleed ? undefined : "gc-blk-pad"} dangerouslySetInnerHTML={{ __html: block.html }} />
                    ) : (
                      <p className="gc-blk-pad gc-blk-ghost">
                        <Icon name="eye-off" size={17} />
                        {meta?.label} — לא ייכלל בהודעה בנתוני התצוגה הנוכחיים
                      </p>
                    )}
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
                    onChange={(e) => patchData({ text: e.target.value })}
                  />
                  <span className="field-hint">אפשר לשלב משתנים מלשונית ״משתנים״</span>
                </label>
              )}

              {(selectedBlock.type === "heading" || selectedBlock.type === "text") && (
                <div className="field">
                  <span className="field-label">יישור טקסט</span>
                  <div className="gc-seg">
                    <button type="button" className="gc-segb gc-seg-icon" disabled={!canEdit}
                      aria-pressed={(selectedBlock.data.align ?? "start") === "start"}
                      onClick={() => patchData({ align: "start" })} title="יישור לימין">
                      <Icon name="align-start" size={17} label="יישור לימין" />
                    </button>
                    <button type="button" className="gc-segb gc-seg-icon" disabled={!canEdit}
                      aria-pressed={selectedBlock.data.align === "center"}
                      onClick={() => patchData({ align: "center" })} title="מרכוז">
                      <Icon name="align-center" size={17} label="מרכוז" />
                    </button>
                  </div>
                </div>
              )}

              {selectedBlock.type === "action_button" && (
                <>
                  <label className="field">
                    <span className="field-label">טקסט הכפתור</span>
                    <input className="field-input" disabled={!canEdit} value={selectedBlock.data.label ?? ""}
                      onChange={(e) => patchData({ label: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="field-label">קישור יעד</span>
                    <select className="field-input" disabled={!canEdit} value={selectedBlock.data.urlVariable ?? ""}
                      onChange={(e) => patchData({ urlVariable: e.target.value })}>
                      {ACTION_URL_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <span className="field-hint">אם הקישור אינו קיים בהזמנה, הכפתור לא ייכלל בהודעה</span>
                  </label>
                </>
              )}

              {selectedBlock.type === "reservation_details" && (
                <div className="field">
                  <span className="field-label">שדות מוצגים</span>
                  <span className="gc-toggle">
                    <button type="button" className="gc-sw" role="switch" disabled={!canEdit}
                      aria-checked={selectedBlock.data.showTimes !== false}
                      onClick={() => patchData({ showTimes: selectedBlock.data.showTimes === false })}
                      aria-label="שעות צ׳ק-אין וצ׳ק-אאוט" />
                    שעות צ׳ק-אין וצ׳ק-אאוט
                  </span>
                  <span className="gc-toggle">
                    <button type="button" className="gc-sw" role="switch" disabled={!canEdit}
                      aria-checked={selectedBlock.data.showNights !== false}
                      onClick={() => patchData({ showNights: selectedBlock.data.showNights === false })}
                      aria-label="מספר לילות" />
                    מספר לילות
                  </span>
                  <span className="field-hint">שעות הצ׳ק-אין והצ׳ק-אאוט נמשכות אוטומטית מהגדרות הנכס</span>
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
