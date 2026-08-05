"use client";

import { GuestRow } from "@/components/shared/GuestRow";
import { formatDayMonth } from "@/lib/dates";
import type { ConversationRow } from "../data";
import { initialsOf } from "./row-text";

// ============================================================
// msg — הודעות אורחים (DeshbordMain.md §5.5), read-only.
//
// SIX ROWS, NEWEST FIRST — a glance surface, not the inbox. No reply input, no
// mark-as-read, no link out: the thread view is a later task, and a control
// that cannot act yet would be a lie in a button's clothes.
//
// "טרם נענתה" is what the stamps can honestly claim — the thread's newest
// message is inbound, nothing was sent after it. It is NOT a read receipt;
// neither wire carries one.
// ============================================================

const CHANNEL_LABEL: Record<ConversationRow["channel"], string> = {
  beds24: "Beds24",
  whatsapp: "WhatsApp",
};

export function MessagesWindow({ rows }: { rows: ConversationRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="empty-state empty-sm">
        <span className="empty-t">אין שיחות אחרונות</span>
      </div>
    );
  }
  return (
    <>
      {rows.map((r) => (
        <GuestRow
          key={r.conversationId}
          initials={initialsOf(r.guestName)}
          name={r.guestName}
          subline={subline(r)}
          trailing={
            r.hasUnreadInbound ? <span className="chip chip-brand">טרם נענתה</span> : undefined
          }
        />
      ))}
    </>
  );
}

/** "Beds24 · 4/8 14:32 · נכנסת · תודה רבה" — only the parts that exist. */
function subline(r: ConversationRow): React.ReactNode {
  const when = r.lastMessageAt
    ? `${formatDayMonth(r.lastMessageAt.slice(0, 10))} ${r.lastMessageAt.slice(11)}`
    : null;
  return (
    <>
      {CHANNEL_LABEL[r.channel]}
      {when && (
        <>
          {" · "}
          {/* the date-time is one LTR cluster; bare in the RTL line its two
              number runs swap places (time before date) */}
          <span className="ltr-num">{when}</span>
        </>
      )}
      {r.lastMessageDirection && ` · ${r.lastMessageDirection === "inbound" ? "נכנסת" : "יוצאת"}`}
      {r.lastMessageBody && ` · ${r.lastMessageBody}`}
    </>
  );
}
