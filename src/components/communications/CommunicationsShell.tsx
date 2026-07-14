"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { TemplateEditor } from "./TemplateEditor";
import { STAGE_KEYS, STAGE_LABELS, usageLabel } from "@/lib/communications/blocks";
import type { CommunicationRenderContext } from "@/lib/communications/types";
import type {
  AutomationRow, CommunicationsData, CommunicationTemplateRow, DeliveryRow,
} from "@/app/(dashboard)/communications/data";
import {
  archiveTemplateAction, duplicateTemplateAction, saveAutomationAction,
  saveCommunicationSettingsAction, setAutomationStatusAction,
  type CommunicationActionResult,
} from "@/app/(dashboard)/communications/actions";

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
  const [editing, setEditing] = useState<CommunicationTemplateRow | "new" | null>(null);
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

  const openTemplate = (template: CommunicationTemplateRow | "new") => {
    if (template === "new" && !permissions.editTemplates) return;
    setEditing(template);
  };

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
          <button type="button" className="btn btn-primary" onClick={() => openTemplate("new")}>
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
                  {[["all", "כל הערוצים"], ["email", "אימייל"], ["whatsapp", "WhatsApp"], ["sms", "SMS"]].map(([value, label]) => (
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
                  <button type="button" className="btn btn-primary" onClick={() => openTemplate("new")}>
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
                    <span className="gc-row-ic"><Icon name="mail" size={20} /></span>
                    <span className="gc-row-n">{template.name}</span>
                    <span><span className="chip chip-brand"><Icon name="mail" size={13.5} /> אימייל</span></span>
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
                  <span className="gc-row-ic"><Icon name="mail" size={20} /></span>
                  <span className="gc-row-n">{template.name}</span>
                  <span><span className="chip chip-brand"><Icon name="mail" size={13.5} /> אימייל</span></span>
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

      {editing && (
        <TemplateEditor
          key={editing === "new" ? "new" : editing.id}
          template={editing === "new" ? null : editing}
          datasets={datasets}
          fallbackContext={fallbackContext}
          senderAddress={data.channel.email.sender}
          canEdit={permissions.editTemplates}
          canPublish={permissions.publishTemplates}
          canTest={permissions.testSend}
          onClose={() => setEditing(null)}
        />
      )}

      {delivery && <DeliveryPanel row={delivery} onClose={() => setDelivery(null)} />}

      {automation && (
        <AutomationPanel
          value={automation}
          templates={live.filter((t) => t.state === "published")}
          canActivate={permissions.activateAutomations}
          pending={pending}
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
            <article key={row.id} className="flex items-center gap-4 border-b border-line p-4 last:border-b-0">
              <button
                type="button"
                className="gc-sw"
                role="switch"
                aria-checked={row.status === "active"}
                aria-label={row.status === "active" ? "השבתה" : "הפעלה"}
                disabled={!permissions.activateAutomations || pending}
                onClick={() => onToggle(row)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="h4">{row.name}</b>
                  <span className={chipClass(row.status)}>{STATE_LABEL[row.status] ?? row.status}</span>
                </div>
                <p className="t-secondary">{row.description || "ללא תיאור"}</p>
                <p className="t-label mt-1">
                  עם אישור הזמנה · שליחה מיידית · {row.templateName}
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

function ChannelsPanel({
  data, canManage, pending, onSave,
}: { data: CommunicationsData; canManage: boolean; pending: boolean; onSave: (input: unknown) => void }) {
  const [quiet, setQuiet] = useState(Boolean(data.settings.quietHours.enabled));
  const [start, setStart] = useState(data.settings.quietHours.start ?? "22:00");
  const [end, setEnd] = useState(data.settings.quietHours.end ?? "07:00");
  const [attempts, setAttempts] = useState(data.settings.retryPolicy.maxAttempts ?? 5);
  const [failureEnabled, setFailureEnabled] = useState(Boolean(data.settings.failureNotification.enabled));
  const [failureEmail, setFailureEmail] = useState(data.settings.failureNotification.email ?? "");
  const connected = data.channel.email.status === "connected";

  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <div className="gc-ph">
          <Icon name="lan" size={20} />
          <h2 className="h4">ערוצי שליחה</h2>
          <span className="gc-ph-d">סטטוס החיבור בפועל. פרטי הגישה מנוהלים מוצפנים ואינם מוצגים.</span>
        </div>
        <div className="card-bd flex flex-col gap-3">
          <article className="flex items-center gap-4 rounded-xl border border-line p-4">
            <span className="gc-row-ic"><Icon name="mail" size={20} /></span>
            <div className="min-w-0 flex-1">
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
          {([["WhatsApp", "whatsapp"], ["SMS", "phone"]] as const).map(([label, icon]) => (
            <article key={label} className="flex items-center gap-4 rounded-xl border border-line p-4 opacity-70">
              <span className="gc-row-ic"><Icon name={icon} size={20} /></span>
              <div className="min-w-0 flex-1">
                <b className="h4">{label}</b>
                <p className="t-label">אין ספק פעיל — לא מתבצעת שליחה בערוץ הזה, ואף הודעה לא תוצג כנשלחה.</p>
              </div>
              <span className="chip chip-cancelled">לא זמין</span>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="gc-ph">
          <Icon name="settings" size={20} />
          <h2 className="h4">כללים כלליים</h2>
        </div>
        <div className="card-bd flex flex-col gap-4">
          <span className="gc-toggle">
            <button type="button" className="gc-sw" role="switch" aria-checked={quiet}
              disabled={!canManage} onClick={() => setQuiet(!quiet)} aria-label="שעות שקטות" />
            שעות שקטות
          </span>
          {quiet && (
            <div className="gc-meta-grid">
              <label className="field">
                <span className="field-label">התחלה</span>
                <input className="field-input" type="time" value={start} disabled={!canManage}
                  onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">סיום</span>
                <input className="field-input" type="time" value={end} disabled={!canManage}
                  onChange={(e) => setEnd(e.target.value)} />
              </label>
            </div>
          )}
          <label className="field">
            <span className="field-label">מספר ניסיונות מרבי</span>
            <select className="field-input" value={attempts} disabled={!canManage}
              onChange={(e) => setAttempts(Number(e.target.value))}>
              {[1, 3, 5, 7, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <span className="gc-toggle">
            <button type="button" className="gc-sw" role="switch" aria-checked={failureEnabled}
              disabled={!canManage} onClick={() => setFailureEnabled(!failureEnabled)} aria-label="התראת כשל" />
            התראה על כשל סופי
          </span>
          {failureEnabled && (
            <label className="field">
              <span className="field-label">אימייל להתראה</span>
              <input className="field-input ltr-num" type="email" value={failureEmail} disabled={!canManage}
                onChange={(e) => setFailureEmail(e.target.value)} placeholder="ops@example.com" />
            </label>
          )}
          {canManage && (
            <button type="button" className="btn btn-primary self-start" disabled={pending}
              onClick={() => onSave({
                quietEnabled: quiet, quietStart: start, quietEnd: end, maxAttempts: attempts,
                failureEnabled, failureEmail: failureEmail.trim(),
                manualBookingRecipients: data.settings.manualBookingRecipients,
                directBookingRecipients: data.settings.directBookingRecipients,
              })}>
              {pending ? "שומר…" : "שמירת כללים"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function AutomationPanel({
  value, templates, canActivate, pending, onClose, onSave,
}: {
  value: AutomationRow | "new"; templates: CommunicationTemplateRow[]; canActivate: boolean;
  pending: boolean; onClose: () => void; onSave: (input: unknown) => void;
}) {
  const fresh = value === "new";
  const [name, setName] = useState(fresh ? "" : value.name);
  const [description, setDescription] = useState(fresh ? "" : value.description ?? "");
  const [templateId, setTemplateId] = useState(fresh ? templates[0]?.id ?? "" : value.templateId);
  const [sources, setSources] = useState<string[]>(
    fresh ? ["back_office", "direct_website"]
      : ((value.sources.include as string[] | undefined) ?? ["back_office", "direct_website"]),
  );
  const [activate, setActivate] = useState(false);
  const toggle = (source: string) =>
    setSources((current) => current.includes(source) ? current.filter((s) => s !== source) : [...current, source]);
  const valid = name.trim().length >= 2 && sources.length > 0 && Boolean(templateId);

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
              triggerType: "reservation.confirmed", templateId, sources, activate,
            })}>
            {activate ? "שמירה והפעלה" : "שמירה כטיוטה"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="card">
          <div className="card-hd">מתי</div>
          <div className="card-bd flex flex-col gap-3">
            <p className="t-body">כאשר <b>הזמנה מאושרת</b> — האירוע נכנס לתור מיד.</p>
            <p className="t-secondary">
              הזמנות מ־Booking.com, Airbnb וכל ערוץ OTA מוחרגות תמיד: ה-OTA כבר שולח אישור משלו.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-hd">פרטים</div>
          <div className="card-bd flex flex-col gap-3">
            <label className="field">
              <span className="field-label">שם האוטומציה</span>
              <input className="field-input" value={name} maxLength={120}
                onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: אישור הזמנה לאורח" />
            </label>
            <label className="field">
              <span className="field-label">תיאור</span>
              <textarea className="field-input" rows={3} value={description} maxLength={500}
                onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
        </section>

        <section className="card">
          <div className="card-hd">מקורות הזמנה</div>
          <div className="card-bd flex flex-col gap-3">
            {([["back_office", "הזמנה ידנית (Back-office)"], ["direct_website", "אתר הזמנות ישיר"]] as const).map(([key, label]) => (
              <span key={key} className="gc-toggle">
                <button type="button" className="gc-sw" role="switch" aria-checked={sources.includes(key)}
                  onClick={() => toggle(key)} aria-label={label} />
                {label}
              </span>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-hd">תבנית</div>
          <div className="card-bd flex flex-col gap-3">
            <label className="field">
              <span className="field-label">תבנית מפורסמת</span>
              <select className="field-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">בחירת תבנית</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}{template.version ? ` (v${template.version})` : ""}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                בכל משלוח נשמר snapshot של הגרסה שנשלחה — עדכון התבנית לא משנה היסטוריה.
              </span>
            </label>
            {templates.length === 0 && (
              <p className="field-msg">אין תבנית אימייל מפורסמת. יש לפרסם תבנית לפני הפעלה.</p>
            )}
            <span className="gc-toggle">
              <button type="button" className="gc-sw" role="switch" aria-checked={activate}
                disabled={!canActivate} onClick={() => setActivate(!activate)}
                aria-label="הפעלה מיד לאחר שמירה" />
              הפעלה מיד לאחר שמירה (אירועים חדשים בלבד)
            </span>
          </div>
        </section>
      </div>
    </SidePanel>
  );
}
