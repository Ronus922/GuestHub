"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { todayInTz } from "@/lib/dates";
import { CHECK_IN_CHECK_OUT_TIMEZONE } from "@/lib/check-in-check-out-policy";
import { usePermission } from "@/components/providers/TenantProvider";
import {
  windowRejection,
  isBookingComOtaName,
  BOOKING_REPORT_WINDOW_TEXT,
  type BookingReportAction,
} from "@/lib/channel/booking-com-report-rules";
import {
  reportInvalidCard,
  cancelDueInvalidCard,
  reportNoShow,
} from "@/lib/channel/booking-com-reports";
import { BookingCard } from "./BookingPanel";
import type { ReservationDetail } from "@/app/(dashboard)/reservations/actions";

// ============================================================
// פעולות Booking.com (D96) — the operator's three status reports to the channel,
// as an inline action group on the booking, plus the RTL confirmation overlay.
//
// WHERE IT LIVES, AND WHY NOT THE HEADER TOOLBAR. The SidePanel toolbar
// (BookingActions.tsx) is icon-only with a <480px overflow menu; three more
// icons there would be three unlabelled glyphs for three IRREVERSIBLE channel
// requests. These actions need their consequence, their window and their
// current state visible before the click, so the group is a BookingCard in the
// booking body — same registration idea (one typed array rendered once), and it
// carries the state chips the toolbar cannot.
//
// VISIBILITY: the whole card is absent unless the booking really came from
// Booking.com AND carries a Beds24 booking id. Nothing here is ever shown
// "greyed out because there is no channel" — an inapplicable action is absent,
// not disabled.
//
// DISABLING vs HIDING: an action whose WINDOW is closed (or whose prerequisite
// is missing) stays visible and disabled, with the reason in the tooltip — the
// operator must be able to see that "דיווח No-Show" exists and learn why today
// is too late. The same windowRejection() the server runs produces the reason,
// so a tooltip can never promise something the server will refuse.
//
// The server re-checks everything (session, permission, tenant, source, window,
// prerequisite) — usePermission and the disabled attribute are UI convenience.
// ============================================================

type ActionSpec = {
  action: BookingReportAction;
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  danger?: boolean;
  /** non-null = disabled, and this is the Hebrew reason shown in the tooltip */
  blocked: string | null;
  /** the successful report's timestamp, when one exists */
  reportedAt: string | null;
};

