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

> **worktrees — אסור ללא בקשה מפורשת:** אסור ליצור, להשתמש או להציע git worktree אלא אם רונן ביקש זאת במפורש בבקשה הנוכחית. עבודה נעשית על branch ישירות ב-`/var/www/guesthub`. בתיקיית הפרודקשן אסור `next dev` ואסור `pnpm build` (שניהם דורסים את `.next` החי) — build רק דרך `PROD_DEPLOY_OK=1 npm run deploy:prod` ובאישור רונן. אימות לפני deploy: `tsc --noEmit` + lint + הוכחת קוד; בדיקה ויזואלית — אחרי deploy, עם rollback מוכן. (D147)

## Concurrency — עבודה במקביל על אותו ריפו

**לפני `git add <file>` — בדוק אם הקובץ כבר `M` משינוי שאינו שלך. אם כן — staging של hunks בלבד (`git add -p`, או patch/`update-index` ל-index), לעולם לא הקובץ כולו.**

למה: יותר מסוכן פועל על אותו working tree. `git add <file>` מקמט את **כל תוכן הקובץ** — כולל שינויים לא-מקומטים של מישהו אחר. כך קומיט "שלי" בלע עבודת CVV/PSP זרה, וה-PR הפסיק להיבנות לבד (ייבוא שהוגדר רק בקובץ לא-מקומט).

- `git status --porcelain -- <file>` לפני כל staging. ` M` = יש שם עבודה זרה.
- לעולם לא `git add -A` / `git add .` בריפו משותף.
- אחרי הקומיט: אמת בנייה נקייה ב-worktree מבודד (`git worktree add … <sha>` + install/typecheck/build) — הבנייה המקומית ירוקה גם כשהיא נשענת על קבצים לא-מקומטים ולכן לא מוכיחה כלום.
- בספק לגבי בעלות על שינוי — דווח, אל תקמט.

> הבית הקנוני של הסעיף הזה הוא CLAUDE.md (בריפו). העותק ב-AGENTS.md נמחק ע"י רגנרציית `gen-catalog.sh` (התבנית ב-hub `ai2u-vs1` לא כוללת אותו — ראה DECISIONS D90); `check:agents-concurrency` מתריע אם זה קורה שוב.

## Production Runtime — העץ הרץ הוא פרודקשן בלבד (מ-2026-07-24)

`/var/www/guesthub` מסומן `.production-runtime`: מוגש מ-`main`, מתעדכן אך ורק
דרך `PROD_DEPLOY_OK=1 npm run deploy:prod`. מ-D147 (2026-08-14) עבודה נעשית על
branch ייעודי ישירות בעץ הזה (worktree — רק בבקשה מפורשת של רונן), התיקייה
חוזרת ל-`main` בסוף הריצה, והשינוי מגיע לפרודקשן רק דרך PR ל-main + הדפלוי
הקנוני. `pnpm build` ידני בעץ המסומן נחסם ע"י prebuild-guard (fail-closed,
בכוונה) — build רק דרך סקריפט ה-deploy.

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

## GuestHub — עובדות פרויקט (עודכן /init 2026-07-20)

**PMS מרובה-דיירים בעברית (RTL) לניהול מלון דירות.** מקורות אמת: `PROJECT_OVERVIEW.md` (ספסיפיקציה), `DESIGN_SYSTEM.md` + `GUIDELINES.md` (עיצוב), `STATE.md` (מה קפוא), `DECISIONS.md`, `docs/`.

| שכבה | בפועל |
|------|--------|
| Framework | Next.js 15.5.20 (App Router, RSC + Server Actions, Turbopack) · React 19.1 |
| שפה | TypeScript strict · Node 20 · pnpm 10 |
| UI | Tailwind v4 (`@theme inline` ב-`app/styles/`, אין tailwind.config) · lucide-react · framer-motion · sonner |
| Data | PostgreSQL (schema `guesthub`, 46 מיגרציות ב-`db/migrations/`) דרך porsager `postgres` (`lib/db.ts`) · Supabase Auth self-hosted = **אימות בלבד** |
| טפסים/State | react-hook-form + Zod · nuqs · @tanstack/react-table |
| Channels | ספק יחיד: Beds24 (פרודקשן, poll-based inbound + ARI outbound) · PM2 channel worker |
| Runtime | pm2, פורט 3007 · `/var/www/guesthub` **הוא** עץ הפרודקשן (`.production-runtime`) — ראה פרק Production Runtime; פריסה רק ב-`PROD_DEPLOY_OK=1 npm run deploy:prod` |
| בדיקות | ‎90+ סקריפטי `check:*` ב-package.json (כולל `check:design`, `check:status-default`) · `pnpm typecheck && pnpm lint && pnpm build` בסוף כל שלב |

14 מסכי dashboard (`src/app/(dashboard)/`): calendar, reservations, rates, rate-plans, rooms, guests, channels, communications, settings, staff, permissions, dashboard (+housekeeping/tasks — קפואים, ראה STATE.md). Env (שמות בלבד): DATABASE_URL, SUPABASE_*, CARD_VAULT_KEY, CHANNEL_SECRETS_KEY, MESSAGING_SECRETS_ENCRYPTION_KEY, GOOGLE_MAPS.

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

# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
