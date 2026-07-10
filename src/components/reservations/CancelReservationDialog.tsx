"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate } from "@/lib/dates";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import {
  cancelReservationAction,
  type ReservationDetail,
} from "@/app/(dashboard)/reservations/actions";
import {
  cancelDueInvalidCardAction,
  getOtaActionsContextAction,
  reportInvalidCardAction,
  reportNoShowAction,
  type OtaActionsContext,
} from "@/lib/channel/reporting-admin";

// ============================================================
// ביטול הזמנה — the ONE cancellation dialog (D77 §9), opened from the
// SidePanel toolbar/footer as a full-panel overlay (booking stays mounted,
// same bk-cmp shell as the message composer).
//
// Provider-aware honesty:
//  · direct/manual booking  → local cancel with a REQUIRED reason; history,
//    payments and audit are preserved; inventory releases in the same tx.
//  · ACTIVE OTA booking     → generic local cancel is impossible (server
//    guard). The dialog says so honestly and offers ONLY the provider
//    operations that are genuinely eligible right now (Booking.com Reporting:
//    invalid card / cancel-due-invalid-card / no-show). A provider "cancel"
//    never cancels locally — the real cancelled revision does.
// ============================================================

const isBlocking = (s: string) =>
  (INVENTORY_BLOCKING_STATUSES as readonly string[]).includes(s);

