"use client";

// ============================================================
// מסך הצלחה (wizard MD ש'127) — the panel body after a reservation is created.
//
// It fills the whole drawer body and centres in it (the block used to sit at a
// fixed 320px min-height, i.e. pinned to the top of a very tall body), the ✓
// draws itself inside a popping circle, and a one-shot confetti burst fires
// from behind the mark.
//
// The burst is deterministic on purpose: pieces are derived from their index
// through a fixed hash, never Math.random(). Random values would differ between
// the server and the client render and would make the celebration untestable.
// Every colour is a §1 token — nothing here is invented.
//
// prefers-reduced-motion: the confetti layer is dropped and every animation is
// cancelled in its final state (see booking-window.css) — the screen is fully
// legible without a single moving pixel.
// ============================================================

// index → [0,1). Stable across renders, machines and reloads.
const hash = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const between = (i: number, salt: number, min: number, max: number) => min + hash(i, salt) * (max - min);

const CONFETTI_COLORS = ["var(--brand)", "var(--ok)", "var(--warn)", "var(--info)", "var(--vip)", "var(--danger)"];
const PIECE_COUNT = 48;

// Each piece flies out of the centre on its own angle, peaks, then falls —
// hence a mid-point (mx/my) and an end-point (dx/dy) rather than one vector.
const PIECES = Array.from({ length: PIECE_COUNT }, (_, i) => {
  const angle = (i / PIECE_COUNT) * Math.PI * 2 + between(i, 1, -0.12, 0.12);
  const reach = between(i, 2, 150, 400);
  const round = i % 3 === 0;
  const w = between(i, 7, 7, 12);
  return {
    mx: `${Math.round(Math.cos(angle) * reach * 0.62)}px`,
    my: `${Math.round(-Math.abs(Math.sin(angle)) * reach * 0.55 - 40)}px`,
    dx: `${Math.round(Math.cos(angle) * reach * 1.4)}px`,
    dy: `${Math.round(between(i, 3, 300, 620))}px`,
    rot: `${Math.round(between(i, 4, 200, 900))}deg`,
    delay: `${between(i, 5, 0, 0.22).toFixed(2)}s`,
    duration: `${between(i, 6, 1.5, 2.4).toFixed(2)}s`,
    w: `${w.toFixed(1)}px`,
    h: `${(round ? w : w * between(i, 8, 1.2, 1.9)).toFixed(1)}px`,
    radius: round ? "50%" : "2px",
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  };
});

export type BookingCreated = {
  number: number | string;
  guest: string;
  rooms: number;
  total: number;
  paid: number;
  balance: number;
};

export function BookingSuccess({ created }: { created: BookingCreated }) {
  return (
    <div className="bw-success" role="status" aria-live="polite">
      <div className="bw-success-confetti" aria-hidden="true">
        {PIECES.map((p, i) => (
          <span
            key={i}
            className="bw-confetti-p"
            style={
              {
                "--mx": p.mx,
                "--my": p.my,
                "--dx": p.dx,
                "--dy": p.dy,
                "--rot": p.rot,
                "--d": p.delay,
                "--t": p.duration,
                "--w": p.w,
                "--h": p.h,
                "--r": p.radius,
                "--c": p.color,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      <span className="bw-success-ic">
        {/* drawn, not a glyph: the stroke animates from 0 to full length */}
        <svg className="bw-success-check" viewBox="0 0 52 52" aria-hidden="true">
          <path
            d="M14 27.5 22.5 36 38.5 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <p className="bw-success-t">ההזמנה נוצרה בהצלחה</p>
      <p className="bw-success-n ltr-num">הזמנה #{created.number}</p>
      <p className="bw-success-s">
        {created.guest || "אורח"} · {created.rooms === 1 ? "חדר אחד" : `${created.rooms} חדרים`} · סה״כ ₪
        <bdi className="ltr-num">{created.total.toLocaleString()}</bdi> · שולם ₪
        <bdi className="ltr-num">{created.paid.toLocaleString()}</bdi> · יתרה ₪
        <bdi className="ltr-num">{Math.max(0, created.balance).toLocaleString()}</bdi>
      </p>
    </div>
  );
}
