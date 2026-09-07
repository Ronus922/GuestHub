// Pure draft logic for the /rates cell drawer ("מצב מכירה ליום", D177).
//
// Zero imports on purpose: scripts/check-rate-cell-panel.mjs compiles this
// file ALONE with tsc and CALLS it, so every rule below is proven by running
// it, not by reading it.
//
// The drawer edits six commercial fields as a local DRAFT (an overlay of the
// user's edits on top of the saved cell) and writes them in ONE
// upsertRateCellAction call; the price has its own button and its own call.
// "No limit" for a stay field is NULL, never 0 (lib/validation/rates.ts — 0 is
// a STRICTER restriction and a Beds24 payload killer).

export type CellDraft = {
  stopSell: boolean;
  minStayArrival: number | null;
  minStayThrough: number | null;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
};

export const DRAFT_FIELDS = [
  "stopSell",
  "minStayArrival",
  "minStayThrough",
  "maxStay",
  "closedToArrival",
  "closedToDeparture",
] as const satisfies readonly (keyof CellDraft)[];

/** the schema ceiling of a stay field (stayField.max in lib/validation/rates.ts) */
export const STAY_MAX = 3650;

// The footer's "שינויים שלא נשמרו: …" names the CATEGORIES that changed, in a
// fixed order, never the raw field names.
export type DraftCategory = "sale" | "stay" | "arrival_departure";
export const DRAFT_CATEGORY: Record<keyof CellDraft, DraftCategory> = {
  stopSell: "sale",
  minStayArrival: "stay",
  minStayThrough: "stay",
  maxStay: "stay",
  closedToArrival: "arrival_departure",
  closedToDeparture: "arrival_departure",
};
const CATEGORY_ORDER: readonly DraftCategory[] = ["sale", "stay", "arrival_departure"];
export const DRAFT_CATEGORY_TEXT: Record<DraftCategory, string> = {
  sale: "מכירה",
  stay: "מגבלות שהייה",
  arrival_departure: "כניסה ועזיבה",
};

function setField<K extends keyof CellDraft>(target: Partial<CellDraft>, key: K, value: CellDraft[K]): void {
  target[key] = value;
}

/** the six commercial fields as SAVED — the baseline every comparison uses */
export function draftFromCell(c: CellDraft): CellDraft {
  return {
    stopSell: c.stopSell,
    minStayArrival: c.minStayArrival,
    minStayThrough: c.minStayThrough,
    maxStay: c.maxStay,
    closedToArrival: c.closedToArrival,
    closedToDeparture: c.closedToDeparture,
  };
}

/**
 * Only the fields whose draft value differs from the saved one — `{}` when the
 * draft is clean (a toggle-and-back is not a change). Never carries `price`.
 */
export function draftPatch(server: CellDraft, draft: CellDraft): Partial<CellDraft> {
  const patch: Partial<CellDraft> = {};
  for (const k of DRAFT_FIELDS) {
    if (draft[k] !== server[k]) setField(patch, k, draft[k]);
  }
  return patch;
}

/**
 * Drops every edit that now EQUALS the saved value (after the user's own save
 * landed, or after someone else saved the same value). Returns the SAME object
 * when nothing is dropped, so a React setState with it is a no-op.
 */
export function pruneEdits(edits: Partial<CellDraft>, server: CellDraft): Partial<CellDraft> {
  let dropped = false;
  const next: Partial<CellDraft> = {};
  for (const k of DRAFT_FIELDS) {
    const v = edits[k];
    if (v === undefined) continue;
    if (v === server[k]) {
      dropped = true;
      continue;
    }
    setField(next, k, v);
  }
  return dropped ? next : edits;
}

/** the categories a patch touches, in the fixed footer order, each once */
export function dirtyCategories(patch: Partial<CellDraft>): DraftCategory[] {
  const present = new Set<DraftCategory>();
  for (const k of DRAFT_FIELDS) {
    if (patch[k] !== undefined) present.add(DRAFT_CATEGORY[k]);
  }
  return CATEGORY_ORDER.filter((c) => present.has(c));
}

/**
 * [−] / [+] on a stay field. Below the floor (1) the value becomes NULL ("—",
 * no limit) and [+] from NULL lands on 1; [−] at NULL stays NULL; [+] stops at
 * the schema ceiling. 0 is never produced.
 */
export function stepStay(value: number | null, dir: -1 | 1): number | null {
  if (dir === 1) return value == null ? 1 : Math.min(STAY_MAX, value + 1);
  if (value == null || value <= 1) return null;
  return value - 1;
}

/**
 * Every SAVED sell reason except the commercial one and the "nothing blocks"
 * marker — i.e. the reasons the drawer's draft cannot change (physical, plan,
 * price, mapping). collectSellReasons() returns ["SELLABLE"] when nothing
 * blocks, otherwise every blocking code with COMMERCIAL_STOP_SELL among them.
 */
export function blockingReasons<T extends string>(
  reasonCodes: readonly T[],
): Exclude<T, "SELLABLE" | "COMMERCIAL_STOP_SELL">[] {
  // the predicate is what lets the drawer index SELL_REASON_SENTENCE, whose keys
  // are exactly these codes — the two the draft owns can never come out of here
  return reasonCodes.filter(
    (c): c is Exclude<T, "SELLABLE" | "COMMERCIAL_STOP_SELL"> =>
      c !== "SELLABLE" && c !== "COMMERCIAL_STOP_SELL",
  );
}

/**
 * The final sale state the drawer shows LIVE, before saving: the draft's
 * stopSell replaces the saved commercial verdict, every other axis is read as
 * saved. A physically consumed day stays unsellable however the switch is set.
 */
export function liveSellable(reasonCodes: readonly string[], draftStopSell: boolean): boolean {
  return blockingReasons(reasonCodes).length === 0 && !draftStopSell;
}

const dash = (v: number | null): string => (v == null ? "—" : String(v));

/**
 * The live tail of the channel-sync note — what the commercial ARI WOULD carry,
 * built from the DRAFT plus the saved rate. Hebrew words only (no CTA/CTD).
 */
export function outboundSummary(d: CellDraft, rate: number): string {
  return [
    d.stopSell ? "סגור למכירה" : "פתוח למכירה",
    `כניסה ${d.closedToArrival ? "סגורה" : "פתוחה"}`,
    `עזיבה ${d.closedToDeparture ? "סגורה" : "פתוחה"}`,
    `מ׳ הגעה ${dash(d.minStayArrival)}`,
    `מ׳ טווח ${dash(d.minStayThrough)}`,
    `מקס ${dash(d.maxStay)}`,
    `₪${Math.round(rate)}`,
  ].join(" · ");
}
