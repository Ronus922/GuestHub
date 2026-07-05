"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/shared/Icon";
import { SidePanel } from "@/components/ui/SidePanel";
import { addDays, dayOfWeek, eachDay, HEBREW_DAY_LETTERS, type DateOnly } from "@/lib/dates";
import { bulkUpdateRatesAction } from "./actions";
import { applyPriceMode } from "@/lib/rates/rules";
import type { BulkUpdateRatesInput } from "@/lib/validation/rates";
import type { RateGridType, RateCellState } from "./types";

type PriceMode = "replace" | "add" | "subtract" | "percent_add" | "percent_subtract";
const PRICE_MODES: { value: PriceMode; label: string; unit: string }[] = [
  { value: "percent_add", label: "העלאה באחוזים", unit: "%" },
  { value: "percent_subtract", label: "הורדה באחוזים", unit: "%" },
  { value: "replace", label: "מחיר קבוע", unit: "₪" },
  { value: "add", label: "הוספת סכום", unit: "₪" },
  { value: "subtract", label: "הפחתת סכום", unit: "₪" },
];

type TriState = "nochange" | "yes" | "no";

// A flat SU record for the selection grid.
type SuCard = { id: string; code: string; name: string; typeName: string; basePrice: number; roomTypeId: string; pooled: boolean; rooms: number };

