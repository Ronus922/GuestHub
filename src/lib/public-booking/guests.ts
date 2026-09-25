// ============================================================
// Public booking — guest composition ("guests") parameter.
//
// The public site (sea-tower) describes a search party as ONE string, a
// room per comma, adults-children per room: "2-0" · "2-0,3-1". This module
// is the single parser for that format on the GuestHub side — pure (no DB,
// no framework) so the check:* suite can pin it directly.
//
// Limits mirror POST /api/public/bookings' validation (rooms 1–5, adults
// 1–6, children 0–4): a composition the search accepts must be one the
// booking accepts, or the guest hits a dead-end checkout. The site never
// sends infants; the engine receives infants: 0, exactly as the booking does.
// ============================================================

export type Party = { adults: number; children: number; infants: number };

export const MAX_PUBLIC_ROOMS = 5;

const PARTY_RE = /^([1-6])-([0-4])$/;

// "2-0,3-1" → [{adults:2,children:0,infants:0},{adults:3,children:1,infants:0}]
// Anything else (empty, out-of-range, extra rooms, malformed) → null: the
// caller answers 400, never guesses a party.
export function parseGuestsParam(raw: string): Party[] | null {
  const parts = raw.split(",");
  if (parts.length < 1 || parts.length > MAX_PUBLIC_ROOMS) return null;
  const parties: Party[] = [];
  for (const part of parts) {
    const m = PARTY_RE.exec(part.trim());
    if (!m) return null;
    parties.push({ adults: Number(m[1]), children: Number(m[2]), infants: 0 });
  }
  return parties;
}

// Canonical string for a party list — what the response echoes back.
export function formatGuestsParam(parties: Party[]): string {
  return parties.map((p) => `${p.adults}-${p.children}`).join(",");
}
