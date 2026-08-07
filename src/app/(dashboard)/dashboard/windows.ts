// ============================================================
// The dashboard window registry — one module, no React, no server-only, no DB.
// Pure so the guard (scripts/check-dashboard-shell.mjs) can import and prove it.
//
// DeshbordMain.md §8 lists the traps this file exists to make UNREPRESENTABLE
// rather than merely documented:
//
//   §8.1 "a window added to WINS but not to state.layout falls to order:9 and
//         its drag breaks."
//        → DEFAULT_LAYOUT is not hand-maintained alongside WINDOWS. Its
//          membership is DERIVED from WINDOWS and checked twice:
//            · at COMPILE time — `_everyWindowIsPlaced` below is a type error
//              the moment a registered id is missing from DEFAULT_ORDER, and
//              DEFAULT_ORDER's element types make an unregistered id (or a
//              right-column id under `l`) unassignable;
//            · at IMPORT time — buildDefaultLayout() throws, so a JS-only
//              consumer that skipped the type-check still cannot boot with a
//              broken registry.
//          `order: 9` is therefore not a state this file can produce.
//
//   §8.2 "forgetting to bump the localStorage key version lets a stale saved
//         layout win."
//        → there is no versioned key, because there is no localStorage. The
//          stored layout is RECONCILED against the registry on every read
//          (normalizeDashboardLayout): unknown ids are dropped, new ids are
//          appended in their default order. A saved layout can neither hide a
//          new window nor resurrect a deleted one, so there is no version to
//          forget to bump.
//
//   Cross-column drag (§3): the SAVED layout owns each window's column; the
//   registry's `defaultCol` only places windows a stored layout never
//   mentioned. DEFAULT_ORDER still pins every window to its default column —
//   that is the fresh-user layout, not a constraint on saved state.
// ============================================================
import type { IconName } from "@/components/shared/Icon";

export type DashboardColumn = "l" | "r";

export type DashboardWindowDef = {
  id: string;
  /** where a FRESH layout places this window — the saved layout owns the actual column */
  defaultCol: DashboardColumn;
  icon: IconName;
  title: string;
  /** what Phase 2 will pour in — shown as the empty state until then */
  empty: string;
};

// ---- the registry ----------------------------------------------------------
export const WINDOWS = [
  {
    id: "arr",
    defaultCol: "l",
    icon: "arrivals-departures",
    title: "הגעות ועזיבות היום",
    empty: "כאן יופיעו ההגעות והעזיבות של היום, עם כפתור כניסה/יציאה לכל אורח.",
  },
  {
    id: "rev",
    defaultCol: "l",
    icon: "chart-area",
    title: "הכנסות — 12 החודשים האחרונים",
    empty: "כאן יופיע גרף ההכנסות החודשי לצד אחוזי התפוסה.",
  },
  {
    id: "hk",
    defaultCol: "l",
    icon: "cleaning",
    title: "חדרים לניקיון — עזיבות היום",
    empty: "כאן יופיעו החדרים שהתפנו היום וממתינים לניקיון.",
  },
  {
    id: "alr",
    defaultCol: "r",
    icon: "bell",
    title: "דורש טיפול",
    empty: "כאן יופיעו ההזמנות והתשלומים שדורשים התייחסות.",
  },
  {
    id: "pay",
    defaultCol: "r",
    icon: "credit-card",
    title: "כרטיסי אשראי לחיוב",
    empty: "כאן יופיעו ההזמנות שהגיע מועדן וטרם אושרה עסקתן.",
  },
  {
    id: "stk",
    defaultCol: "r",
    icon: "warning",
    title: "הזמנות ערוץ שנתקעו",
    empty: "כאן יופיעו הזמנות ערוץ שנכשלו בקליטה אוטומטית.",
  },
  {
    id: "iss",
    defaultCol: "r",
    icon: "maintenance",
    title: "תקלות פתוחות",
    empty: "כאן יופיעו התקלות הפתוחות לפי חומרה.",
  },
  {
    id: "tsk",
    defaultCol: "r",
    icon: "list-checks",
    title: "משימות היום",
    empty: "כאן יופיעו המשימות שנקבעו להיום.",
  },
  {
    id: "rvw",
    defaultCol: "r",
    icon: "reviews",
    title: "חוות דעת — Booking.com",
    empty: "כאן יופיעו חוות הדעת האחרונות והממתינות למענה.",
  },
  {
    id: "msg",
    defaultCol: "r",
    icon: "forum",
    title: "הודעות אורחים",
    empty: "כאן יופיעו השיחות האחרונות עם האורחים.",
  },
  {
    id: "src",
    defaultCol: "r",
    icon: "donut",
    title: "פילוח מקורות הזמנה",
    empty: "כאן יופיע פילוח הערוצים שדרכם הגיעו ההזמנות.",
  },
  {
    id: "inh",
    defaultCol: "r",
    icon: "night-shelter",
    title: "בבית הלילה",
    empty: "כאן יופיעו האורחים ששוהים אצלנו הלילה.",
  },
] as const satisfies readonly DashboardWindowDef[];

export type DashboardWindowId = (typeof WINDOWS)[number]["id"];

type WindowOf<C extends DashboardColumn> = Extract<
  (typeof WINDOWS)[number],
  { defaultCol: C }
>["id"];

export type DashboardLayout = Record<DashboardColumn, DashboardWindowId[]>;

