"use client";

import { Icon } from "@/components/shared/Icon";
import type { ConversationRow, MessagesSummary } from "../data";
import { WindowHero } from "./WindowHero";
import { initialsOf } from "./row-text";

// ============================================================
// msg — הודעות אורחים, v2 (design-ref/DeshbordMain §5.5), read-only.
//
// HERO FIRST: how many threads wait for a human, how fast replies actually
// went out this week, today's traffic, and the green "N נשלחו אוטומטית" chip
// (omitted at zero). Then the latest three threads, each with its newest
// message WHOLE — a glance surface, not the inbox: no reply input, no
// mark-as-read, no link out, because the thread screen does not exist yet and
// a control that cannot act is a lie in a button's clothes.
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

export function MessagesWindow({
  summary,
  rows,
}: {
  summary: MessagesSummary;
  rows: ConversationRow[];
}) {
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
      {rows.map((r) => (
        <div className="win-row" key={r.conversationId}>
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
              <p className="win-row-text" dir="auto">
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
        </div>
      ))}
    </>
  );
}
