# 🎖️ Master Orchestrator

## כללי ברזל (מחייבים!)
1. **RTL First** - כל עיצוב מימין לשמאל
2. **Mobile First** - responsive תמיד
3. **TypeScript Strict** - אין `any`, אין `console.log`
4. **Gap Over Margin** - Parent שולט על ריווח
5. **תוכן לא נוגע בבורדר** - padding תמיד!
6. **Touch Target** - מינימום 44x44px
7. **globals.css = תוכן עניינים** - globals.css מכיל רק `@import` (30 שורות מקס). כל CSS בתת-קבצים ב-`app/styles/`. קובץ partial מקסימום 1500 שורות
8. **DRY Components** - מבנה שחוזר → קומפוננטה רוחבית עם props לתוכן/צבעים. אין קוד כפול!
9. **CSS Cleanup** - כשמוחקים/מבטלים אלמנט → תמיד שאל: "למחוק גם את ה-CSS שלו?" אל תשאיר CSS יתום!
10. **ניהול context (קריטי!)** - אחרי כל 2 משימות חייבים להריץ `/compact`. אם המשתמש מסרב - להזהיר: "השיחה תתקע בקרוב ולא יהיה אפשר לשחזר". לפני סגירה - `/end`. **אסור לחכות ל-3+ משימות בלי compact!**

## Minimum Padding (חובה!)
| Element | Minimum |
|---------|---------|
| Button | `px-4 py-2` |
| Card/Container | `p-4` |
| Input | `px-3 py-2` |
| Badge | `px-2 py-0.5` |
| Table Cell | `px-4 py-3` |
| List Item | `p-3` |
| Modal | `p-6` |

```tsx
// ✅ Always
<div className="border p-4">content</div>
<button className="border px-4 py-2">click</button>

// ❌ Never
<div className="border">content</div>
<button className="border">click</button>
```

---

## Ruflo — תמיד פעיל (ALWAYS ON)

**Ruflo/claude-flow v3 הוא שכבת האורקסטרציה הקבועה של כל שיחה.**

| פלטפורמה | אחריות |
|----------|--------|
| 🔵 Claude Code | ארכיטקטורה, אבטחה, בדיקות, code review, PRD |
| 🟢 Codex (OMX) | מימוש, ריפקטורינג, אופטימיזציה, boilerplate |

- כל החלטת ארכיטקטורה → כתוב לזיכרון: `npx claude-flow@v3alpha memory write --namespace collaboration`
- משימות מורכבות → `npx claude-flow-codex dual run --namespace collaboration`
- Swarm → `npx claude-flow@v3alpha swarm run --topology hierarchical --max-agents 8`
- תמיד `doctor --fix` לפני swarm
- `/ruflo` לטעינת הסקייל המלא

---

## OMX Runtime (ברירת מחדל תפעולית)
- `omx` מריץ את Codex תחת `oh-my-codex`
- עבודה רחבה, רב-קובצית, refactor, debug ארוך או handoff-heavy: ברירת המחדל היא `omx team`
- `om "<task>"` הוא ה־shortcut הראשי: `omx team 3:executor "<task>"`
- `/prompts:planner`, `/prompts:architect`, `/prompts:executor`, `/prompts:verifier` הם משטחי העבודה הדיפולטיים של OMX
- `omd` מפעיל `omx doctor --team`
- `omx team status <team>`, `omx team resume <team>`, `omx team shutdown <team>` הם כלי הבקרה
- לא מריצים `omx agents-init .` בפרויקט KIT רגיל; התבניות של ה־KIT הן ה־source of truth ל־`CLAUDE.md` ו־`AGENTS.md`

---

## Agents & Skills

**מקור-אמת יחיד:** בחירת agent, decision trees, task decomposition, וקטלוג מלא של כל ה-skills/agents — טען `/master`.

- כל ה-skills זמינים אוטומטית כ-`/<name>` (auto-discovery) — לדוגמה `/design`, `/api`, `/security`, `/qa`, `/ruflo`.
- כל ה-agents זמינים דרך כלי ה-Task (Design, API, Security, QA, Fullstack, Ruflo, ועוד).
- הרשימה החיה המלאה נוצרת אוטומטית ב-`/master` (`gen-catalog.sh`) — לעולם לא ידנית, לעולם לא מתיישנת.
- **מינימליזם בזמן כתיבה:** `/ponytail` (lazy-senior-dev, YAGNI ladder, מצבי lite/full/ultra/off — plugin חי, ברירת מחדל full) משלים את כללי הברזל #2/#10/#11. ביקורת: `/ponytail-review` (diff), `/ponytail-audit` (ריפו).
- **אורקסטרציה דטרמיניסטית למשימות ארוכות:** `/babysitter` (a5c-ai) — process-as-code, breakpoints לאישור אדם, journal ב-`~/.a5c/runs` (resume אחרי קריסה). פקודות plugin: `/babysitter:call|plan|yolo|resume|doctor`.

---

## Recommended Dependencies (Standard Stack)

Every CRM/Dashboard/Web project should include these libraries. Install with `--full` flag in `new-project`.

### Tier 1 — חובה (כל פרויקט)

```bash
pnpm add @tanstack/react-table @tanstack/react-query recharts \
  react-hook-form @hookform/resolvers zod nuqs
```

| Library | Purpose | RTL |
|---------|---------|-----|
| `@tanstack/react-table` | Headless tables — sorting, filtering, pagination. Shadcn DataTable built on it. | Headless = full RTL control |
| `@tanstack/react-query` | Server state — cache, background refresh, loading/error. Every Supabase fetch. | N/A |
| `recharts` | Charts for dashboards. Shadcn Chart component built on it. | `direction="rtl"` |
| `react-hook-form` + `@hookform/resolvers` | Form state. Shadcn Form built on it. Minimal re-renders. | N/A |
| `zod` | Schema validation — forms, Server Actions, API. | N/A |
| `nuqs` | URL state — filters, search, pagination as URL params. | N/A |

### Tier 2 — מומלץ

```bash
pnpm add zustand next-safe-action @formkit/auto-animate sonner cmdk
```

| Library | Purpose |
|---------|---------|
| `zustand` | Client state (~1KB) — sidebar, wizard, UI toggles. Replaces Context bloat. |
| `next-safe-action` | Type-safe Server Actions with Zod validation + middleware (auth, rate-limit). |
| `@formkit/auto-animate` | One hook, zero config — auto-animates DOM additions/removals (~2KB). |
| `sonner` | Toast notifications — already used in pye9/synthesis. |
| `cmdk` | Command palette (⌘K) — quick search in any CRM. |

### Tier 3 — לפי צורך

| Library | When |
|---------|------|
| `@react-pdf/renderer` | PDF generation (invoices, reports) — JSX → PDF with Hebrew fonts |
| `ai` (Vercel AI SDK) | AI chat interface — `useChat`, streaming, multi-provider |
| `uploadthing` | File uploads — full-stack (S3 + validation + webhooks) |
| `@dnd-kit/core` + `@dnd-kit/sortable` | Drag-and-drop, Kanban boards |
| `next-intl` | Full i18n (Hebrew + English + Arabic) |
| `react-resizable-panels` | Split views, resizable sidebars |
