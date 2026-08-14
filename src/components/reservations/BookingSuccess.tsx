"use client";

// ============================================================
// מסך הצלחה — the panel body after a reservation is created.
//
// Replaces the whole wizard body (stepper, columns and all): the mark is the
// supplied asset (public/success-animation.gif — its NETSCAPE2.0 loop
// extension was stripped in the repo copy, so it plays exactly once and
// settles on the finished ✓), over a soft radial halo, above the title, the
// reservation-number chip and the one-line summary.
//
// The confetti layer is 11 fixed pieces raining once from the top edge —
// positions, colours and delays live in booking-success.css (nth-child), so
// the markup is just empty <i> elements. The layer sits BEHIND the text
// (z-index) and is dropped entirely under prefers-reduced-motion.
// ============================================================

import { useState } from "react";

const CONFETTI_COUNT = 11;

export type BookingCreated = {
  number: number | string;
  guest: string;
  rooms: number;
  total: number;
  paid: number;
  balance: number;
};

export function BookingSuccess({ created }: { created: BookingCreated }) {
  // a fresh query string per mount restarts the one-shot GIF when a second
  // reservation is confirmed in the same session (the browser would otherwise
  // serve the cached, already-finished animation)
  const [gifSrc] = useState(() => `/success-animation.gif?t=${Date.now()}`);

  return (
    <div className="bw-success" role="status" aria-live="polite">
      <div className="bw-success-cf" aria-hidden="true">
        {Array.from({ length: CONFETTI_COUNT }, (_, i) => (
          <i key={i} />
        ))}
      </div>

      {/* the GIF is green on a transparent background and draws its own ✓ —
          nothing of ours behind it except the soft halo.
          eslint-disable: next/image would re-encode the animation to a still. */}
      <div className="bw-success-ic">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={gifSrc} alt="" />
      </div>

      <h2 className="bw-success-t">ההזמנה נוצרה בהצלחה</h2>

      {/* the NUMBER alone is LTR — the word stays in the RTL flow */}
      <span className="bw-success-chip">
        הזמנה <b className="ltr-num">#{created.number}</b>
      </span>

      <p className="bw-success-s">
        {created.guest || "אורח"} · {created.rooms === 1 ? "חדר אחד" : `${created.rooms} חדרים`} · סה״כ ₪
        <bdi className="ltr-num">{created.total.toLocaleString()}</bdi> · שולם ₪
        <bdi className="ltr-num">{created.paid.toLocaleString()}</bdi> · יתרה ₪
        <bdi className="ltr-num">{Math.max(0, created.balance).toLocaleString()}</bdi>
      </p>
    </div>
  );
}
