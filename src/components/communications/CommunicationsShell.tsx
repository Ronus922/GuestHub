"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { TemplateEditor } from "./TemplateEditor";
import { HtmlTemplateEditor } from "./HtmlTemplateEditor";
import { WhatsAppTemplateEditor } from "./WhatsAppTemplateEditor";
import type { EditorSeed } from "./editorShared";
import { STAGE_KEYS, STAGE_LABELS, usageLabel } from "@/lib/communications/blocks";
import { TEMPLATE_GALLERY, emptyContentFor } from "@/lib/communications/gallery";
import {
  TRIGGERS, TRIGGER_IDS, TRIGGER_LIST, SOURCE_GROUPS, describeTiming,
  otaSourceBlockReason, type TriggerId,
} from "@/lib/communications/triggers";
import { renderTemplateContent } from "@/lib/communications/renderer";
import type {
  CommunicationChannel, CommunicationRenderContext, TemplateContent, TemplateLanguage,
} from "@/lib/communications/types";
import type {
  AutomationRow, CommunicationsData, CommunicationTemplateRow, DeliveryRow,
} from "@/app/(dashboard)/communications/data";
import {
  archiveTemplateAction, duplicateTemplateAction, saveAutomationAction,
  saveCommunicationSettingsAction, setAutomationStatusAction,
  type CommunicationActionResult,
} from "@/app/(dashboard)/communications/actions";
import { EMAIL_RE } from "@/lib/communications/schemas";
import { normalizePhone } from "@/lib/phone";

export type CommunicationSection = "automations" | "templates" | "history" | "channels" | "archive";

const TABS: { key: CommunicationSection; label: string; icon: IconName }[] = [
  { key: "automations", label: "אוטומציות", icon: "automations" },
  { key: "templates", label: "תבניות", icon: "documents" },
  { key: "history", label: "היסטוריית שליחה", icon: "history" },
  { key: "channels", label: "ערוצי שליחה", icon: "lan" },
  { key: "archive", label: "ארכיון", icon: "archive" },
];

type Permissions = {
  editTemplates: boolean; publishTemplates: boolean; testSend: boolean;
  manageAutomations: boolean; activateAutomations: boolean; manageChannels: boolean;
};

type Props = {
  section: CommunicationSection;
  data: CommunicationsData;
  permissions: Permissions;
  datasets: { id: string; label: string; context: CommunicationRenderContext }[];
  fallbackContext: CommunicationRenderContext;
};

const STATE_LABEL: Record<string, string> = {
  draft: "טיוטה", published: "פורסמה", archived: "בארכיון",
  active: "פעילה", disabled: "כבויה", needs_attention: "דורשת טיפול",
  delivered: "נמסרה", read: "נקראה", sent: "נשלחה", submitted: "נשלחה לספק",
  queued: "בתור", submitting: "בשליחה", failed: "נכשלה", undelivered: "לא נמסרה",
  skipped: "דולגה", cancelled: "בוטלה",
  provider_not_configured: "ערוץ לא מוגדר", validation_failed: "נכשלה בבדיקה",
};

/** §3.1: a state never invents a colour, it wears one of the eight approved triplets. */
function chipClass(state: string): string {
  if (["published", "active", "delivered", "read", "sent"].includes(state)) return "chip chip-paid";
  if (["failed", "undelivered", "needs_attention", "provider_not_configured", "validation_failed"].includes(state)) return "chip chip-failed";
  if (["draft", "queued", "submitting", "submitted"].includes(state)) return "chip chip-approval";
  return "chip chip-cancelled";
}

/** Which editor a template (or a creation seed) opens in. */
function editorKindOf(target: CommunicationTemplateRow | { seed: EditorSeed }): "blocks" | "html" | "whatsapp" {
  const content = "seed" in target ? target.seed.content : target.draftContent;
  const kind = (content as { kind?: string } | null)?.kind;
  if ("seed" in target ? kind === "whatsapp_text" : target.channel === "whatsapp") return "whatsapp";
  if (kind === "html") return "html";
  return "blocks";
}

function channelChip(channel: string) {
  return channel === "whatsapp"
    ? <span className="chip chip-brand"><Icon name="whatsapp" size={13.5} /> WhatsApp</span>
    : <span className="chip chip-brand"><Icon name="mail" size={13.5} /> אימייל</span>;
}

function dateLine(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Jerusalem",
  }).format(new Date(value));
}

function dateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem",
  }).format(new Date(value));
}

type Kpi = { key: string; label: string; caption: string; icon: IconName; value: number | string; tone: string };

function KpiRow({ cards, active, onPick }: { cards: Kpi[]; active: string | null; onPick: (key: string) => void }) {
  return (
    <div className="gc-sums">
      {cards.map((card) => (
        <button
          key={card.key}
          type="button"
          className="gc-sum"
          aria-pressed={active === card.key}
          onClick={() => onPick(card.key)}
        >
          <span className="gc-sum-top">
            <span className="gc-sum-l">{card.label}</span>
            <Icon name={card.icon} size={17} />
          </span>
          <strong className={`gc-sum-v ${card.tone}`}>{card.value}</strong>
          <span className="gc-sum-c">{card.caption}</span>
        </button>
      ))}
    </div>
  );
}

function Empty({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <span><Icon name={icon} size={24} /></span>
      <h3 className="empty-t">{title}</h3>
      <p className="empty-s">{text}</p>
      {action}
    </div>
  );
}

