"use client";

import { useState, useTransition } from "react";
import { Icon } from "@/components/shared/Icon";
import { previewAutomationAction } from "@/app/(dashboard)/communications/actions";
import type { AutomationPreview as PreviewData, PreviewRow } from "@/lib/communications/preview";

// D203 — "מי יקבל ב-7 הימים הקרובים". Runs the editor's CURRENT state (saved or
// not, active or not) through the real scheduler predicate and engine on the
// server, read-only. From 1280px a table per day; below it a card per row.

const WEEKDAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
function dayLabel(date: string, index: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const head = index === 0 ? "היום" : index === 1 ? "מחר" : `יום ${weekday}`;
  return `${head} · ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

function Status({ row }: { row: PreviewRow }) {
  return row.included
    ? <span className="chip chip-paid">יקבל</span>
    : <span className="chip chip-neutral">לא יקבל</span>;
}

function MessagePreview({ row }: { row: PreviewRow }) {
  if (!row.message) return null;
  return row.message.html ? (
    <div className="gc-pv-msg">
      {row.message.subject && <p className="gc-pv-subject">נושא: {row.message.subject}</p>}
      <iframe className="gc-pv-frame" sandbox="" srcDoc={row.message.html} title="תצוגת ההודעה" />
    </div>
  ) : (
    <div className="gc-wa-chat gc-pv-msg" dir="rtl">
      <div className="gc-wa-bubble">{row.message.text}</div>
    </div>
  );
}

export function AutomationPreview({ input, scheduled, ready }: {
  /** exactly the object the panel's save sends */
  input: Record<string, unknown>;
  scheduled: boolean;
  /** a template and a source are chosen — the schema's minimum */
  ready: boolean;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () => start(async () => {
    setError(null);
    const res = await previewAutomationAction(input);
    if (res.success) setData(res.data);
    else { setData(null); setError(res.error); }
  });

  const result = data?.kind === "scheduled" ? data : null;
  return (
    <section className="card">
      <div className="card-hd flex items-center gap-2">
        <Icon name="eye" size={20} /> מי יקבל ב-7 הימים הקרובים
        {result && (
          <span className="gc-hd-meta">
            <span className="ltr-num">{result.included}</span> יקבלו · <span className="ltr-num">{result.excluded}</span> לא
          </span>
        )}
      </div>
      <div className="card-bd flex flex-col gap-3">
        {!scheduled ? (
          <p className="gc-hint">
            <Icon name="info" size={17} />
            התצוגה זמינה לאוטומציות לפי תאריכי השהייה בלבד. אוטומציה לפי אירוע נשלחת ברגע שהאירוע קורה.
          </p>
        ) : (
          <>
            <p className="gc-hint">
              <Icon name="info" size={17} />
              לפי ההגדרות שעל המסך, גם לפני שמירה. שום דבר לא נשלח ולא נשמר.
            </p>
            <button type="button" className="btn btn-secondary gc-pv-run" disabled={!ready || pending} onClick={run}>
              <Icon name="eye" size={20} />
              {pending ? "מחשב…" : "מי יקבל ב-7 הימים הקרובים"}
            </button>
            {!ready && <p className="gc-hint">יש לבחור תבנית ולפחות מקור הזמנה אחד.</p>}
            {error && <p className="field-msg">{error}</p>}
          </>
        )}

        {result && result.days.map((day, index) => (
          <div key={day.date} className="gc-pv-day">
            <p className="gc-pv-day-hd">
              <span>{dayLabel(day.date, index)}</span>
              <span className="gc-pv-day-n">
                <span className="ltr-num">{day.rows.filter((r) => r.included).length}</span> יקבלו ·{" "}
                <span className="ltr-num">{day.rows.filter((r) => !r.included).length}</span> לא
              </span>
            </p>
            {day.rows.length === 0 ? (
              <p className="gc-hint">אין הזמנות שהיום הזה חל עליהן.</p>
            ) : (
              <>
                {/* desktop (≥1280 — the panel is 60% wide, a narrower table overflows): a table */}
                <table className="gc-pv-table hidden xl:table">
                  <thead>
                    <tr>
                      <th>שעה</th><th>הזמנה</th><th>אורח</th><th>טלפון</th><th>סטטוס</th><th>סיבה</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {day.rows.map((row, i) => {
                      const key = `${day.date}:${i}`;
                      return [
                        <tr key={key}>
                          <td className="ltr-num">{row.time ?? "—"}</td>
                          <td className="ltr-num">{row.reservationNumber}</td>
                          <td className="gc-pv-guest">{row.guestName}</td>
                          <td className="ltr-num">{row.contact}</td>
                          <td><Status row={row} /></td>
                          <td className="gc-pv-reason">{row.reason ?? ""}</td>
                          <td>
                            {row.message && (
                              <button type="button" className="btn btn-secondary gc-pv-msgbtn"
                                aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                                <Icon name="eye" size={17} /> הודעה
                              </button>
                            )}
                          </td>
                        </tr>,
                        open === key ? (
                          <tr key={`${key}:msg`}><td colSpan={7}><MessagePreview row={row} /></td></tr>
                        ) : null,
                      ];
                    })}
                  </tbody>
                </table>
                {/* below 1280: a card per row */}
                <ul className="gc-pv-cards flex flex-col gap-2 xl:hidden">
                  {day.rows.map((row, i) => {
                    const key = `${day.date}:${i}`;
                    return (
                      <li key={key} className="gc-pv-card">
                        <div className="gc-pv-card-top">
                          <span className="gc-pv-name">{row.guestName}</span>
                          <Status row={row} />
                        </div>
                        <p className="gc-pv-meta">
                          <span>הזמנה <span className="ltr-num">{row.reservationNumber}</span></span>
                          <span className="ltr-num">{row.time ?? "—"}</span>
                          <span className="ltr-num">{row.contact}</span>
                        </p>
                        {row.reason && <p className="gc-pv-reason">{row.reason}</p>}
                        {row.message && (
                          <button type="button" className="btn btn-secondary gc-pv-msgbtn"
                            aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                            <Icon name="eye" size={17} /> {open === key ? "הסתרת ההודעה" : "תצוגת ההודעה"}
                          </button>
                        )}
                        {open === key && <MessagePreview row={row} />}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
