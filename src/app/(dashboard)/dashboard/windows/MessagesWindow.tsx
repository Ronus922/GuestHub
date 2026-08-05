"use client";

import { useState } from "react";
import { Icon } from "@/components/shared/Icon";
import type { ConversationRow, MessagesSummary } from "../data";
import { WindowHero } from "./WindowHero";
import { initialsOf } from "./row-text";

// ============================================================
// msg — הודעות אורחים, v2 (design-ref/DeshbordMain §5.5), read-only.
//
// HERO FIRST: how many threads wait for a human, how fast replies actually
// went out this week, today's traffic, and the green "N נשלחו אוטומטית" chip
// (omitted at zero). Then the latest three threads — a glance surface, not
// the inbox: no reply input, no mark-as-read, no link out, because the thread
// screen does not exist yet and a control that cannot act is a lie in a
// button's clothes.
//
// COLLAPSED BY DEFAULT. Every message clamps to ONE line — a long automated
// Booking.com welcome must not swallow the window. A message over
// LONG_MESSAGE_CHARS gets a chevron that opens/closes THAT row only (the data
// already carries the full body; expansion is presentation, not a fetch).
// Short messages get no chevron at all. The toggle stops the event cold so a
// future row-level link cannot claim the click.
//
// "ממתינות למענה" is what the stamps can honestly claim — the thread's newest
// message is inbound, nothing was sent after it. NOT a read receipt; neither
// wire carries one. The row's time chip wears amber for exactly those threads.
//
// The channel label is the GUEST's surface, not the transport: a Beds24-borne
// thread is a Booking.com conversation to the operator reading it.
// ============================================================

const CHANNEL_LABEL: Record<ConversationRow["channel"], string> = {
  beds24: "Booking.com",
  whatsapp: "וואטסאפ",
};

/** below this a message is one honest line anyway — no chevron for it */
const LONG_MESSAGE_CHARS = 70;

export function MessagesWindow({
  summary,
  rows,
}: {
  summary: MessagesSummary;
  rows: ConversationRow[];
}) {
  // keyed by conversation id — opening one row must not open the others
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }));

  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין שיחות אחרונות</span>
      </div>
    );
  }
  return (
    <>
      <WindowHero
        value={String(summary.unansweredCount)}
        headline="ממתינות למענה"
        subline={
          <>
            {summary.avgFirstReplyMinutes !== null && (
              <>
                זמן מענה ממוצע <span className="ltr-num">{summary.avgFirstReplyMinutes}</span>{" "}
                דק׳ ·{" "}
              </>
            )}
            <span className="ltr-num">{summary.messagesToday}</span> הודעות היום
          </>
        }
        chip={
          summary.autoSentToday > 0 ? (
            <span className="chip chip-partial">
              <Icon name="smart-toy" size={13.5} />
              <span className="ltr-num">{summary.autoSentToday}</span> נשלחו אוטומטית
            </span>
          ) : undefined
        }
      />
      {rows.map((r) => {
        const long = (r.lastMessageBody?.length ?? 0) > LONG_MESSAGE_CHARS;
        const open = long && Boolean(expanded[r.conversationId]);
        return (
          <div className={`win-row${open ? "" : " mid"}`} key={r.conversationId}>
            <span className="guest-avatar">{initialsOf(r.guestName)}</span>
            <div className="win-row-body">
              <div className="win-row-name">
                {r.guestName}
                <span className="win-row-sub">
                  · {CHANNEL_LABEL[r.channel]}
                  {r.roomNumber && ` · חדר ${r.roomNumber}`}
                </span>
              </div>
              {r.lastMessageBody && (
                <p className={`win-row-text mut${open ? "" : " clamp"}`} dir="auto">
                  {r.lastMessageBody}
                </p>
              )}
            </div>
            {r.timeChip && (
              <span className={`chip ${r.hasUnreadInbound ? "chip-approval" : "chip-neutral"}`}>
                {/^\d/.test(r.timeChip) ? (
                  <span className="ltr-num">{r.timeChip}</span>
                ) : (
                  r.timeChip
                )}
              </span>
            )}
            {long && (
              <button
                type="button"
                className="icon-btn"
                title={open ? "כיווץ ההודעה" : "הצגת ההודעה המלאה"}
                aria-label={open ? "כיווץ ההודעה" : "הצגת ההודעה המלאה"}
                aria-expanded={open}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  toggle(r.conversationId);
                }}
              >
                <Icon name={open ? "chevron-up" : "chevron"} size={20} />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