const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(
        d.getHours(),
      ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Is this booking eligible for the group at all? */
export function hasBookingComReports(detail: ReservationDetail): boolean {
  return (
    detail.ota !== null &&
    !!detail.ota.externalBookingId &&
    isBookingComOtaName(detail.ota.otaName)
  );
}

function buildActions(detail: ReservationDetail): ActionSpec[] {
  const ota = detail.ota;
  // property-local today: the windows turn over at the PROPERTY's midnight, not
  // the browser's. CHECK_IN_CHECK_OUT_TIMEZONE is the app's canonical property
  // clock; the server re-derives it from tenants.timezone.
  const today = todayInTz(CHECK_IN_CHECK_OUT_TIMEZONE);
  const checkIn = detail.rooms[0]?.checkIn ?? today;
  const cancelled = detail.status === "cancelled";
  const cancelledReason = "ההזמנה כבר מבוטלת — אין מה לדווח לערוץ";
  const invalidCardAt = ota?.invalidCardReportedAt ?? null;

  return [
    {
      action: "invalid_card",
      label: "דיווח כרטיס לא תקין",
      icon: "credit-card",
      blocked:
        (cancelled ? cancelledReason : null) ??
        windowRejection({ action: "invalid_card", today, checkIn }),
      reportedAt: invalidCardAt,
    },
    {
      action: "cancel_due_invalid_card",
      label: "ביטול עקב כרטיס לא תקין",
      icon: "circle-slash",
      danger: true,
      // the prerequisite, mirrored from the server's ledger rule
      blocked:
        (cancelled ? cancelledReason : null) ??
        (invalidCardAt
          ? null
          : "יש לדווח קודם על כרטיס לא תקין — ואז אפשר לבקש ביטול"),
      reportedAt: ota?.externalCancellationRequestedAt ?? null,
    },
    {
      action: "no_show",
      label: "דיווח No-Show",
      icon: "employees",
      blocked:
        (cancelled ? cancelledReason : null) ??
        windowRejection({ action: "no_show", today, checkIn }),
      reportedAt: ota?.noShowReportedAt ?? null,
    },
  ];
}

/**
 * The inline action group. Renders nothing when the booking is not an eligible
 * Booking.com booking, or when the operator lacks reservations.channel_report.
 */
export function BookingComReportsCard({
  detail,
  onOpen,
}: {
  detail: ReservationDetail;
  /** hands the chosen action up to the panel, which shows it as an overlay */
  onOpen: (action: BookingReportAction) => void;
}) {
  const allowed = usePermission("reservations.channel_report");
  if (!hasBookingComReports(detail) || !allowed) return null;
  const actions = buildActions(detail);
  const latest = actions
    .filter((a) => a.reportedAt)
    .sort((a, b) => (a.reportedAt! < b.reportedAt! ? 1 : -1))[0];

  return (
    <BookingCard
      icon="channels"
      title="פעולות Booking.com"
      chip={
        latest ? (
          <span className="chip chip-approval">
            <Icon name="check" size={13.5} />
            {latest.label} · {fmtDateTime(latest.reportedAt!)}
          </span>
        ) : undefined
      }
    >
      <p className="mb-3 text-sm leading-relaxed text-muted">
        דיווחי מצב ל-Booking.com דרך Beds24. כל דיווח נשלח לערוץ ואינו ניתן לביטול — הוא נרשם
        ביומן הדיווחים של ההזמנה עם שם המדווח והמועד.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {actions.map((a) => (
          <button
            key={a.action}
            type="button"
            className={`btn ${a.danger ? "btn-danger" : "btn-secondary"}`}
            disabled={a.blocked !== null}
            title={a.blocked ?? `${a.label} — ${BOOKING_REPORT_WINDOW_TEXT[a.action]}`}
            aria-label={a.blocked ? `${a.label} — לא זמין: ${a.blocked}` : a.label}
            onClick={() => onOpen(a.action)}
          >
            <Icon name={a.icon} size={20} />
            {a.label}
          </button>
        ))}
      </div>
      {/* every reason a button is off, in text — a tooltip is not reachable on touch */}
      {actions.some((a) => a.blocked) && (
        <ul className="mt-3 flex flex-col gap-1">
          {actions
            .filter((a) => a.blocked)
            .map((a) => (
              <li key={a.action} className="text-sm text-muted">
                <b className="text-ink">{a.label}:</b> {a.blocked}
              </li>
            ))}
        </ul>
      )}
    </BookingCard>
  );
}

const TITLE: Record<BookingReportAction, string> = {
  invalid_card: "דיווח כרטיס לא תקין ל-Booking.com",
  cancel_due_invalid_card: "ביטול ההזמנה עקב כרטיס לא תקין",
  no_show: "דיווח אי-הגעה (No-Show) ל-Booking.com",
};

const CONFIRM_LABEL: Record<BookingReportAction, string> = {
  invalid_card: "שליחת הדיווח",
  cancel_due_invalid_card: "שליחת בקשת הביטול",
  no_show: "שליחת דיווח אי-הגעה",
};

/**
 * The RTL confirmation overlay — one action at a time, in the SidePanel
 * `overlay` slot (the booking stays mounted underneath), same bk-cmp shell as
 * the message composer and the cancellation dialog.
 */
export function BookingComReportDialog({
  detail,
  guestName,
  action,
  onClose,
  onDone,
}: {
  detail: ReservationDetail;
  guestName: string;
  action: BookingReportAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const [waived, setWaived] = useState(false);
  const [busy, startBusy] = useTransition();
  const submittedRef = useRef(false); // double-submit protection
  const danger = action === "cancel_due_invalid_card";

  const submit = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    startBusy(async () => {
      const res =
        action === "invalid_card"
          ? await reportInvalidCard(detail.id)
          : action === "cancel_due_invalid_card"
            ? await cancelDueInvalidCard(detail.id)
            : await reportNoShow(detail.id, waived);
      if (res.success) {
        toast.success(
          action === "cancel_due_invalid_card"
            ? "בקשת הביטול נשלחה ל-Booking.com — ההזמנה תבוטל כשהערוץ יאשר"
            : "הדיווח נשלח ל-Booking.com",
        );
        onDone();
      } else {
        submittedRef.current = false;
        toast.error(res.error);
      }
    });
  };

  return (
    <div className="bk-cmp" role="dialog" aria-label={TITLE[action]}>
      <header className={`bk-cmp-h${danger ? " danger" : ""}`}>
        <button type="button" className="bk-cmp-back" onClick={onClose} aria-label="חזרה להזמנה">
          <Icon name="chevron-right" size={20} />
        </button>
        <span className="bk-cmp-icon">
          <Icon name={danger ? "circle-slash" : "channels"} size={20} />
        </span>
        <div className="min-w-0">
          <p className="h2 truncate">{TITLE[action]}</p>
          <p className="truncate text-sm font-semibold text-white/80">
            <bdi className="ltr-num">#{detail.reservation_number}</bdi> · {guestName}
          </p>
        </div>
      </header>

      <div className="bk-cmp-body thin-scroll">
        <section className="card">
          <div className="card-bd bw-grid2">
            <Fact label="מס׳ הזמנה ב-GuestHub" value={`#${detail.reservation_number}`} ltr />
            <Fact
              label="קוד הזמנה ב-Booking.com"
              value={detail.ota?.otaReservationCode ?? "—"}
              ltr
            />
            <Fact label="אורח" value={guestName} />
            <Fact
              label="תאריך צ'ק-אין"
              value={detail.rooms[0]?.checkIn ?? "—"}
              ltr
            />
          </div>
        </section>

        <section className={`card${danger ? " bw-card-danger" : " bw-card-warn"}`}>
          <div className="card-bd">
            <p className="text-sm font-bold leading-relaxed text-ink">{CONSEQUENCE[action]}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {BOOKING_REPORT_WINDOW_TEXT[action]} התשובה של Booking.com היא הקובעת — אם היא תדחה
              את הדיווח, תוצג השגיאה שלה ולא ייקבע דבר במערכת.
            </p>
          </div>
        </section>

        {action === "no_show" && (
          <section className="card">
            <div className="card-bd">
              {/* THE CONTRACT GAP, stated plainly (D96): POST /channels/booking
                  accepts bookingId + action ONLY. There is no fee-waiver field
                  in apiV2.yaml, so this toggle is a LOCAL record and the label
                  must never imply otherwise. */}
              <label className="flex cursor-pointer items-start gap-3 p-1">
                <input
                  type="checkbox"
                  className="mt-1 size-5 shrink-0"
                  checked={waived}
                  onChange={(e) => setWaived(e.target.checked)}
                />
                <span className="min-w-0">
                  <b className="text-sm text-ink">
                    רישום פנימי: ויתור על דמי אי-הגעה
                  </b>
                  <span className="mt-1 block text-sm leading-relaxed text-muted">
                    רישום מקומי בלבד — הסימון הזה <b className="text-ink">אינו נשלח</b> ל-Booking.com.
                    ממשק הדיווח מקבל מזהה הזמנה ופעולה בלבד. ויתור בפועל על דמי אי-הגעה יש לבצע
                    ישירות בממשק Booking.com; כאן הוא נשמר כדי שגביית החוב תדע שלא לגבות.
                  </span>
                </span>
              </label>
            </div>
          </section>
        )}

        <section className="card card-bd">
          {/* §7 — RTL: the last child sits at the left edge */}
          <div className="flex items-center gap-3">
            <span className="flex-1" />
            <button type="button" className="btn btn-tertiary" onClick={onClose}>
              חזרה
            </button>
            <button
              type="button"
              className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
              disabled={busy}
              onClick={submit}
            >
              <Icon name={danger ? "circle-slash" : "send"} size={20} />
              {busy ? "שולח…" : CONFIRM_LABEL[action]}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

const CONSEQUENCE: Record<BookingReportAction, string> = {
  invalid_card:
    "Booking.com תקבל דיווח שהכרטיס של ההזמנה אינו תקין, תפנה לאורח ותבקש ממנו כרטיס חלופי. הדיווח אינו ניתן לביטול. ההזמנה נשארת פעילה והחדר נשאר תפוס.",
  cancel_due_invalid_card:
    "פעולה בלתי הפיכה. נשלחת בקשה ל-Booking.com לבטל את ההזמנה בגלל כרטיס לא תקין. הבקשה מותרת רק לאחר דיווח מוצלח על כרטיס לא תקין, ו-Booking.com תבטל רק אם האורח לא עדכן כרטיס חלופי ושאר התנאים שלה מתקיימים. ההזמנה אינה מתבטלת כאן ועכשיו: היא תסומן כמבוטלת והחדר ישוחרר רק כשהביטול יחזור מהערוץ.",
  no_show:
    "Booking.com תקבל דיווח שהאורח לא הגיע. הדיווח אינו ניתן לביטול ומשפיע על העמלה ועל ההתחשבנות מול הערוץ. סטטוס ההזמנה במערכת אינו משתנה כאן.",
};

function Fact({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <b className={`text-sm text-ink${ltr ? " ltr-num text-end" : ""}`}>{value}</b>
    </div>
  );
}
