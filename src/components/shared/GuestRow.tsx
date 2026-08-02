// ============================================================
// <GuestRow> — avatar + name (★ VIP) + subline + trailing slot (audit §B.2).
//
// Four call sites are coming: the dashboard's `arr`, `inh` and `msg` windows
// and the guest-inbox conversation list. The reference re-types the same
// anatomy inline in each of them (65 inline style attributes on the messages
// screen alone), which is exactly how four rows drift into four heights.
//
// The VIP star uses the --vip token, not the reference's #B7791F, and 13.5px
// rather than its 13px — the closed scale has no 13.
// ============================================================
export function GuestRow({
  initials,
  name,
  vip,
  subline,
  tone = "brand",
  trailing,
}: {
  /** already computed by the caller — this component does no name parsing */
  initials: string;
  name: string;
  vip?: boolean;
  subline?: React.ReactNode;
  /** avatar tint: brand for arrivals/in-house, warn for departures */
  tone?: "brand" | "warn";
  /** status button, chip, time — whatever the window puts at the row's end */
  trailing?: React.ReactNode;
}) {
  return (
    <div className="guest-row">
      <span className={`guest-avatar${tone === "warn" ? " guest-avatar-warn" : ""}`}>
        {initials}
      </span>
      <span className="guest-body">
        <span className="guest-name">
          {vip && (
            <span className="guest-vip" title="אורח VIP" aria-label="אורח VIP">
              ★
            </span>
          )}
          {name}
        </span>
        {subline && <span className="guest-sub">{subline}</span>}
      </span>
      {trailing}
    </div>
  );
}