export function CancelReservationDialog({
  detail,
  guestName,
  onClose,
  onDone,
}: {
  detail: ReservationDetail;
  guestName: string;
  onClose: () => void;
  /** called after any state-changing success (local cancel / provider report) */
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, startBusy] = useTransition();
  const submittedRef = useRef(false); // double-submit protection (§9)
  const [ota, setOta] = useState<OtaActionsContext | null>(null);
  const [otaError, setOtaError] = useState<string | null>(null);
  const [waivedFees, setWaivedFees] = useState(true);

  const activeOta = detail.ota !== null && isBlocking(detail.status);

  useEffect(() => {
    if (!detail.ota) return;
    getOtaActionsContextAction(detail.id).then((res) => {
      if (res.success && res.data) setOta(res.data);
      else setOtaError(res.success ? null : res.error);
    });
  }, [detail.id, detail.ota]);

  const doLocalCancel = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    startBusy(async () => {
      const res = await cancelReservationAction(detail.id, { reason: reason.trim() });
      if (res.success) {
        toast.success("ההזמנה בוטלה — נשמרה בהיסטוריה והחדרים שוחררו");
        onDone();
      } else {
        submittedRef.current = false;
        toast.error(res.error);
      }
    });
  };

  const runProvider = (
    fn: () => Promise<{ success: boolean; error?: string }>,
    successMsg: string,
  ) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    startBusy(async () => {
      const res = await fn();
      submittedRef.current = false;
      if (res.success) {
        toast.success(successMsg);
        // refresh eligibility (stamps changed) + parent detail
        const ctx = await getOtaActionsContextAction(detail.id);
        if (ctx.success && ctx.data) setOta(ctx.data);
        onDone();
      } else {
        toast.error(res.error ?? "הפעולה נכשלה");
      }
    });
  };

  const copyOtaCode = () => {
    if (!detail.ota?.otaReservationCode) return;
    navigator.clipboard
      .writeText(detail.ota.otaReservationCode)
      .then(() => toast.success("קוד ההזמנה הועתק"));
  };

  const pendingExternal =
    detail.ota?.externalCancellationRequestedAt != null && detail.status !== "cancelled";

  return (
    <div className="bk-cmp" role="dialog" aria-label="ביטול הזמנה">
      <header className="bk-cmp-h" style={{ background: "var(--color-status-danger)" }}>
        <button type="button" className="bk-cmp-back" onClick={onClose} aria-label="חזרה להזמנה">
          <Icon name="chevron-right" size={18} />
        </button>
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/15">
          <Icon name="circle-slash" size={18} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-base font-bold">ביטול הזמנה</p>
          <p className="truncate text-xs text-white/80">
            #{detail.reservation_number} · {guestName}
          </p>
        </div>
      </header>

      <div className="bk-cmp-body thin-scroll">
        {/* booking facts — what exactly is being cancelled */}
        <section className="bw-card">
          <div className="bw-grid2">
            <FactRow label="מס׳ הזמנה" value={`#${detail.reservation_number}`} ltr />
            <FactRow label="אורח" value={guestName} />
            <FactRow
              label="חדרים"
              value={detail.rooms.map((r) => r.roomLabel).join(", ") || "—"}
            />
            <FactRow
              label="תאריכים"
              value={
                detail.rooms.length > 0
                  ? `${formatFullDate(detail.rooms[0].checkIn)} – ${formatFullDate(
                      detail.rooms[detail.rooms.length - 1].checkOut,
                    )}`
                  : "—"
              }
            />
            <FactRow label="מקור" value={detail.source_label ?? "הזמנה ישירה"} />
            {detail.ota?.otaReservationCode && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold text-muted">קוד הזמנה בערוץ</span>
                <span className="flex items-center gap-2">
                  <b dir="ltr" className="text-sm text-ink">{detail.ota.otaReservationCode}</b>
                  <button
                    type="button"
                    className="bw-btn bw-btn-ghost px-2 py-1"
                    title="העתקת קוד"
                    aria-label="העתקת קוד ההזמנה"
                    onClick={copyOtaCode}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </span>
              </div>
            )}
          </div>
        </section>

        {pendingExternal && (
          <section className="bw-card" style={{ borderColor: "#F1C21B", background: "#FFF9E8" }}>
            <p className="text-sm font-bold text-ink">
              נשלחה בקשת ביטול לערוץ — ההזמנה תבוטל אוטומטית כשהערוץ יאשר. החדרים לא שוחררו עדיין.
            </p>
          </section>
        )}

        {activeOta ? (
          <>
            {/* honest generic-cancel message (§9) */}
            <section className="bw-card" style={{ borderColor: "#E8B4B0", background: "#FDF6F5" }}>
              <p className="text-sm font-bold leading-relaxed text-ink">
                לא ניתן לבטל הזמנת {detail.ota?.otaName === "BookingCom" ? "Booking.com" : "ערוץ"}{" "}
                באופן כללי דרך מנהל הערוצים.
                <br />
                יש לבצע את הביטול ב-Booking.com ולהמתין לעדכון האוטומטי — ההזמנה תבוטל, תוסר
                מהיומן ותישמר בהיסטוריה ברגע שהערוץ ישדר את הביטול.
              </p>
            </section>

            {/* provider actions that ARE genuinely available */}
            {ota?.provider === "booking_com" && (
              <section className="bw-card">
                <h4 className="mb-3 text-sm font-extrabold text-ink">
                  פעולות Booking.com זמינות
                </h4>
                <div className="flex flex-col gap-3">
                  <ProviderAction
                    title="דיווח על כרטיס לא תקין"
                    description="Booking.com יבקש מהאורח לעדכן פרטי כרטיס. ההזמנה אינה מבוטלת."
                    eligible={ota.invalidCard.eligible}
                    blockedReason={ota.invalidCard.reason}
                    busy={busy}
                    onRun={() =>
                      runProvider(
                        () => reportInvalidCardAction({ reservationId: detail.id }),
                        "הדיווח נשלח — Booking.com יבקש כרטיס מעודכן",
                      )
                    }
                  />
                  <ProviderAction
                    title="ביטול עקב כרטיס לא תקין"
                    description="זמין רק לאחר דיווח כרטיס לא תקין וחלון 24 השעות. הביטול המקומי יתבצע רק כשהערוץ יאשר."
                    eligible={ota.cancelDueInvalidCard.eligible}
                    blockedReason={ota.cancelDueInvalidCard.reason}
                    busy={busy}
                    onRun={() =>
                      runProvider(
                        () => cancelDueInvalidCardAction({ reservationId: detail.id }),
                        "בקשת הביטול נשלחה — ממתין לאישור הערוץ",
                      )
                    }
                  />
                  <ProviderAction
                    title="דיווח No-show (האורח לא הגיע)"
                    description="זמין מחצות של יום הצ׳ק-אין ועד 48 שעות. משחרר את הלילות לאחר אישור הספק."
                    eligible={ota.noShow.eligible}
                    blockedReason={ota.noShow.reason}
                    busy={busy}
                    extra={
                      <label className="flex items-center gap-2 text-xs font-semibold text-muted">
                        <input
                          type="checkbox"
                          checked={waivedFees}
                          onChange={(e) => setWaivedFees(e.target.checked)}
                        />
                        ויתור על דמי אי-הגעה (waived fees)
                      </label>
                    }
                    onRun={() =>
                      runProvider(
                        () => reportNoShowAction({ reservationId: detail.id, waivedFees }),
                        "דווח No-show — הלילות שוחררו",
                      )
                    }
                  />
                </div>
              </section>
            )}
            {detail.ota && ota?.provider === null && (
              <section className="bw-card">
                <p className="text-sm font-semibold text-muted">
                  לערוץ זה אין פעולות דיווח נתמכות דרך GuestHub.
                </p>
              </section>
            )}
            {otaError && (
              <section className="bw-card">
                <p className="text-sm font-semibold text-status-danger">{otaError}</p>
              </section>
            )}
          </>
        ) : (
          <section className="bw-card">
            <p className="mb-3 text-sm font-bold leading-relaxed text-ink">
              ההזמנה תבוטל ותוסר מיומן התפוסה, והחדרים ישוחררו למכירה מיידית בכל הערוצים.
              ההזמנה, התשלומים וההיסטוריה יישמרו לצפייה תחת ״בוטלו״. לא יבוצע החזר כספי אוטומטי.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-bold text-muted">
                סיבת ביטול <span className="text-status-danger">*</span>
              </span>
              <textarea
                className="bw-fld"
                rows={3}
                value={reason}
                placeholder="למשל: ביטול לבקשת האורח / כפילות / טעות הזנה…"
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                className="bw-btn"
                style={{ background: "var(--color-status-danger)", color: "#fff" }}
                disabled={busy || reason.trim().length === 0}
                onClick={doLocalCancel}
              >
                <Icon name="circle-slash" size={15} />
                {busy ? "מבטל…" : "אישור ביטול ההזמנה"}
              </button>
              <button type="button" className="bw-btn bw-btn-ghost" onClick={onClose}>
                חזרה
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function FactRow({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-bold text-muted">{label}</span>
      <b className="text-sm text-ink" dir={ltr ? "ltr" : undefined} style={ltr ? { textAlign: "right" } : undefined}>
        {value}
      </b>
    </div>
  );
}

function ProviderAction({
  title,
  description,
  eligible,
  blockedReason,
  busy,
  extra,
  onRun,
}: {
  title: string;
  description: string;
  eligible: boolean;
  blockedReason: string | null;
  busy: boolean;
  extra?: React.ReactNode;
  onRun: () => void;
}) {
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-extrabold text-ink">{title}</p>
          <p className="mt-1 text-xs font-semibold leading-relaxed text-muted">{description}</p>
          {!eligible && blockedReason && (
            <p className="mt-2 flex items-center gap-1 text-xs font-bold text-status-danger">
              <Icon name="warning" size={13} />
              {blockedReason}
            </p>
          )}
          {eligible && extra && <div className="mt-2">{extra}</div>}
        </div>
        <button
          type="button"
          className="bw-btn bw-btn-o shrink-0"
          disabled={!eligible || busy}
          onClick={onRun}
        >
          {busy ? "שולח…" : "ביצוע"}
        </button>
      </div>
    </div>
  );
}