export function CommunicationsShell({ section, data, permissions, datasets, fallbackContext }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<CommunicationTemplateRow | { seed: EditorSeed } | null>(null);
  const [creating, setCreating] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryRow | null>(null);
  const [automation, setAutomation] = useState<AutomationRow | "new" | null>(null);
  const [notice, setNotice] = useState<CommunicationActionResult | null>(null);
  const [kpi, setKpi] = useState<string | null>(null);
  const [channel, setChannel] = useState("all");
  const [stage, setStage] = useState("all");
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<CommunicationActionResult>) =>
    startTransition(async () => {
      const result = await action();
      setNotice(result);
      if (result.success) { setAutomation(null); router.refresh(); }
    });

  const live = data.templates.filter((t) => t.state !== "archived");
  const archived = data.templates.filter((t) => t.state === "archived");

  const templateKpis: Kpi[] = [
    { key: "published", label: "פורסמו", caption: "זמינות לאוטומציות", icon: "check-circle", tone: "is-ok", value: live.filter((t) => t.state === "published").length },
    { key: "draft", label: "טיוטות", caption: "בעריכה — לא נשלחות", icon: "draft", tone: "is-warn", value: live.filter((t) => t.state === "draft").length },
    { key: "used", label: "בשימוש", caption: "משויכות לאוטומציה פעילה", icon: "automations", tone: "is-brand", value: live.filter((t) => t.usedBy > 0).length },
    { key: "archived", label: "בארכיון", caption: "מעבר לארכיון", icon: "archive", tone: "is-muted", value: archived.length },
  ];

  const templates = useMemo(() => live.filter((t) => {
    if (channel !== "all" && t.channel !== channel) return false;
    if (stage !== "all" && t.category !== stage) return false;
    if (kpi === "published" && t.state !== "published") return false;
    if (kpi === "draft" && t.state !== "draft") return false;
    if (kpi === "used" && t.usedBy === 0) return false;
    return true;
  }), [live, channel, stage, kpi]);

  const openTemplate = (template: CommunicationTemplateRow) => setEditing(template);
  const startCreate = () => { if (permissions.editTemplates) setCreating(true); };

  return (
    <main className="gc-page" dir="rtl">
      <header className="gc-head">
        <div>
          <h1 className="h1">תקשורת אורחים</h1>
          <p className="gc-sub">
            תבניות, אוטומציות, היסטוריית שליחה וערוצי שליחה — הפרדה מלאה בין התוכן (תבנית),
            הכלל ששולח אותו (אוטומציה), החיבור לספק (ערוץ) וההוכחה מה נשלח בפועל (היסטוריה)
          </p>
        </div>
      </header>

      <div className="gc-bar">
        <nav className="gc-tabs" aria-label="תקשורת אורחים">
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              className="gc-tab"
              href={`/communications/${tab.key}`}
              aria-current={section === tab.key ? "page" : undefined}
            >
              <Icon name={tab.icon} size={17} /> {tab.label}
            </Link>
          ))}
        </nav>
        {section === "templates" && permissions.editTemplates && (
          <button type="button" className="btn btn-primary" onClick={startCreate}>
            <Icon name="plus" size={17} /> תבנית חדשה
          </button>
        )}
        {section === "automations" && permissions.manageAutomations && (
          <button type="button" className="btn btn-primary" onClick={() => setAutomation("new")}>
            <Icon name="plus" size={17} /> אוטומציה חדשה
          </button>
        )}
      </div>

      {notice && (
        <p className={notice.success ? "gc-note" : "field-msg"} role="status">
          {notice.success ? notice.message : notice.error}
        </p>
      )}

      {section === "templates" && (
        <>
          <KpiRow cards={templateKpis} active={kpi} onPick={(key) => {
            if (key === "archived") { router.push("/communications/archive"); return; }
            setKpi((current) => (current === key ? null : key));
          }} />

          <section className="card">
            <div className="gc-ph">
              <Icon name="documents" size={20} />
              <h2 className="h4">תבניות הודעה</h2>
              <span className="gc-ph-d">
                יצירה וניהול של ההודעות הנשלחות לאורחים · מתי לשלוח נקבע רק באוטומציות
              </span>
              <div className="gc-ph-f">
                <div className="gc-seg">
                  {[["all", "כל הערוצים"], ["email", "אימייל"], ["whatsapp", "WhatsApp"]].map(([value, label]) => (
                    <button key={value} type="button" className="gc-segb"
                      aria-pressed={channel === value} onClick={() => setChannel(value)}>
                      {label}
                    </button>
                  ))}
                </div>
                <select className="field-input gc-select" value={stage} aria-label="שלב בהזמנה"
                  onChange={(e) => setStage(e.target.value)}>
                  <option value="all">כל שלבי ההזמנה</option>
                  {STAGE_KEYS.map((key) => <option key={key} value={key}>{STAGE_LABELS[key]}</option>)}
                </select>
              </div>
            </div>

            {templates.length === 0 ? (
              <Empty
                icon="mail-unread"
                title={live.length ? "אין תוצאות לסינון" : "עדיין לא נוצרו תבניות"}
                text={live.length
                  ? "שנו את הערוץ או את שלב ההזמנה."
                  : "צרו תבנית ראשונה והשתמשו בה באוטומציות לשליחה לאורחים"}
                action={permissions.editTemplates && !live.length ? (
                  <button type="button" className="btn btn-primary" onClick={startCreate}>
                    <Icon name="plus" size={17} /> תבנית חדשה
                  </button>
                ) : undefined}
              />
            ) : (
              <div className="gc-tw">
                <div className="gc-thead">
                  <span />
                  <span>תבנית</span><span>ערוץ</span><span>שלב</span><span>שפה</span>
                  <span>סטטוס</span><span>גרסה</span><span>בשימוש</span>
                  <span>עודכן · ע״י</span><span>פעולות</span>
                </div>
                {templates.map((template) => (
                  <div
                    key={template.id}
                    className="gc-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => openTemplate(template)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTemplate(template); }
                    }}
                    aria-label={`פתיחת ${template.name}`}
                  >
                    <span className="gc-row-ic"><Icon name={template.channel === "whatsapp" ? "whatsapp" : "mail"} size={20} /></span>
                    <span className="gc-row-n">{template.name}</span>
                    <span>{channelChip(template.channel)}</span>
                    <span>{STAGE_LABELS[template.category] ?? template.category}</span>
                    <span>{template.language === "en" ? "English" : "עברית"}</span>
                    <span><span className={chipClass(template.state)}>{STATE_LABEL[template.state]}</span></span>
                    <span className="ltr-num">{template.version ? `v${template.version}` : "—"}</span>
                    <span>
                      {template.usedBy > 0 ? (
                        <Link className="gc-link" href="/communications/automations" onClick={(e) => e.stopPropagation()}>
                          {usageLabel(template.usedBy)}
                        </Link>
                      ) : (
                        <span className="gc-row-m">לא בשימוש</span>
                      )}
                    </span>
                    <span className="gc-row-m">
                      {dateLine(template.updatedAt)}{template.updatedBy ? ` · ${template.updatedBy}` : ""}
                    </span>
                    <span className="gc-acts" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="icon-btn gc-ib" title="תצוגה מקדימה — כפי שהאורח יראה"
                        onClick={() => openTemplate(template)}>
                        <Icon name="eye" size={17} label="תצוגה מקדימה" />
                      </button>
                      <button type="button" className="icon-btn gc-ib" title="שכפול התבנית כטיוטה"
                        disabled={!permissions.editTemplates || pending}
                        onClick={() => run(() => duplicateTemplateAction(template.id))}>
                        <Icon name="copy" size={17} label="שכפול" />
                      </button>
                      <Link className="icon-btn gc-ib" href="/communications/automations"
                        title="יצירת אוטומציה מהתבנית">
                        <Icon name="automations" size={17} label="אוטומציה" />
                      </Link>
                      <button type="button" className="icon-btn gc-ib" title="העברה לארכיון"
                        disabled={!permissions.editTemplates || pending}
                        onClick={() => run(() => archiveTemplateAction(template.id))}>
                        <Icon name="archive" size={17} label="ארכיון" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {section === "archive" && (
        <section className="card">
          <div className="gc-ph">
            <Icon name="archive" size={20} />
            <h2 className="h4">ארכיון</h2>
            <span className="gc-ph-d">תבניות שהוצאו משימוש — אפשר לשחזר אותן בכל רגע</span>
          </div>
          {archived.length === 0 ? (
            <Empty icon="archive" title="הארכיון ריק" text="תבניות שתעבירו לארכיון יופיעו כאן ויישארו ניתנות לשחזור." />
          ) : (
            <div className="gc-tw">
              <div className="gc-thead" style={{ gridTemplateColumns: "44px minmax(190px,1.5fr) 100px 112px 1fr 168px", minWidth: 760 }}>
                <span /><span>תבנית</span><span>ערוץ</span><span>שלב</span><span>עודכן</span><span>פעולות</span>
              </div>
              {archived.map((template) => (
                <div key={template.id} className="gc-row" style={{ gridTemplateColumns: "44px minmax(190px,1.5fr) 100px 112px 1fr 168px", minWidth: 760, cursor: "default" }}>
                  <span className="gc-row-ic"><Icon name={template.channel === "whatsapp" ? "whatsapp" : "mail"} size={20} /></span>
                  <span className="gc-row-n">{template.name}</span>
                  <span>{channelChip(template.channel)}</span>
                  <span>{STAGE_LABELS[template.category] ?? template.category}</span>
                  <span className="gc-row-m">{dateLine(template.updatedAt)}</span>
                  <span className="gc-acts">
                    <button type="button" className="btn btn-secondary btn-sm"
                      disabled={!permissions.editTemplates || pending}
                      onClick={() => run(() => archiveTemplateAction(template.id, true))}>
                      <Icon name="restore" size={17} /> שחזור כטיוטה
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {section === "automations" && (
        <AutomationsPanel
          rows={data.automations}
          templates={live.filter((t) => t.state === "published")}
          permissions={permissions}
          pending={pending}
          onEdit={setAutomation}
          onToggle={(row) => run(() => setAutomationStatusAction(row.id, row.status === "active" ? "disable" : "activate"))}
          onDelete={(row) => run(() => setAutomationStatusAction(row.id, "delete"))}
        />
      )}

      {section === "history" && <HistoryPanel rows={data.deliveries} onOpen={setDelivery} />}

      {section === "channels" && (
        <ChannelsPanel data={data} canManage={permissions.manageChannels} pending={pending}
          onSave={(input) => run(() => saveCommunicationSettingsAction(input))} />
      )}

      {creating && (
        <NewTemplateDialog
          templates={live}
          onCancel={() => setCreating(false)}
          onCreate={(seed) => { setCreating(false); setEditing({ seed }); }}
        />
      )}

      {editing && (() => {
        const editorKind = editorKindOf(editing);
        const shared = {
          key: "seed" in editing ? "new" : editing.id,
          template: "seed" in editing ? null : editing,
          seed: "seed" in editing ? editing.seed : undefined,
          datasets,
          fallbackContext,
          canEdit: permissions.editTemplates,
          canPublish: permissions.publishTemplates,
          canTest: permissions.testSend,
          onClose: () => setEditing(null),
        };
        if (editorKind === "whatsapp") {
          return <WhatsAppTemplateEditor {...shared} whatsappReady={data.channel.whatsappAvailable} />;
        }
        if (editorKind === "html") {
          return <HtmlTemplateEditor {...shared} senderAddress={data.channel.email.sender} />;
        }
        return <TemplateEditor {...shared} senderAddress={data.channel.email.sender} />;
      })()}

      {delivery && <DeliveryPanel row={delivery} onClose={() => setDelivery(null)} />}

      {automation && (
        <AutomationPanel
          value={automation}
          templates={live.filter((t) => t.state === "published")}
          ownerAddresses={{ email: data.settings.ownerEmails, whatsapp: data.settings.ownerPhones }}
          whatsappAvailable={data.channel.whatsappAvailable}
          canActivate={permissions.activateAutomations}
          pending={pending}
          datasets={datasets}
          fallbackContext={fallbackContext}
          onClose={() => setAutomation(null)}
          onSave={(input) => run(() => saveAutomationAction(input))}
        />
      )}
    </main>
  );
}

function AutomationsPanel({
  rows, templates, permissions, pending, onEdit, onToggle, onDelete,
}: {
  rows: AutomationRow[]; templates: CommunicationTemplateRow[]; permissions: Permissions;
  pending: boolean; onEdit: (row: AutomationRow) => void;
  onToggle: (row: AutomationRow) => void; onDelete: (row: AutomationRow) => void;
}) {
  return (
    <section className="card">
      <div className="gc-ph">
        <Icon name="automations" size={20} />
        <h2 className="h4">אוטומציות</h2>
        <span className="gc-ph-d">הכלל שמחבר אירוע לתבנית. הפעלה חלה על אירועים חדשים בלבד — אין שליחה לאחור.</span>
      </div>
      {rows.length === 0 ? (
        <Empty
          icon="automations"
          title="עדיין אין אוטומציות"
          text={templates.length
            ? "צרו אוטומציה כדי לחבר אירוע בהזמנה לתבנית מפורסמת."
            : "כדי ליצור אוטומציה צריך קודם תבנית מפורסמת אחת לפחות."}
        />
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => (
            <article key={row.id} className="flex flex-wrap items-center gap-4 border-b border-line p-4 last:border-b-0">
              <button
                type="button"
                className="gc-sw"
                role="switch"
                aria-checked={row.status === "active"}
                aria-label={row.status === "active" ? "השבתה" : "הפעלה"}
                disabled={!permissions.activateAutomations || pending}
                onClick={() => onToggle(row)}
              />
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="h4">{row.name}</b>
                  <span className={chipClass(row.status)}>{STATE_LABEL[row.status] ?? row.status}</span>
                </div>
                <p className="t-secondary">{row.description || "ללא תיאור"}</p>
                <p className="t-label mt-1">
                  {describeTiming(row.triggerType, row.timing)} · {row.channel === "whatsapp" ? "WhatsApp" : "אימייל"} · {row.templateName}
                </p>
                {row.attentionReason && (
                  <p className="field-msg mt-1"><Icon name="warning" size={13.5} /> {row.attentionReason}</p>
                )}
              </div>
              <div className="flex flex-col items-center px-4">
                <b className="h4">{row.successCount}</b>
                <span className="t-label">נשלחו</span>
              </div>
              <div className="flex flex-col items-center px-4">
                <b className="h4">{row.failureCount}</b>
                <span className="t-label">נכשלו</span>
              </div>
              <div className="gc-acts">
                {permissions.manageAutomations && (
                  <button type="button" className="icon-btn gc-ib" title="עריכה" onClick={() => onEdit(row)}>
                    <Icon name="edit" size={17} label="עריכה" />
                  </button>
                )}
                {permissions.manageAutomations && ["draft", "disabled"].includes(row.status) && (
                  <button type="button" className="icon-btn gc-ib" title="מחיקה" disabled={pending}
                    onClick={() => onDelete(row)}>
                    <Icon name="trash" size={17} label="מחיקה" />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function HistoryPanel({ rows, onOpen }: { rows: DeliveryRow[]; onOpen: (row: DeliveryRow) => void }) {
  const columns = "minmax(160px,1.2fr) 110px minmax(150px,1.2fr) minmax(130px,1fr) 110px 150px 60px";
  return (
    <section className="card">
      <div className="gc-ph">
        <Icon name="history" size={20} />
        <h2 className="h4">היסטוריית שליחה</h2>
        <span className="gc-ph-d">
          כל שליחה נשמרת עם התוכן המרונדר בפועל — שינוי עתידי בתבנית לא משנה את ההיסטוריה
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty icon="send" title="עדיין לא נשלחו הודעות"
          text="משלוחים יופיעו כאן ברגע שאירוע מתאים ייכנס לתור." />
      ) : (
        <div className="gc-tw">
          <div className="gc-thead" style={{ gridTemplateColumns: columns, minWidth: 980 }}>
            <span>אורח</span><span>הזמנה</span><span>נמען</span><span>אוטומציה</span>
            <span>סטטוס</span><span>זמן שליחה</span><span>ניסיונות</span>
          </div>
          {rows.map((row) => (
            <div key={row.id} className="gc-row" role="button" tabIndex={0}
              style={{ gridTemplateColumns: columns, minWidth: 980 }}
              onClick={() => onOpen(row)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row); } }}
              aria-label={`פרטי משלוח ל-${row.toAddress}`}
            >
              <span className="gc-row-n">{row.guestName || "אורח"}</span>
              <span className="ltr-num">{row.reservationNumber ?? "—"}</span>
              <span className="ltr-num gc-row-m">{row.toAddress}</span>
              <span>{row.automationName ?? "שליחה ידנית"}</span>
              <span><span className={chipClass(row.status)}>{STATE_LABEL[row.status] ?? row.status}</span></span>
              <span className="gc-row-m">{dateTime(row.sentAt ?? row.submittedAt ?? row.createdAt)}</span>
              <span className="ltr-num">{row.attemptCount}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DeliveryPanel({ row, onClose }: { row: DeliveryRow; onClose: () => void }) {
  return (
    <SidePanel
      open
      onClose={onClose}
      title="פרטי משלוח"
      subtitle={row.subject ?? row.templateName ?? "הודעת אימייל"}
      icon="mail"
      headerChips={<span className="chip chip-onbrand">{STATE_LABEL[row.status] ?? row.status}</span>}
      footer={<button type="button" className="btn btn-secondary" onClick={onClose}>סגירה</button>}
    >
      <div className="flex flex-col gap-4">
        {row.errorDetail && (
          <p className="field-msg"><Icon name="warning" size={17} /> {row.errorDetail}</p>
        )}
        <section className="card">
          <div className="card-hd">פרטי השליחה</div>
          <dl className="card-bd grid grid-cols-2 gap-3">
            {([
              ["נמען", row.guestName || "אורח"],
              ["כתובת", row.toAddress],
              ["הזמנה", row.reservationNumber ?? "—"],
              ["שולח", row.renderedSenderName || "ברירת המחדל של הערוץ"],
              ["Reply-To", row.renderedReplyTo || "ברירת המחדל"],
              ["ספק", row.provider],
              ["מזהה אצל הספק", row.providerMessageId ?? "—"],
              ["אוטומציה", row.automationName ?? "שליחה ידנית"],
              ["תבנית", row.templateName ?? "—"],
              ["נשלח", dateTime(row.sentAt ?? row.submittedAt)],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <dt className="t-label">{label}</dt>
                <dd className="t-body">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {row.renderedHtml && (
          <section className="card">
            <div className="card-hd">התוכן שנשלח בפועל</div>
            <iframe className="block h-[520px] w-full border-0" sandbox="" srcDoc={row.renderedHtml}
              title="התוכן שנשלח" />
          </section>
        )}

        <section className="card">
          <div className="card-hd">ניסיונות</div>
          <div className="card-bd flex flex-col gap-2">
            {row.attempts.length === 0 ? (
              <p className="t-secondary">אין ניסיונות רשומים.</p>
            ) : row.attempts.map((attempt) => (
              <p key={attempt.number} className="flex items-center gap-2 t-body">
                <span className={chipClass(attempt.result === "submitted" ? "sent" : "failed")}>
                  ניסיון {attempt.number}
                </span>
                <span className="t-secondary">
                  {dateTime(attempt.startedAt)}
                  {attempt.errorCategory ? ` · ${attempt.errorCategory}` : ""}
                </span>
              </p>
            ))}
          </div>
        </section>
      </div>
    </SidePanel>
  );
}

/** One plain comma-separated textarea: everything stays visible and is edited,
 *  deleted, or fixed directly in the field. Validation happens on save. */
function AddressListInput({
  label, hint, value, onChange, disabled, error,
}: {
  label: string; hint: string; value: string; onChange: (next: string) => void;
  disabled: boolean; error?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea className="field-input ltr-num" dir="ltr" rows={2} value={value}
        disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      {error ? <span className="field-msg">{error}</span> : <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** "a@b.co, c@d.co" (commas or newlines) → trimmed non-empty entries. */
const splitAddresses = (text: string): string[] =>
  text.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);

function ChannelsPanel({
  data, canManage, pending, onSave,
}: { data: CommunicationsData; canManage: boolean; pending: boolean; onSave: (input: unknown) => void }) {
  const [attempts, setAttempts] = useState(data.settings.retryPolicy.maxAttempts ?? 5);
  const [ownerEmailsText, setOwnerEmailsText] = useState(data.settings.ownerEmails.join(", "));
  const [ownerPhonesText, setOwnerPhonesText] = useState(data.settings.ownerPhones.join(", "));
  const [ownerErrors, setOwnerErrors] = useState<{ emails?: string; phones?: string }>({});
  const connected = data.channel.email.status === "connected";

  const save = () => {
    const ownerEmails = splitAddresses(ownerEmailsText);
    const ownerPhones = splitAddresses(ownerPhonesText);
    const badEmails = ownerEmails.filter((a) => !EMAIL_RE.test(a));
    const badPhones = ownerPhones.filter((p) => !normalizePhone(p).valid);
    const emailsError = badEmails.length ? `כתובות לא תקינות: ${badEmails.join(", ")}`
      : ownerEmails.length > 10 ? "עד 10 כתובות" : undefined;
    const phonesError = badPhones.length ? `מספרים לא תקינים: ${badPhones.join(", ")}`
      : ownerPhones.length > 10 ? "עד 10 מספרים" : undefined;
    if (emailsError || phonesError) {
      setOwnerErrors({ emails: emailsError, phones: phonesError });
      return;
    }
    setOwnerErrors({});
    onSave({ maxAttempts: attempts, ownerEmails, ownerPhones });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <div className="gc-ph">
          <Icon name="lan" size={20} />
          <h2 className="h4">ערוצי שליחה</h2>
          <span className="gc-ph-d">סטטוס החיבור בפועל. פרטי הגישה מנוהלים מוצפנים ואינם מוצגים.</span>
        </div>
        <div className="card-bd flex flex-col gap-3">
          <article className="flex flex-wrap items-center gap-4 rounded-xl border border-line p-4">
            <span className="gc-row-ic"><Icon name="mail" size={20} /></span>
            <div className="min-w-0 flex-1 basis-40">
              <b className="h4">אימייל</b>
              <p className="t-secondary ltr-num">{data.channel.email.sender ?? "Gmail"}</p>
              <p className="t-label">
                {data.channel.email.detail ?? (connected ? "החיבור פעיל" : "נדרש חיבור ובדיקת ספק")}
              </p>
            </div>
            <span className={chipClass(connected ? "active" : "needs_attention")}>
              {connected ? "מחובר" : "דורש הגדרה"}
            </span>
            <Link className="btn btn-secondary btn-sm" href="/settings?section=messaging">ניהול חיבור</Link>
          </article>
          <article className={`flex flex-wrap items-center gap-4 rounded-xl border border-line p-4${data.channel.whatsappAvailable ? "" : " opacity-70"}`}>
            <span className="gc-row-ic"><Icon name="whatsapp" size={20} /></span>
            <div className="min-w-0 flex-1 basis-40">
              <b className="h4">WhatsApp</b>
              <p className="t-secondary ltr-num">
                {data.channel.whatsapp.provider === "green_api" ? "GREEN-API"
                  : data.channel.whatsapp.provider === "twilio" ? "Twilio" : "—"}
              </p>
              <p className="t-label">
                {data.channel.whatsapp.detail
                  ?? (data.channel.whatsappAvailable
                    ? "החיבור פעיל — אוטומציות WhatsApp זמינות"
                    : "אין ספק מחובר — לא מתבצעת שליחה בערוץ הזה, ואף הודעה לא תוצג כנשלחה.")}
              </p>
            </div>
            <span className={chipClass(data.channel.whatsappAvailable ? "active" : "needs_attention")}>
              {data.channel.whatsappAvailable ? "מחובר" : "דורש הגדרה"}
            </span>
            <Link className="btn btn-secondary btn-sm" href="/settings?section=messaging">ניהול חיבור</Link>
          </article>
          <article className="flex flex-wrap items-center gap-4 rounded-xl border border-line p-4 opacity-70">
            <span className="gc-row-ic"><Icon name="phone" size={20} /></span>
            <div className="min-w-0 flex-1 basis-40">
              <b className="h4">SMS</b>
              <p className="t-label">אין ספק פעיל — לא מתבצעת שליחה בערוץ הזה, ואף הודעה לא תוצג כנשלחה.</p>
            </div>
            <span className="chip chip-cancelled">לא זמין</span>
          </article>
        </div>
      </section>

      <section className="card">
        <div className="gc-ph">
          <Icon name="users-round" size={20} />
          <h2 className="h4">נמעני בעל העסק</h2>
          <span className="gc-ph-d">הכתובות שאליהן נשלחות הודעות כשאוטומציה מסמנת את בעל העסק כנמען.</span>
        </div>
        <div className="card-bd flex flex-col gap-4">
          <AddressListInput
            label="כתובות אימייל של בעל העסק"
            hint="הפרדה בפסיקים. עריכה ומחיקה ישירות בשדה. אוטומציות אימייל לבעל העסק יגיעו לכתובות אלו."
            value={ownerEmailsText} disabled={!canManage} error={ownerErrors.emails}
            onChange={(next) => { setOwnerEmailsText(next); if (ownerErrors.emails) setOwnerErrors((e) => ({ ...e, emails: undefined })); }}
          />
          <AddressListInput
            label="מספרי WhatsApp של בעל העסק"
            hint="הפרדה בפסיקים. עריכה ומחיקה ישירות בשדה. אוטומציות WhatsApp לבעל העסק יגיעו למספרים אלו."
            value={ownerPhonesText} disabled={!canManage} error={ownerErrors.phones}
            onChange={(next) => { setOwnerPhonesText(next); if (ownerErrors.phones) setOwnerErrors((e) => ({ ...e, phones: undefined })); }}
          />
        </div>
      </section>

      <section className="card">
        <div className="gc-ph">
          <Icon name="settings" size={20} />
          <h2 className="h4">כללים כלליים</h2>
        </div>
        <div className="card-bd flex flex-col gap-4">
          <label className="field">
            <span className="field-label">מספר ניסיונות מרבי</span>
            <select className="field-input" value={attempts} disabled={!canManage}
              onChange={(e) => setAttempts(Number(e.target.value))}>
              {[1, 3, 5, 7, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="field-hint">
              כמה פעמים לנסות לשלוח שוב לאחר כשל זמני אצל הספק, בהשהיה עולה. כשל קבוע
              (כתובת לא תקינה, ערוץ מנותק) אינו מנוסה שוב.
            </span>
          </label>
          {canManage && (
            <button type="button" className="btn btn-primary self-start" disabled={pending}
              onClick={save}>
              {pending ? "שומר…" : "שמירת כללים"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

// ============================================================
// The automation panel (D118 reskin — design-ref/whatsapp-automation.html).
//
// Two columns inside the canonical §7 drawer: the form on the reading side, a
// STICKY preview + summary beside it. Everything the design promised that this
// stack cannot deliver was dropped rather than faked:
//   · no Meta approval chip or save gate — GREEN-API has no template approval,
//     so the chip would have no data source. The real lifecycle state shows.
//   · no reply buttons, no verified-business badge, no blue ticks — a
//     GreenApiWhatsAppProvider.sendMessage carries ONE plain string.
//   · no per-OTA chips — see AutomationSources.
// The preview renders the PUBLISHED version through the SAME renderer the send
// path uses, so the bubble carries the guest's exact bytes, RLM marks and all
// (D116). There is no second renderer.
// ============================================================

function AutomationPanel({
  value, templates, ownerAddresses, whatsappAvailable, canActivate, pending,
  datasets, fallbackContext, onClose, onSave,
}: {
  value: AutomationRow | "new"; templates: CommunicationTemplateRow[];
  ownerAddresses: { email: string[]; whatsapp: string[] }; whatsappAvailable: boolean;
  canActivate: boolean; pending: boolean;
  datasets: { id: string; label: string; context: CommunicationRenderContext }[];
  fallbackContext: CommunicationRenderContext;
  onClose: () => void; onSave: (input: unknown) => void;
}) {
  const fresh = value === "new";
  const [name, setName] = useState(fresh ? "" : value.name);
  const [description, setDescription] = useState(fresh ? "" : value.description ?? "");
  const [triggerType, setTriggerType] = useState<TriggerId>(
    fresh ? "reservation.confirmed"
      : (TRIGGER_IDS.includes(value.triggerType as TriggerId) ? value.triggerType as TriggerId : "reservation.confirmed"),
  );
  const [channel, setChannel] = useState<"email" | "whatsapp">(
    fresh ? "email" : (value.channel === "whatsapp" ? "whatsapp" : "email"),
  );
  const trigger = TRIGGERS[triggerType];
  const [offsetDays, setOffsetDays] = useState<number>(() => {
    const stored = fresh ? undefined : Number((value.timing as { offsetDays?: number }).offsetDays);
    return Number.isFinite(stored) ? stored as number : TRIGGERS[fresh ? "reservation.confirmed" : triggerType].offsetDays?.default ?? 0;
  });
  const [sendTime, setSendTime] = useState<string>(() => {
    const stored = fresh ? undefined : (value.timing as { sendTime?: string }).sendTime;
    return stored ?? TRIGGERS[fresh ? "reservation.confirmed" : triggerType].defaultSendTime ?? "10:00";
  });
  const channelTemplates = templates.filter((t) => t.channel === channel);
  const [templateId, setTemplateId] = useState(fresh ? "" : value.templateId);
  const [sources, setSources] = useState<string[]>(
    fresh ? ["back_office", "direct_website"]
      : ((value.sources.include as string[] | undefined) ?? ["back_office", "direct_website"]),
  );
  const [activate, setActivate] = useState(false);
  // A pre-065 recipient_config has no `version` and means guest-only.
  const storedRecipient = fresh || !value.recipient || !("version" in value.recipient)
    ? null
    : value.recipient as { guest?: boolean; owner?: { mode?: string; addresses?: string[] } | null };
  const [toGuest, setToGuest] = useState(storedRecipient ? storedRecipient.guest !== false : true);
  const [toOwner, setToOwner] = useState(Boolean(storedRecipient?.owner));
  const [ownerMode, setOwnerMode] = useState<"all" | "selected">(
    storedRecipient?.owner?.mode === "selected" ? "selected" : "all",
  );
  const availableOwnerAddresses = channel === "whatsapp" ? ownerAddresses.whatsapp : ownerAddresses.email;
  const storedPicks = storedRecipient?.owner?.addresses ?? [];
  const [ownerPicks, setOwnerPicks] = useState<string[]>(() =>
    storedPicks.filter((a) => availableOwnerAddresses.includes(a)));
  const staleDropped = storedPicks.some((a) => !availableOwnerAddresses.includes(a));
  const toggleOwnerPick = (address: string) =>
    setOwnerPicks((current) => current.includes(address)
      ? current.filter((a) => a !== address)
      : current.length < 3 ? [...current, address] : current);
  const toggle = (source: string) =>
    setSources((current) => current.includes(source) ? current.filter((s) => s !== source) : [...current, source]);

  const pickTrigger = (next: TriggerId) => {
    setTriggerType(next);
    const def = TRIGGERS[next];
    if (def.kind === "scheduled") {
      setOffsetDays(def.offsetDays?.default ?? 0);
      setSendTime(def.defaultSendTime ?? "10:00");
    }
    // Switching TO a trigger that cannot carry OTA drops the selection here, so
    // the operator never faces a save the server refuses over a chip that is
    // now disabled and unreachable.
    if (otaSourceBlockReason(next)) setSources((current) => current.filter((s) => s !== "ota"));
  };
  const pickChannel = (next: "email" | "whatsapp") => {
    setChannel(next);
    setTemplateId("");
    // Email addresses mean nothing to a whatsapp automation and vice versa.
    setOwnerMode("all");
    setOwnerPicks([]);
  };

  const selectedTemplateValid = channelTemplates.some((t) => t.id === templateId);
  const recipientsValid = (toGuest || toOwner)
    && (!toOwner || (availableOwnerAddresses.length > 0
      && (ownerMode === "all" || ownerPicks.length > 0)));
  const otaBlockReason = otaSourceBlockReason(triggerType);
  // Mirrors the server's fail-closed refusal: a stored automation whose trigger
  // was later marked otaHardSkip must not look saveable.
  const sourcesValid = sources.length > 0 && !(sources.includes("ota") && otaBlockReason);
  const valid = name.trim().length >= 2 && sourcesValid && selectedTemplateValid && recipientsValid;

  // ---- the honest preview: the PUBLISHED bytes, through the send path's own
  // renderer. A template with no published version has nothing to preview, and
  // says so rather than showing an unpublished draft the guest will never get.
  const selectedTemplate = channelTemplates.find((t) => t.id === templateId) ?? null;
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const previewContext = datasets.find((d) => d.id === datasetId)?.context ?? fallbackContext;
  const preview = useMemo(() => {
    const content = selectedTemplate?.publishedContent as TemplateContent | null | undefined;
    if (!content) return null;
    return renderTemplateContent(content, previewContext, {
      language: (selectedTemplate?.language ?? "he") as TemplateLanguage,
      preheader: selectedTemplate?.preheader || undefined,
    });
  }, [selectedTemplate, previewContext]);

  // The server clamps an out-of-range offset SILENTLY (actions.ts). Say so here
  // instead, so 99 days never becomes 30 behind the operator's back.
  const offsetOutOfRange = trigger.kind === "scheduled" && Boolean(trigger.offsetDays)
    && (offsetDays < trigger.offsetDays!.min || offsetDays > trigger.offsetDays!.max);

  // The published lifecycle state — the honest replacement for the design's
  // Meta-approval chip. GREEN-API has no template approval to report.
  const templateStateLabel = selectedTemplate
    ? `מפורסמת${selectedTemplate.version ? ` · גרסה ${selectedTemplate.version}` : ""}`
    : "לא נבחרה תבנית";

  const ownerCount = toOwner
    ? (ownerMode === "all" ? availableOwnerAddresses.length : ownerPicks.length)
    : 0;
  const recipientsLabel = [
    toGuest ? "המזמין" : null,
    ownerCount ? `${ownerCount}${channel === "whatsapp" ? " מספרים בעסק" : " כתובות בעסק"}` : null,
  ].filter(Boolean).join(" · ") || "לא נבחר נמען";

  const summaryRows: { icon: IconName; label: string; value: string }[] = [
    {
      icon: "automations", label: "טריגר",
      value: describeTiming(triggerType, trigger.kind === "scheduled" ? { offsetDays, sendTime } : null),
    },
    {
      icon: "filter", label: "מקורות",
      value: SOURCE_GROUPS.filter((g) => sources.includes(g.id)).map((g) => g.label).join(" · ")
        || "לא נבחר מקור",
    },
    { icon: "guests", label: "נמענים", value: recipientsLabel },
    {
      icon: channel === "whatsapp" ? "whatsapp" : "mail", label: "ערוץ ותבנית",
      value: `${channel === "whatsapp" ? "WhatsApp" : "אימייל"} · ${selectedTemplate?.name ?? "לא נבחרה תבנית"}`,
    },
  ];

  return (
    <SidePanel
      open
      onClose={onClose}
      title={fresh ? "אוטומציה חדשה" : `עריכת אוטומציה — ${value.name}`}
      subtitle="האוטומציה תחול על אירועים חדשים בלבד. אין שליחה רטרואקטיבית להזמנות קיימות."
      icon="automations"
      footer={
        <>
          <button type="button" className="btn btn-primary" disabled={!valid || pending}
            onClick={() => onSave({
              id: fresh ? undefined : value.id, name, description,
              triggerType, channel, templateId, sources, activate,
              recipient: {
                guest: toGuest,
                owner: toOwner
                  ? (ownerMode === "all" ? { mode: "all" } : { mode: "selected", addresses: ownerPicks })
                  : null,
              },
              ...(trigger.kind === "scheduled" ? { offsetDays, sendTime } : {}),
            })}>
            {activate ? "שמירה והפעלה" : "שמירה כטיוטה"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <div className="gc-auto">
        <div className="gc-auto-main">

          <section className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="edit" size={20} /> פרטים
            </div>
            <div className="card-bd flex flex-col gap-3">
              <label className="field">
                <span className="field-label">שם האוטומציה</span>
                <input className="field-input" value={name} maxLength={120}
                  onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: אישור הזמנה לאורח" />
              </label>
              <label className="field">
                <span className="field-label">תיאור פנימי</span>
                <textarea className="field-input" rows={2} value={description} maxLength={500}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="למה האוטומציה הזאת קיימת ומי אחראי עליה" />
              </label>
            </div>
          </section>

          <section className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="automations" size={20} /> מתי
              <span className="gc-hd-meta">{trigger.label}</span>
            </div>
            <div className="card-bd flex flex-col gap-3">
              <label className="field">
                <span className="field-label">טריגר</span>
                <select className="field-input" value={triggerType}
                  onChange={(e) => pickTrigger(e.target.value as TriggerId)}>
                  {TRIGGER_LIST.map((def) => (
                    <option key={def.id} value={def.id}>{def.label}</option>
                  ))}
                </select>
                <span className="field-hint">{trigger.description}</span>
              </label>
              {trigger.kind === "scheduled" && (
                <div className="gc-meta-grid">
                  {trigger.direction !== "on" && trigger.offsetDays && (
                    <label className="field">
                      <span className="field-label">
                        {trigger.direction === "before" ? "ימים לפני" : "ימים אחרי"}
                      </span>
                      <input className="field-input ltr-num" type="number"
                        min={trigger.offsetDays.min} max={trigger.offsetDays.max} value={offsetDays}
                        onChange={(e) => setOffsetDays(Number(e.target.value))} />
                      {offsetOutOfRange && (
                        <span className="field-msg">
                          {`הטווח המותר לטריגר הזה הוא ${trigger.offsetDays.min}–${trigger.offsetDays.max} ימים`}
                        </span>
                      )}
                    </label>
                  )}
                  <label className="field">
                    <span className="field-label">שעת שליחה</span>
                    <input className="field-input ltr-num" type="time" value={sendTime}
                      onChange={(e) => setSendTime(e.target.value)} />
                  </label>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="filter" size={20} /> על אילו הזמנות
              <span className="gc-hd-meta">
                {sources.length ? `${sources.length} מקורות נבחרו` : "לא נבחר מקור"}
              </span>
            </div>
            <div className="card-bd flex flex-col gap-3">
              <div className="gc-srcs">
                {SOURCE_GROUPS.map((group) => {
                  const on = sources.includes(group.id);
                  // The OTA group is the ONLY one that can be capability-blocked,
                  // and when it is, it is DISABLED with the reason spelled out
                  // below — never an enabled control that sends nothing (D118).
                  const blocked = group.id === "ota" ? otaBlockReason : null;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      className={`gc-src${on ? " is-on" : ""}${on && group.id === "ota" ? " is-warn" : ""}`}
                      aria-pressed={on}
                      disabled={Boolean(blocked)}
                      title={blocked ?? group.hint}
                      onClick={() => toggle(group.id)}
                    >
                      <Icon name={on ? "check" : "circle"} size={17} />
                      {group.label}
                    </button>
                  );
                })}
              </div>
              {otaBlockReason && (
                <p className="gc-auto-note">
                  <Icon name="info" size={17} />
                  <span>{`ערוצי OTA אינם זמינים לטריגר הזה — ${otaBlockReason}`}</span>
                </p>
              )}
              {/* D119 — the OTA source is switchable now, so the warning that
                  used to be a BLOCK becomes an amber consequence the operator
                  reads before saving: the channel already confirmed this
                  booking, so the guest receives a second confirmation. Shown
                  only for a trigger where that is actually true. */}
              {!otaBlockReason && sources.includes("ota") && triggerType === "reservation.confirmed" && (
                <p className="gc-auto-note is-warn">
                  <Icon name="warning" size={17} />
                  <span>
                    ה-OTA שולח לאורח אישור הזמנה משלו — האורח יקבל אישור נוסף מכם.
                    זו הודעה כפולה במכוון; כבו את המקור הזה אם אינכם רוצים בה.
                  </span>
                </p>
              )}
              {sources.length === 0 && <p className="field-msg">יש לבחור לפחות מקור אחד</p>}
            </div>
          </section>

          <section className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="send" size={20} /> ערוץ ותבנית
              <span className={`gc-hd-chip${selectedTemplate ? " is-ok" : ""}`}>
                {templateStateLabel}
              </span>
            </div>
            <div className="card-bd flex flex-col gap-3">
              <div className="field">
                <span className="field-label">ערוץ שליחה</span>
                {/* WhatsApp FIRST in the DOM — RTL puts the first child on the
                    right, which is where the design seats it (design line 394). */}
                <div className="gc-seg">
                  <button type="button" className="gc-segb" aria-pressed={channel === "whatsapp"}
                    disabled={!whatsappAvailable && channel !== "whatsapp"}
                    title={whatsappAvailable ? undefined : "אין ספק WhatsApp מחובר — חברו ספק בהגדרות ההודעות"}
                    onClick={() => pickChannel("whatsapp")}>
                    <Icon name="whatsapp" size={17} /> WhatsApp
                  </button>
                  <button type="button" className="gc-segb" aria-pressed={channel === "email"}
                    onClick={() => pickChannel("email")}>
                    <Icon name="mail" size={17} /> אימייל
                  </button>
                </div>
                {!whatsappAvailable && (
                  <span className="field-hint">שליחת WhatsApp דורשת ספק מחובר ובדוק (הגדרות ← הודעות).</span>
                )}
              </div>
              <label className="field">
                <span className="field-label">תבנית מפורסמת</span>
                <select className="field-input" value={selectedTemplateValid ? templateId : ""}
                  onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">בחירת תבנית</option>
                  {channelTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}{template.version ? ` (v${template.version})` : ""}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  בכל משלוח נשמר snapshot של הגרסה שנשלחה — עדכון התבנית לא משנה היסטוריה.
                </span>
              </label>
              {channelTemplates.length === 0 && (
                <p className="field-msg">
                  {channel === "whatsapp"
                    ? "אין תבנית WhatsApp מפורסמת. יש לפרסם תבנית לפני הפעלה."
                    : "אין תבנית אימייל מפורסמת. יש לפרסם תבנית לפני הפעלה."}
                </p>
              )}
              <span className="gc-toggle">
                <span className="gc-auto-tt">
                  הפעלה מיד לאחר שמירה
                  <span className="gc-hint">
                    {activate
                      ? "תחול על אירועים חדשים בלבד — הזמנות קיימות לא ייקבלו הודעה."
                      : "תישמר כטיוטה ולא תישלח עד שתופעל."}
                  </span>
                </span>
                <button type="button" className="gc-sw" role="switch" aria-checked={activate}
                  disabled={!canActivate} onClick={() => setActivate(!activate)}
                  aria-label="הפעלה מיד לאחר שמירה" />
              </span>
            </div>
          </section>

          <section className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="guests" size={20} /> נמענים
              <span className="gc-hd-meta">{recipientsLabel}</span>
            </div>
            <div className="card-bd flex flex-col gap-3">
              <span className="gc-toggle">
                <span className="gc-auto-tt">
                  המזמין
                  <span className="gc-hint">
                    {channel === "whatsapp"
                      ? "למספר הוואטסאפ שנשמר בהזמנה"
                      : "לכתובת המייל שנשמרה בהזמנה"}
                  </span>
                </span>
                <button type="button" className="gc-sw" role="switch" aria-checked={toGuest}
                  onClick={() => setToGuest(!toGuest)} aria-label="המזמין" />
              </span>
              <span className="gc-toggle">
                <span className="gc-auto-tt">
                  בעל העסק
                  <span className="gc-hint">עותק פנימי לצוות — האורח אינו רואה אותו.</span>
                </span>
                <button type="button" className="gc-sw" role="switch" aria-checked={toOwner}
                  onClick={() => setToOwner(!toOwner)} aria-label="בעל העסק" />
              </span>
              {!toGuest && !toOwner && (
                <p className="field-msg">יש לבחור לפחות נמען אחד</p>
              )}
              {toOwner && availableOwnerAddresses.length === 0 && (
                <p className="field-msg">
                  {channel === "whatsapp"
                    ? "לא הוגדרו מספרי WhatsApp של בעל העסק — ניתן להוסיף בלשונית ערוצי שליחה"
                    : "לא הוגדרו כתובות אימייל של בעל העסק — ניתן להוסיף בלשונית ערוצי שליחה"}
                </p>
              )}
              {toOwner && availableOwnerAddresses.length > 0 && (
                <div className="field">
                  <div className="gc-seg">
                    <button type="button" className="gc-segb" aria-pressed={ownerMode === "all"}
                      onClick={() => setOwnerMode("all")}>
                      {channel === "whatsapp" ? "כל המספרים" : "כל הכתובות"}
                    </button>
                    <button type="button" className="gc-segb" aria-pressed={ownerMode === "selected"}
                      onClick={() => setOwnerMode("selected")}>
                      בחירה ידנית
                    </button>
                  </div>
                  {ownerMode === "selected" && (
                    <>
                      <div className="flex flex-col gap-2 pt-2">
                        {availableOwnerAddresses.map((address) => (
                          <label key={address} className="flex items-center gap-2 p-1 t-body">
                            <input type="checkbox" checked={ownerPicks.includes(address)}
                              disabled={!ownerPicks.includes(address) && ownerPicks.length >= 3}
                              onChange={() => toggleOwnerPick(address)} />
                            <span className="ltr-num">{address}</span>
                          </label>
                        ))}
                      </div>
                      <span className="field-hint">ניתן לבחור עד 3 כתובות</span>
                      {staleDropped && (
                        <span className="field-hint">כתובות שנמחקו מההגדרות הוסרו מהבחירה</span>
                      )}
                      {ownerPicks.length === 0 && (
                        <p className="field-msg">יש לבחור לפחות כתובת אחת</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="gc-auto-side">
          <section className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="eye" size={20} /> מה האורח יראה
              {datasets.length > 0 && (
                <select className="field-input gc-select gc-hd-select" value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)} aria-label="הזמנה לתצוגה">
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>{dataset.label}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="card-bd flex flex-col gap-3">
              {!selectedTemplate ? (
                <p className="gc-hint">בחרו תבנית כדי לראות את ההודעה שתישלח.</p>
              ) : !preview ? (
                <p className="field-msg">
                  לתבנית הזו אין עדיין גרסה מפורסמת — אין מה להציג, ואין מה לשלוח.
                </p>
              ) : channel === "whatsapp" ? (
                // The SAME bytes the guest receives, RLM marks included (D116).
                // A text node, never innerHTML — and no reply buttons, verified
                // badge or read ticks: GREEN-API sends one plain string.
                <div className="gc-wa-chat" dir="rtl">
                  <div className="gc-wa-bubble">
                    {preview.plainText || "ההודעה ריקה"}
                  </div>
                </div>
              ) : (
                <iframe className="block w-full border-0" style={{ height: 420 }} sandbox=""
                  srcDoc={preview.html} title="תצוגה מקדימה של האימייל" />
              )}
              {preview && (
                <p className="gc-hint">
                  <Icon name="variables" size={17} /> המשתנים מוצגים בערכי ההזמנה שנבחרה
                </p>
              )}
              {preview?.issues.map((issue) => (
                <p key={`${issue.kind}:${issue.key}`}
                  className={issue.kind === "missing_optional" ? "gc-hint" : "field-msg"}>
                  {issue.kind === "missing_optional"
                    ? `${issue.key} — אין ערך בהזמנה הזו; השורה תישלח בלי הערך`
                    : `${issue.key} — חסר ערך חובה; ההודעה לא תישלח`}
                </p>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-hd flex items-center gap-2">
              <Icon name="list" size={20} /> סיכום
            </div>
            <div className="card-bd gc-auto-sum">
              {summaryRows.map((row) => (
                <div key={row.label} className="gc-auto-row">
                  <Icon name={row.icon} size={17} />
                  <span className="flex flex-col">
                    <span className="field-label">{row.label}</span>
                    <span className="gc-auto-rowv">{row.value}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </SidePanel>
  );
}

/** The creation window (§1) — ref/screens/CreateGuestCommunicationWindowes.png.
 *  Captures a real, editable name + category + channel and a STARTING POINT:
 *  truly blank (blocks or raw HTML for email, plain text for WhatsApp), a
 *  gallery example, or a duplicate of an existing same-channel template. The
 *  content kind is fixed here and never changes on the template afterwards.
 *  Nothing is published and no automation is created. */
function NewTemplateDialog({
  templates, onCancel, onCreate,
}: {
  templates: CommunicationTemplateRow[];
  onCancel: () => void;
  onCreate: (seed: EditorSeed) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("reservation");
  const [channel, setChannel] = useState<CommunicationChannel>("email");
  const [mode, setMode] = useState<"blank" | "blank_html" | "gallery" | "duplicate">("blank");
  const [exampleId, setExampleId] = useState("");
  const [sourceId, setSourceId] = useState("");

  const channelTemplates = templates.filter((t) => t.channel === channel);
  const gallery = TEMPLATE_GALLERY.filter((example) => example.channel === channel);

  const pickChannel = (next: CommunicationChannel) => {
    setChannel(next);
    setMode("blank");
    setExampleId("");
    setSourceId("");
  };

  const trimmed = name.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 120
    && (mode === "blank" || mode === "blank_html"
      || (mode === "gallery" && Boolean(exampleId))
      || (mode === "duplicate" && Boolean(sourceId)));

  const submit = () => {
    if (!valid) return;
    if (mode === "gallery") {
      const example = gallery.find((item) => item.id === exampleId);
      if (!example) return;
      onCreate({
        name: trimmed, category: example.category,
        subject: example.subject, preheader: example.preheader, content: example.content,
      });
      return;
    }
    if (mode === "duplicate") {
      const source = channelTemplates.find((t) => t.id === sourceId);
      const draft = source?.draftContent ?? null;
      onCreate({
        name: trimmed, category,
        subject: source?.subject ?? undefined, preheader: source?.preheader || undefined,
        content: draft ? (draft as EditorSeed["content"]) : emptyContentFor(channel),
      });
      return;
    }
    // Blank is BLANK: zero blocks / empty HTML / empty text.
    onCreate({ name: trimmed, category, content: emptyContentFor(channel, mode === "blank_html" ? "html" : "blocks") });
  };

  const startingPoints: [typeof mode, string, string][] = channel === "email"
    ? [
      ["blank", "תבנית ריקה — עורך בלוקים", "קנבס ריק לחלוטין, בונים בלוק-בלוק"],
      ["blank_html", "תבנית ריקה — קוד HTML", "מדביקים מסמך HTML מוכן; משתני {{...}} עובדים"],
      ["gallery", "התחלה מדוגמה", "דוגמה מוכנה שנפתחת לעריכה מלאה"],
      ["duplicate", "שכפול תבנית קיימת", "מעתיקים תבנית ומתאימים"],
    ]
    : [
      ["blank", "תבנית ריקה", "הודעת טקסט ריקה — כותבים מאפס"],
      ["gallery", "התחלה מדוגמה", "דוגמה מוכנה שנפתחת לעריכה מלאה"],
      ["duplicate", "שכפול תבנית קיימת", "מעתיקים תבנית ומתאימים"],
    ];

  return (
    <SidePanel
      open
      onClose={onCancel}
      title="תבנית חדשה"
      subtitle="בחרו שם, ערוץ ונקודת התחלה — התוכן נערך בעורך התבנית. אין פרסום ואין יצירת אוטומציה בשלב זה."
      icon="documents"
      footer={
        <>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={submit}>
            <Icon name="plus" size={17} /> יצירת תבנית
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>ביטול</button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="card">
          <div className="card-hd">פרטי התבנית</div>
          <div className="card-bd flex flex-col gap-3">
            <label className="field">
              <span className="gc-label-row">
                <span className="field-label">שם התבנית</span>
                <span className="gc-cnt">{trimmed.length}/120</span>
              </span>
              <input
                className="field-input"
                value={name}
                maxLength={120}
                autoFocus
                placeholder="לדוגמה: מכתב ברוכים הבאים"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
              />
              {name.length > 0 && trimmed.length < 2 && (
                <span className="field-msg">יש להזין שם תבנית</span>
              )}
            </label>
            <label className="field">
              <span className="field-label">קטגוריה</span>
              <select className="field-input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {STAGE_KEYS.map((key) => <option key={key} value={key}>{STAGE_LABELS[key]}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">ערוץ</span>
              <select className="field-input" value={channel}
                onChange={(e) => pickChannel(e.target.value as CommunicationChannel)}>
                <option value="email">אימייל</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms" disabled>SMS (בקרוב)</option>
              </select>
              <span className="field-hint">הערוץ קובע את סוג העורך ואינו ניתן לשינוי אחרי היצירה.</span>
            </label>
          </div>
        </section>

        <section className="card">
          <div className="card-hd">נקודת התחלה</div>
          <div className="card-bd flex flex-col gap-3">
            {startingPoints.map(([key, label, hint]) => (
              <label key={key} className="gc-radio">
                <input type="radio" name="create-mode" checked={mode === key} onChange={() => setMode(key)} />
                <span>
                  <b>{label}</b>
                  <span className="t-label">{hint}</span>
                </span>
              </label>
            ))}
            {mode === "gallery" && (
              <label className="field">
                <span className="field-label">דוגמה</span>
                <select className="field-input" value={exampleId} onChange={(e) => setExampleId(e.target.value)}>
                  <option value="">בחירת דוגמה</option>
                  {gallery.map((example) => (
                    <option key={example.id} value={example.id}>{example.name} — {example.description}</option>
                  ))}
                </select>
                <span className="field-hint">הדוגמה נטענת לעורך וניתנת לשינוי מלא — כלום לא נשלח בלי פרסום.</span>
              </label>
            )}
            {mode === "duplicate" && (
              <label className="field">
                <span className="field-label">תבנית מקור</span>
                <select className="field-input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">{channelTemplates.length === 0 ? "אין תבניות לשכפול בערוץ הזה" : "בחירת תבנית"}</option>
                  {channelTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
          </div>
        </section>
      </div>
    </SidePanel>
  );
}
