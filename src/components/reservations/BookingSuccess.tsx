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
const BURST_COUNT = 64;
const RAIN_COUNT = 72;

// BURST — each piece flies out of the mark on its own angle, peaks, then falls,
// hence a mid-point (mx/my) and an end-point (dx/dy) rather than one vector.
const BURST = Array.from({ length: BURST_COUNT }, (_, i) => {
  const angle = (i / BURST_COUNT) * Math.PI * 2 + between(i, 1, -0.14, 0.14);
  const reach = between(i, 2, 190, 620);
  const round = i % 3 === 0;
  const w = between(i, 7, 8, 15);
  return {
    style: {
      "--mx": `${Math.round(Math.cos(angle) * reach * 0.62)}px`,
      "--my": `${Math.round(-Math.abs(Math.sin(angle)) * reach * 0.55 - 60)}px`,
      "--dx": `${Math.round(Math.cos(angle) * reach * 1.45)}px`,
      "--dy": `${Math.round(between(i, 3, 340, 760))}px`,
      "--rot": `${Math.round(between(i, 4, 200, 1000))}deg`,
      "--d": `${between(i, 5, 0, 0.3).toFixed(2)}s`,
      "--t": `${between(i, 6, 1.6, 2.7).toFixed(2)}s`,
      "--w": `${w.toFixed(1)}px`,
      "--h": `${(round ? w : w * between(i, 8, 1.2, 2)).toFixed(1)}px`,
      "--r": round ? "50%" : "2px",
      "--c": CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    } as React.CSSProperties,
  };
});

// RAIN — the background layer: pieces drop across the FULL width of the panel,
// staggered, so the celebration fills the screen instead of hugging the mark.
const RAIN = Array.from({ length: RAIN_COUNT }, (_, i) => {
  const round = i % 4 === 0;
  const w = between(i, 12, 7, 13);
  return {
    style: {
      "--x": `${between(i, 10, 1, 99).toFixed(1)}%`,
      "--sway": `${Math.round(between(i, 11, -90, 90))}px`,
      "--rot": `${Math.round(between(i, 13, 240, 1100))}deg`,
      "--d": `${between(i, 14, 0, 2.1).toFixed(2)}s`,
      "--t": `${between(i, 15, 2.6, 4.4).toFixed(2)}s`,
      "--w": `${w.toFixed(1)}px`,
      "--h": `${(round ? w : w * between(i, 16, 1.2, 2)).toFixed(1)}px`,
      "--r": round ? "50%" : "2px",
      "--c": CONFETTI_COLORS[(i + 2) % CONFETTI_COLORS.length],
    } as React.CSSProperties,
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
        {RAIN.map((p, i) => (
          <span key={`r${i}`} className="bw-confetti-r" style={p.style} />
        ))}
        {BURST.map((p, i) => (
          <span key={`b${i}`} className="bw-confetti-p" style={p.style} />
        ))}
      </div>

      {/* the supplied success mark (public/success-animation.gif) — it draws its
          OWN circle and ✓ over 37 frames / 1.48s, so it brings no green disc,
          no ring and no pop of ours behind it. The file's NETSCAPE2.0 loop
          extension was stripped in the repo copy: it plays exactly once and
          settles on the finished mark instead of redrawing forever.
          eslint-disable: next/image would re-encode the animation to a still. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="bw-success-ic" src="/success-animation.gif" alt="" aria-hidden="true" />

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