export function GroupUpdatePanel({
  open,
  types,
  from,
  toInclusive,
  minDate,
  maxDate,
  presetUnitIds,
  onClose,
}: {
  open: boolean;
  types: RateGridType[];
  from: DateOnly;
  toInclusive: DateOnly;
  // Writable horizon (Step 6): minDate = tenant-local today, maxDate = today + 5y.
  // Group Update spans the FULL horizon, not just the grid's visible window.
  minDate: DateOnly;
  maxDate: DateOnly;
  presetUnitIds: string[];
  onClose: () => void;
}) {
  // Clamp a requested date into [minDate, maxDate].
  const clampDate = (d: DateOnly): DateOnly => (d < minDate ? minDate : d > maxDate ? maxDate : d);
  const router = useRouter();
  const allCards: SuCard[] = useMemo(
    () =>
      types.flatMap((t) =>
        t.units.map((u) => ({
          id: u.sellableUnitId,
          code: u.code,
          name: u.name,
          typeName: t.roomTypeName,
          basePrice: u.basePrice,
          roomTypeId: t.roomTypeId ?? "—",
          pooled: u.isPooled,
          rooms: u.roomCount,
        })),
      ),
    [types],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set(presetUnitIds));
  const [cardType, setCardType] = useState<string>("all");
  const [search, setSearch] = useState("");

  const [dateFrom, setDateFrom] = useState<DateOnly>(clampDate(from));
  const [dateTo, setDateTo] = useState<DateOnly>(clampDate(toInclusive));
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]));

  // field controls (each defaults to "no change")
  const [priceOn, setPriceOn] = useState(false);
  const [priceMode, setPriceMode] = useState<PriceMode>("percent_add");
  const [priceAmount, setPriceAmount] = useState(10);
  const [stopSell, setStopSell] = useState<TriState>("nochange");
  const [minThroughOn, setMinThroughOn] = useState(false);
  const [minThrough, setMinThrough] = useState(2);
  const [maxStayOn, setMaxStayOn] = useState(false);
  const [maxStay, setMaxStay] = useState(7);
  const [minArrivalOn, setMinArrivalOn] = useState(false);
  const [minArrival, setMinArrival] = useState(1);
  const [cta, setCta] = useState<TriState>("nochange");
  const [ctd, setCtd] = useState<TriState>("nochange");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open may target a different preset (whole grid vs one room-type button).
  // The panel is always mounted now, so opening must reset ALL editable state to
  // defaults — otherwise field selections leak from a previous (unapplied) open
  // and could silently bulk-write stale changes.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(presetUnitIds));
    setCardType("all");
    setSearch("");
    // clamp the reset window into the writable horizon (inline so the effect deps
    // stay primitive and it never re-fires mid-edit).
    setDateFrom(from < minDate ? minDate : from > maxDate ? maxDate : from);
    setDateTo(toInclusive < minDate ? minDate : toInclusive > maxDate ? maxDate : toInclusive);
    setWeekdays(new Set([0, 1, 2, 3, 4, 5, 6]));
    setPriceOn(false);
    setPriceMode("percent_add");
    setPriceAmount(10);
    setStopSell("nochange");
    setMinThroughOn(false);
    setMinThrough(2);
    setMaxStayOn(false);
    setMaxStay(7);
    setMinArrivalOn(false);
    setMinArrival(1);
    setCta("nochange");
    setCtd("nochange");
    setError(null);
  }, [open, presetUnitIds, from, toInclusive, minDate, maxDate]);

  const cards = allCards.filter(
    (c) =>
      (cardType === "all" || c.roomTypeId === cardType) &&
      (search.trim() === "" || c.code.includes(search.trim()) || c.name.includes(search.trim())),
  );

  const effectiveDates = useMemo(() => {
    if (dateTo < dateFrom) return [];
    return eachDay(dateFrom, addDays(dateTo, 1)).filter((d) => weekdays.has(dayOfWeek(d)));
  }, [dateFrom, dateTo, weekdays]);

  const cellCount = selected.size * effectiveDates.length;

  // Honest preview breakdown (§9) over the actual selected cells' canonical state
  // — so the user is never told stop_sell=false creates physical availability.
  const cellIndex = useMemo(() => {
    const m = new Map<string, RateCellState>();
    for (const t of types) for (const u of t.units) for (const c of u.cells) m.set(`${u.sellableUnitId}|${c.date}`, c);
    return m;
  }, [types]);
  const preview = useMemo(() => {
    let noInventory = 0, missingPrice = 0, currentlyClosed = 0, currentlyOpen = 0;
    for (const su of selected) {
      for (const d of effectiveDates) {
        const c = cellIndex.get(`${su}|${d}`);
        if (!c) continue;
        if (c.availability === 0) noInventory++;
        if (c.effectivePrice <= 0) missingPrice++;
        if (c.stopSell) currentlyClosed++; else currentlyOpen++;
      }
    }
    return { noInventory, missingPrice, willOpen: currentlyClosed, willClose: currentlyOpen };
  }, [selected, effectiveDates, cellIndex]);

  const anyFieldSelected =
    priceOn || stopSell !== "nochange" || minThroughOn || maxStayOn || minArrivalOn || cta !== "nochange" || ctd !== "nochange";
  const canApply = selected.size > 0 && effectiveDates.length > 0 && anyFieldSelected && !busy;

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleWeekday = (d: number) =>
    setWeekdays((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  // sample "before → after" price for the first selected SU (display only)
  const sample = useMemo(() => {
    if (!priceOn) return null;
    const first = allCards.find((c) => selected.has(c.id));
    if (!first) return null;
    const after = applyPriceMode(first.basePrice, priceMode, priceAmount, first.basePrice);
    return { typeName: first.typeName, before: first.basePrice, after };
  }, [priceOn, priceMode, priceAmount, selected, allCards]);

  async function apply() {
    setBusy(true);
    setError(null);
    const allWeekdays = weekdays.size === 7;
    const input = {
      sellableUnitIds: [...selected],
      dateFrom,
      dateTo,
      ...(allWeekdays ? {} : { weekdays: [...weekdays] }),
      ...(priceOn ? { price: { mode: priceMode, amount: priceAmount } } : {}),
      ...(minThroughOn ? { minStayThrough: minThrough } : {}),
      ...(maxStayOn ? { maxStay } : {}),
      ...(minArrivalOn ? { minStayArrival: minArrival } : {}),
      ...(stopSell !== "nochange" ? { stopSell: stopSell === "yes" } : {}),
      ...(cta !== "nochange" ? { closedToArrival: cta === "yes" } : {}),
      ...(ctd !== "nochange" ? { closedToDeparture: ctd === "yes" } : {}),
    };
    const res = await bulkUpdateRatesAction(input as BulkUpdateRatesInput);
    setBusy(false);
    if (res.success) {
      router.refresh();
      onClose();
    } else {
      setError(res.error ?? "אירעה שגיאה");
    }
  }

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title="עדכון קבוצתי"
      subtitle="עדכון מחיר, זמינות ומגבלות לילות במספר יחידות ותאריכים בבת אחת"
      icon="bulk-update"
      bodyClassName="p-5 flex flex-col gap-4"
      footer={
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="h-11 px-5 rounded-xl border-[1.5px] border-[#e4e8f0] text-[13.5px] font-bold text-[var(--color-ink)] hover:bg-[#f5f7fb]">ביטול</button>
          <button
            data-testid="gu-apply"
            onClick={apply}
            disabled={!canApply}
            className="flex-1 h-11 rounded-xl bg-[var(--color-primary)] text-white text-[14px] font-extrabold hover:bg-[var(--color-primary-dark)] disabled:opacity-45 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            <Icon name="check" size={18} />
            {busy ? "מעדכן…" : `עדכן ${cellCount} תאים`}
          </button>
        </div>
      }
    >
          {/* 1 — Sellable Units */}
          <Section n={1} title="יחידות מכירה" badge={`נבחרו ${selected.size} מתוך ${allCards.length}`}>
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חיפוש יחידה…"
                className="h-9 px-3 rounded-lg border-[1.5px] border-[#e4e8f0] text-[13px] font-medium bg-white flex-1 min-w-[140px] outline-none focus:border-[var(--color-primary)]"
              />
              <button className={`rg-chip${cardType === "all" ? " on" : ""}`} onClick={() => setCardType("all")}>הכל</button>
              {types.map((t) => (
                <button key={t.roomTypeId ?? "—"} className={`rg-chip${cardType === (t.roomTypeId ?? "—") ? " on" : ""}`} onClick={() => setCardType(t.roomTypeId ?? "—")}>
                  {t.roomTypeName}
                </button>
              ))}
              <button data-testid="gu-selectall" className="rg-chip" onClick={() => setSelected(new Set(cards.map((c) => c.id)))}>בחר הכל</button>
              <button data-testid="gu-clear" className="rg-chip" onClick={() => setSelected(new Set())}>נקה</button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
              {cards.map((c) => {
                const on = selected.has(c.id);
                return (
                  <button
                    key={c.id}
                    data-su={c.id}
                    onClick={() => toggleSel(c.id)}
                    className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border-[1.5px] text-right ${on ? "border-[var(--color-primary)] bg-[var(--color-primary-050)]" : "border-[#e4e8f0] bg-white hover:bg-[#f7f9fc]"}`}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <b className="text-[15px] text-[var(--color-ink)]">{c.code}</b>
                        {c.pooled && <span className="rg-pool">מאגר · {c.rooms}</span>}
                      </span>
                      <span className="block text-[11px] font-bold text-[var(--color-faint)] truncate">{c.typeName}</span>
                    </span>
                    <span className="flex items-center gap-2 flex-none">
                      <span className="text-[12px] font-bold text-[var(--color-muted)]">₪{Math.round(c.basePrice)}</span>
                      <span className={`w-5 h-5 rounded-md border-[1.5px] flex items-center justify-center ${on ? "bg-[var(--color-primary)] border-[var(--color-primary)] text-white" : "border-[#cfd6e4]"}`}>
                        {on && <Icon name="check" size={13} />}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* 2 — Dates */}
          <Section n={2} title="תאריכים" badge={`${effectiveDates.length} לילות`}>
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <label className="text-[12px] font-bold text-[var(--color-muted)]">טווח</label>
              <input data-testid="gu-date-from" type="date" value={dateFrom} min={minDate} max={maxDate} onChange={(e) => setDateFrom(clampDate(e.target.value))} className="h-9 px-2 rounded-lg border-[1.5px] border-[#e4e8f0] text-[13px] font-bold bg-white outline-none" />
              <span className="text-[var(--color-faint)]">–</span>
              <input data-testid="gu-date-to" type="date" value={dateTo} min={dateFrom} max={maxDate} onChange={(e) => setDateTo(clampDate(e.target.value))} className="h-9 px-2 rounded-lg border-[1.5px] border-[#e4e8f0] text-[13px] font-bold bg-white outline-none" />
              <span className="mx-1 w-px h-6 bg-[#e4e8f0]" />
              {([7, 14, 30] as const).map((n) => (
                <button key={n} className="rg-chip" onClick={() => setDateTo(earlier(addDays(dateFrom, n - 1), maxDate))}>{n} ימים</button>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-bold text-[var(--color-muted)]">ימים בשבוע</span>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <button
                  key={d}
                  onClick={() => toggleWeekday(d)}
                  className={`w-9 h-9 rounded-full text-[13px] font-extrabold ${weekdays.has(d) ? "bg-[var(--color-primary)] text-white" : "bg-[#eef1f6] text-[#5b6478]"}`}
                >
                  {HEBREW_DAY_LETTERS[d].replace("'", "")}
                </button>
              ))}
              <span className="mx-1 w-px h-6 bg-[#e4e8f0]" />
              <button className="rg-tlink" onClick={() => setWeekdays(new Set([0, 1, 2, 3, 4, 5, 6]))}>הכל</button>
              <button className="rg-tlink" onClick={() => setWeekdays(new Set([0, 1, 2, 3, 4]))}>אמצע שבוע</button>
              <button className="rg-tlink" onClick={() => setWeekdays(new Set([5, 6]))}>סוף שבוע</button>
            </div>
          </Section>

          {/* 3 — Changes (partial: only marked fields update) */}
          <Section n={3} title="שינויים לביצוע" hint="רק שדות מסומנים יעודכנו — השאר יישארו ללא שינוי">
            <div className="flex flex-col divide-y divide-[#eef0f5]">
              <FieldRow icon="credit-card" title="מחיר ללילה" desc="החלפה, תוספת או שינוי באחוזים" on={priceOn} onToggle={() => setPriceOn((v) => !v)} testId="gu-price">
                <input type="number" value={priceAmount} onChange={(e) => setPriceAmount(Number(e.target.value))} disabled={!priceOn} className="w-20 h-9 px-2 rounded-lg border-[1.5px] border-[#e4e8f0] text-[13px] font-bold text-center bg-white disabled:opacity-50 outline-none" />
                <select value={priceMode} onChange={(e) => setPriceMode(e.target.value as PriceMode)} disabled={!priceOn} className="h-9 px-2 rounded-lg border-[1.5px] border-[#e4e8f0] text-[13px] font-bold bg-white disabled:opacity-50 outline-none">
                  {PRICE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </FieldRow>

              <FieldRow icon="power" title="זמינות למכירה" desc="פתיחה או סגירה למכירה בתאריכים שנבחרו">
                <Segmented value={stopSell} onChange={setStopSell} yes="סגור" no="פתוח" testId="gu-stopsell" />
              </FieldRow>

              <FieldRow icon="moon" title="מינימום לילות" desc="אורך שהייה מזערי להזמנה" on={minThroughOn} onToggle={() => setMinThroughOn((v) => !v)} testId="gu-minthrough">
                <Stepper value={minThrough} onChange={setMinThrough} disabled={!minThroughOn} />
              </FieldRow>

              <FieldRow icon="calendar" title="מקסימום לילות" desc="אורך שהייה מרבי להזמנה" on={maxStayOn} onToggle={() => setMaxStayOn((v) => !v)} testId="gu-maxstay">
                <Stepper value={maxStay} onChange={setMaxStay} disabled={!maxStayOn} />
              </FieldRow>

              <FieldRow icon="login" title="מ׳ לילות בהגעה" desc="מינימום לילות כשההגעה בתאריך זה" on={minArrivalOn} onToggle={() => setMinArrivalOn((v) => !v)} testId="gu-minarrival">
                <Stepper value={minArrival} onChange={setMinArrival} disabled={!minArrivalOn} />
              </FieldRow>

              <FieldRow icon="login" title="סגור להגעה (CTA)" desc="חסימת צ׳ק-אין בתאריכים שנבחרו">
                <Segmented value={cta} onChange={setCta} yes="פעיל" no="כבוי" testId="gu-cta" />
              </FieldRow>

              <FieldRow icon="logout" title="סגור לעזיבה (CTD)" desc="חסימת צ׳ק-אאוט בתאריכים שנבחרו">
                <Segmented value={ctd} onChange={setCtd} yes="פעיל" no="כבוי" testId="gu-ctd" />
              </FieldRow>
            </div>
          </Section>

          {/* summary */}
          <Section n={0} title="סיכום העדכון" icon="info">
            <div className="grid grid-cols-3 gap-3">
              <Stat value={cellCount} label="תאים לעדכון" />
              <Stat value={effectiveDates.length} label="לילות" />
              <Stat value={selected.size} label="יחידות" />
            </div>
            {sample && (
              <p className="mt-3 text-[13px] font-bold text-[var(--color-muted)]">
                דוגמה — {sample.typeName}: ₪{Math.round(sample.before)} <span className="text-[var(--color-faint)]">←</span> <b className="text-[var(--color-ink)]">₪{Math.round(sample.after)}</b>
              </p>
            )}
            {cellCount > 0 && (stopSell !== "nochange" || preview.noInventory > 0 || preview.missingPrice > 0) && (
              <div className="mt-3 text-[12.5px] font-bold text-[var(--color-muted)] flex flex-col gap-1">
                {stopSell === "no" && (
                  <p><b className="text-[var(--color-status-success)]">{preview.willOpen}</b> תאים ייפתחו למכירה מסחרית{preview.noInventory > 0 && <> · <b className="text-[#a23b52]">{preview.noInventory}</b> מתוכם יישארו ללא מלאי פיזי (הפתיחה המסחרית אינה יוצרת זמינות)</>}</p>
                )}
                {stopSell === "yes" && (
                  <p><b className="text-[#a23b52]">{preview.willClose}</b> תאים ייסגרו למכירה מסחרית · המלאי הפיזי אינו משתנה</p>
                )}
                {preview.noInventory > 0 && stopSell !== "no" && <p><b className="text-[#a23b52]">{preview.noInventory}</b> מהתאים ללא מלאי פיזי</p>}
                {preview.missingPrice > 0 && <p><b className="text-[#b4670a]">{preview.missingPrice}</b> מהתאים ללא מחיר אפקטיבי</p>}
              </div>
            )}
          </Section>

      {error && <p className="text-[13px] font-bold text-[var(--color-status-danger)]">{error}</p>}
    </SidePanel>
  );
}

function earlier(a: DateOnly, b: DateOnly): DateOnly {
  return a < b ? a : b;
}

function Section({ n, title, badge, hint, icon, children }: { n: number; title: string; badge?: string; hint?: string; icon?: "info"; children: ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-[#e8ebf2] p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-6 h-6 rounded-lg bg-[var(--color-primary-050)] text-[var(--color-primary)] text-[12px] font-extrabold flex items-center justify-center">
          {icon ? <Icon name={icon} size={14} /> : n}
        </span>
        <h3 className="text-[14.5px] font-extrabold text-[var(--color-ink)]">{title}</h3>
        {badge && <span className="cb-count mr-auto">{badge}</span>}
        {hint && <span className="text-[11.5px] font-medium text-[var(--color-faint)] mr-auto text-left">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function FieldRow({ icon, title, desc, on, onToggle, testId, children }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; desc: string; on?: boolean; onToggle?: () => void; testId?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="w-8 h-8 rounded-lg bg-[#f2f4f8] text-[#5b6478] flex items-center justify-center flex-none"><Icon name={icon} size={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-extrabold text-[var(--color-ink)]">{title}</span>
          {onToggle && (
            <button data-testid={testId ? `${testId}-toggle` : undefined} onClick={onToggle} className={`w-9 h-5 rounded-full relative transition-colors ${on ? "bg-[var(--color-primary)]" : "bg-[#cfd6e4]"}`} aria-pressed={on} aria-label={title}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? "left-0.5" : "right-0.5"}`} />
            </button>
          )}
        </div>
        <p className="text-[11.5px] font-medium text-[var(--color-faint)]">{desc}</p>
      </div>
      <div className="flex items-center gap-2 flex-none">{children}</div>
    </div>
  );
}

function Segmented({ value, onChange, yes, no, testId }: { value: TriState; onChange: (v: TriState) => void; yes: string; no: string; testId?: string }) {
  const opt = (v: TriState, label: string) => (
    <button data-testid={testId ? `${testId}-${v}` : undefined} onClick={() => onChange(v)} className={`h-9 px-3 rounded-lg text-[12.5px] font-bold ${value === v ? "bg-[var(--color-primary)] text-white" : "bg-white border-[1.5px] border-[#e4e8f0] text-[#5b6478]"}`}>{label}</button>
  );
  return <div className="flex items-center gap-1.5">{opt("nochange", "ללא שינוי")}{opt("yes", yes)}{opt("no", no)}</div>;
}

function Stepper({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className={`flex items-center gap-1 ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      <button onClick={() => onChange(Math.max(0, value - 1))} className="w-8 h-8 rounded-lg border-[1.5px] border-[#e4e8f0] flex items-center justify-center text-[var(--color-muted)]"><Icon name="minus" size={15} /></button>
      <span className="w-8 text-center text-[14px] font-extrabold tabular-nums">{value}</span>
      <button onClick={() => onChange(value + 1)} className="w-8 h-8 rounded-lg border-[1.5px] border-[#e4e8f0] flex items-center justify-center text-[var(--color-muted)]"><Icon name="plus" size={15} /></button>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="bg-[#f7f9fc] rounded-xl p-3 text-center">
      <div className="text-[22px] font-extrabold text-[var(--color-ink)] tabular-nums">{value}</div>
      <div className="text-[11.5px] font-bold text-[var(--color-faint)]">{label}</div>
    </div>
  );
}