export type DashboardPreferences = {
  layout: DashboardLayout;
  hidden: DashboardWindowId[];
};

// ---- the default order -----------------------------------------------------
// `satisfies`, NOT a type annotation. An annotation would widen each array to
// `readonly WindowOf<'x'>[]`, and `[number]` on the widened type is the FULL
// column union — which makes the exhaustiveness check below vacuously true no
// matter what is listed here. `as const satisfies` keeps the literal tuple (so
// PlacedId is what is actually written) while still rejecting an unregistered
// id, or a right-column window listed under `l`.
const DEFAULT_ORDER = {
  l: ["arr", "rev", "hk"],
  r: ["alr", "pay", "stk", "iss", "tsk", "rvw", "msg", "src", "inh"],
} as const satisfies { l: readonly WindowOf<"l">[]; r: readonly WindowOf<"r">[] };

// COMPILE-TIME §8.1: every registered window must appear in DEFAULT_ORDER.
// Registering a twelfth window without placing it makes `PlacedId` a strict
// subset of `DashboardWindowId`, `MutuallyExhaustive` resolves to `never`, and
// `= true` stops type-checking. `pnpm typecheck` and `pnpm build` both fail.
type PlacedId = (typeof DEFAULT_ORDER)["l"][number] | (typeof DEFAULT_ORDER)["r"][number];
type MutuallyExhaustive<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _everyWindowIsPlaced: MutuallyExhaustive<DashboardWindowId, PlacedId> = true;
void _everyWindowIsPlaced;

export const COLUMNS: readonly DashboardColumn[] = ["l", "r"];

// IMPORT-TIME §8.1: the same invariant, for any consumer that never ran tsc.
function buildDefaultLayout(): DashboardLayout {
  const layout: DashboardLayout = { l: [], r: [] };
  for (const col of COLUMNS) {
    const registered = WINDOWS.filter((w) => w.defaultCol === col).map(
      (w) => w.id as DashboardWindowId,
    );
    const placed = DEFAULT_ORDER[col] as readonly DashboardWindowId[];

    const unregistered = placed.filter((id) => !registered.includes(id));
    if (unregistered.length)
      throw new Error(
        `dashboard windows: ${unregistered.join(", ")} placed in column '${col}' but not registered in WINDOWS`,
      );

    const unplaced = registered.filter((id) => !placed.includes(id));
    if (unplaced.length)
      throw new Error(
        `dashboard windows: ${unplaced.join(", ")} registered in column '${col}' but missing from DEFAULT_ORDER — a window with no place falls to the bottom and its drag breaks (DeshbordMain.md §8.1)`,
      );

    layout[col] = [...placed];
  }
  return layout;
}

export const DEFAULT_LAYOUT: DashboardLayout = buildDefaultLayout();

export const DEFAULT_PREFERENCES: DashboardPreferences = { layout: DEFAULT_LAYOUT, hidden: [] };

const BY_ID = new Map<string, DashboardWindowDef>(WINDOWS.map((w) => [w.id, w]));

export function windowById(id: string): DashboardWindowDef | undefined {
  return BY_ID.get(id);
}

export function isWindowId(id: unknown): id is DashboardWindowId {
  return typeof id === "string" && BY_ID.has(id);
}

export function defaultColumnOf(id: DashboardWindowId): DashboardColumn {
  // BY_ID is built from WINDOWS, so a valid id always resolves
  return BY_ID.get(id)!.defaultCol;
}

/**
 * Reconcile whatever is stored against the registry as it is TODAY (§8.2).
 *
 * · an id that no longer exists is dropped — a deleted window cannot be
 *   resurrected by an old row;
 * · the stored column WINS — a window may live in either column, and the
 *   registry supplies only the DEFAULT column for ids the stored layout never
 *   mentioned; an id stored in both columns keeps its first occurrence
 *   (l is scanned before r);
 * · a registered id the stored layout never heard of is APPENDED to its
 *   default column, in DEFAULT_ORDER position among the other newcomers — so a
 *   new window always appears, and never at `order: 9`;
 * · hidden is filtered the same way, so a stale id cannot hide a live window.
 *
 * Together these guarantee every registered id appears exactly once across the
 * two columns, whatever the input.
 *
 * Accepts `unknown` because the source is a jsonb column: nothing about its
 * shape is guaranteed by the type system.
 */
export function normalizeDashboardLayout(stored: unknown): DashboardPreferences {
  const raw = isRecord(stored) ? stored : {};
  const rawLayout = isRecord(raw.layout) ? raw.layout : {};

  const seen = new Set<DashboardWindowId>();
  const layout: DashboardLayout = { l: [], r: [] };

  for (const col of COLUMNS) {
    const list = Array.isArray(rawLayout[col]) ? (rawLayout[col] as unknown[]) : [];
    for (const id of list) {
      if (!isWindowId(id) || seen.has(id)) continue;
      seen.add(id);
      layout[col].push(id);
    }
  }

  // everything the stored layout did not mention, in its default position
  for (const col of COLUMNS) {
    for (const id of DEFAULT_LAYOUT[col]) {
      if (seen.has(id)) continue;
      seen.add(id);
      layout[col].push(id);
    }
  }

  const rawHidden = Array.isArray(raw.hidden) ? (raw.hidden as unknown[]) : [];
  const hidden = rawHidden.filter(isWindowId).filter((id, i, a) => a.indexOf(id) === i);

  return { layout, hidden };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
