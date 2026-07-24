"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/shared/Icon";
import { formatFullDate } from "@/lib/dates";
import { INVENTORY_BLOCKING_STATUSES } from "@/lib/inventory-rules";
import {
  cancelReservationAction,
  releaseChannelReservationAction,
  type ReservationDetail,
} from "@/app/(dashboard)/reservations/actions";

// ============================================================
// ביטול הזמנה — the ONE cancellation dialog (D77 §9), opened from the
// SidePanel toolbar/footer as a full-panel overlay (booking stays mounted,
// same bk-cmp shell as the message composer).
//
// Provider-aware honesty:
//  · direct/manual booking  → local cancel with a REQUIRED reason; history,
//    payments and audit are preserved; inventory releases in the same tx.
//  · ACTIVE OTA booking     → generic local cancel is impossible (server
//    guard). The dialog says so honestly: the cancellation must be made at the
//    OTA and arrives back through the channel as a real cancelled revision.
//    (Channel-side OTA reporting was removed with the previous provider — D91.)
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
  /** called after a successful local cancel */
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, startBusy] = useTransition();
  const submittedRef = useRef(false); // double-submit protection (§9)

  const activeOta = detail.ota !== null && isBlocking(detail.status);

  // supervised escape hatch: allowed ONLY when Beds24 confirms the booking is
  // cancelled at source — the server re-verifies live before enqueueing the
  // canonical targeted pull. Never a blind local flip.
  const doChannelRelease = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    startBusy(async () => {
      const res = await releaseChannelReservationAction(detail.id);
      if (res.success) {
        toast.success("הביטול אושר במקור — ההזמנה משתחררת דרך מסלול הביטול הקנוני");
        onDone();
      } else {
        submittedRef.current = false;
        toast.error(res.error);
      }
    });
  };

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
      <header className="bk-cmp-h danger">
        <button type="button" className="bk-cmp-back" onClick={onClose} aria-label="חזרה להזמנה">
          <Icon name="chevron-right" size={20} />
        </button>
        <span className="bk-cmp-icon">
          <Icon name="circle-slash" size={20} />
        </span>
        <div className="min-w-0">
          <p className="h2 truncate">ביטול הזמנה</p>
          <p className="truncate text-sm font-semibold text-white/80">
            <bdi className="ltr-num">#{detail.reservation_number}</bdi> · {guestName}
          </p>
        </div>
      </header>

      <div className="bk-cmp-body thin-scroll">
        {/* booking facts — what exactly is being cancelled */}
        <section className="card">
          <div className="card-bd bw-grid2">
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
              <div className="field">
                <span className="field-label">קוד הזמנה בערוץ</span>
                <span className="flex items-center gap-2">
                  <b className="ltr-num text-sm text-ink">{detail.ota.otaReservationCode}</b>
                  <button
                    type="button"
                    className="icon-btn"
                    title="העתקת קוד"
                    onClick={copyOtaCode}
                  >
                    <Icon name="copy" size={20} label="העתקת קוד ההזמנה" />
                  </button>
                </span>
              </div>
            )}
          </div>
        </section>

        {pendingExternal && (
          <section className="card bw-card-warn">
            <p className="card-bd text-sm font-bold text-ink">
              נשלחה בקשת ביטול לערוץ — ההזמנה תבוטל אוטומטית כשהערוץ יאשר. החדרים לא שוחררו עדיין.
            </p>
          </section>
        )}

        {activeOta ? (
          /* honest generic-cancel message (§9): an OTA booking is cancelled at
             the OTA and arrives back as a cancelled revision through Beds24. */
          <>
            <section className="card bw-card-danger">
              <p className="card-bd text-sm font-bold leading-relaxed text-ink">
                לא ניתן לבטל הזמנת {detail.ota?.otaName === "BookingCom" ? "Booking.com" : "ערוץ"}{" "}
                באופן כללי דרך מנהל הערוצים.
                <br />
                יש לבצע את הביטול ב-Booking.com ולהמתין לעדכון האוטומטי — ההזמנה תבוטל, תוסר
                מהיומן ותישמר בהיסטוריה ברגע שהערוץ ישדר את הביטול.
              </p>
            </section>
            {/* supervised escape hatch: if the guest already cancelled at the
                OTA and the update has not landed yet, the operator can verify
                against Beds24 and release NOW — the server allows it only when
                the source really reports cancelled, with a full audit. */}
            <section className="card card-bd">
              <p className="mb-3 text-sm font-bold leading-relaxed text-ink">
                ההזמנה כבר בוטלה ב-Booking.com והחדר עדיין תפוס? בדיקה חיה מול Beds24 —
                אם המקור מאשר שההזמנה מבוטלת, החדר ישוחרר מיידית דרך מסלול הביטול המלא
                (היסטוריה, מלאי ועדכון ערוצים). אם ההזמנה עדיין פעילה במקור — לא ישתנה דבר.
              </p>
              <div className="flex items-center gap-3">
                <span className="flex-1" />
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={doChannelRelease}
                >
                  <Icon name="refresh" size={20} />
                  {busy ? "בודק מול Beds24…" : "בדיקה מול Beds24 ושחרור"}
                </button>
              </div>
            </section>
          </>
        ) : (
          <section className="card card-bd">
            <p className="mb-3 text-sm font-bold leading-relaxed text-ink">
              ההזמנה תבוטל ותוסר מיומן התפוסה, והחדרים ישוחררו למכירה מיידית בכל הערוצים.
              ההזמנה, התשלומים וההיסטוריה יישמרו לצפייה תחת ״בוטלו״. לא יבוצע החזר כספי אוטומטי.
            </p>
            <label className="field">
              <span className="field-label">
                סיבת ביטול <span className="bw-req">*</span>
              </span>
              <textarea
                className="field-input"
                rows={3}
                value={reason}
                placeholder="למשל: ביטול לבקשת האורח / כפילות / טעות הזנה…"
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {/* §7 — RTL: the last child sits at the left edge */}
            <div className="mt-4 flex items-center gap-3">
              <span className="flex-1" />
              <button type="button" className="btn btn-tertiary" onClick={onClose}>
                חזרה
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || reason.trim().length === 0}
                onClick={doLocalCancel}
              >
                <Icon name="circle-slash" size={20} />
                {busy ? "מבטל…" : "אישור ביטול ההזמנה"}
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
    <div className="field">
      <span className="field-label">{label}</span>
      <b className={`text-sm text-ink${ltr ? " ltr-num text-end" : ""}`}>{value}</b>
    </div>
  );
}
