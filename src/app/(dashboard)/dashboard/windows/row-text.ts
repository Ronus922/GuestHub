import type { StayRow } from "../data";

// Shared row text for the people windows (arr, inh). One definition so a guest
// reads identically in both — the reference re-types this anatomy per window,
// which is how two rows drift into two heights (audit §B.2).

/** Initials for the avatar. The component does no name parsing; this does. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "א";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0]}${parts[parts.length - 1][0]}`;
}

/** "חדר 101 · סוויטה · 3 לילות" — only the parts that actually exist. */
export function staySubline(row: StayRow): string {
  const bits: string[] = [];
  if (row.roomNumber) bits.push(`חדר ${row.roomNumber}`);
  if (row.roomTypeName) bits.push(row.roomTypeName);
  bits.push(row.nights === 1 ? "לילה אחד" : `${row.nights} לילות`);
  return bits.join(" · ");
}

/** "עוזב ב-4/8" — the departure the in-house guest is heading toward. */
export function leavesOn(row: StayRow): string {
  const [, m, d] = row.checkOut.split("-");
  return `עוזב ב-${Number(d)}/${Number(m)}`;
}
