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

## Concurrency — עבודה במקביל על אותו ריפו

**לפני `git add <file>` — בדוק אם הקובץ כבר `M` משינוי שאינו שלך. אם כן — staging של hunks בלבד (`git add -p`, או patch/`update-index` ל-index), לעולם לא הקובץ כולו.**

למה: יותר מסוכן פועל על אותו working tree. `git add <file>` מקמט את **כל תוכן הקובץ** — כולל שינויים לא-מקומטים של מישהו אחר. כך קומיט "שלי" בלע עבודת CVV/PSP זרה, וה-PR הפסיק להיבנות לבד (ייבוא שהוגדר רק בקובץ לא-מקומט).

- `git status --porcelain -- <file>` לפני כל staging. ` M` = יש שם עבודה זרה.
- לעולם לא `git add -A` / `git add .` בריפו משותף.
- אחרי הקומיט: אמת בנייה נקייה ב-worktree מבודד (`git worktree add … <sha>` + install/typecheck/build) — הבנייה המקומית ירוקה גם כשהיא נשענת על קבצים לא-מקומטים ולכן לא מוכיחה כלום.
- בספק לגבי בעלות על שינוי — דווח, אל תקמט.

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
| Channels | ספק פעיל אחד בכל רגע (beds24 ברירת מחדל; Channex, Hospitable) · PM2 channel worker |
| Runtime | dev + prod תחת pm2, פורט 3007 · prod נפרד: `/var/www/guesthub-production` (`PROD_DEPLOY_OK=1 npm run deploy:prod`) |
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

## 📚 מדריכים לפי נושא

טען את המדריך הרלוונטי לפי הצורך (נוצר אוטומטית — 92 skills, 45 agents):

| Skill | תיאור |
|------|------|
| **מצב הפרויקט** | `@PROJECT.md` |
| `/agent-browser` | Browser automation CLI for AI agents (vercel-labs/agent-browser) — drives headless Chrome… |
| `/agent-reach` | Give agents read+search access to the wider internet through one CLI… |
| `/agent-skills-2026` | Agent Skills 2026 master skill — loads Code Reviewer, Excalidraw diagram generator, Google… |
| `/agent-zero` | Deploy & manage Agent Zero (agent0ai) — an autonomous, "organic" multi-agent framework that… |
| `/agentmemory` | Deploy & manage AgentMemory (rohitg00) — a rich LOCAL memory service for AI coding agents… |
| `/anthropic-skills` | Anthropic official skills suite — master skill loading MCP Builder, Skill Creator, Doc… |
| `/api` | Backend & API development guidelines for Next.js 15 - Route handlers, Server Actions,… |
| `/architecture` | Chat Style Architecture - VSCode Claude Code panel CSS layout and flow for applying custom… |
| `/babysitter` | Babysitter (a5c-ai/babysitter) — deterministic orchestration layer over AI coding agents. |
| `/big-calendar` | React Big Calendar patterns for Hebrew RTL scheduling UIs - לוח שנה, אירועים,… |
| `/charts` | Recharts patterns for Hebrew RTL dashboards - graphs, charts, data visualization with… |
| `/cli-anything` | CLI-Anything — מסגרת להפיכת תוכנה בעלת source code ל-CLI agent-native. |
| `/clone-website` | AI Website Cloner — reverse-engineers any website into a pixel-perfect Next.js clone using… |
| `/code-reviewer` | Automated code quality review — identifies unnecessary complexity, duplicated logic, SRP… |
| `/codebase-memory` | Code-intelligence memory MCP (DeusData/codebase-memory-mcp, MIT) — indexes a repo into a… |
| `/codex` | OpenAI Codex CLI (@openai/codex) under the oh-my-codex (omx) runtime — the 🟢 implementation… |
| `/components` | Extended UI components library - complex patterns, forms, tables, modals, and reusable… |
| `/content` | Hebrew content & copywriting guidelines - UI copy, marketing text, SEO content, and proper… |
| `/contentmaster` | ContentMaster 2026 Agent - Advanced AI content automation for creating SEO-optimized,… |
| `/cost-optimization` | Claude API & Infrastructure Cost Optimization - model selection, token budgeting, caching… |
| `/creative-stack` | The kit's design+media stack — the external sources a coding agent cannot invent on its own. |
| `/dependency-auditor` | Multi-language dependency audit — CVE scanning, license compliance, outdated packages,… |
| `/deployment-guide` | Claude Code Chat Style Deployment Guide - מדריך התקנה להטמעת עיצוב CSS מותאם לפנל Claude… |
| `/design` | UI/UX guidelines - Spacing system, colors, typography, RTL layout, Tailwind v4 and modern… |
| `/design-pro` | Full-stack Design Intelligence — מאגד את כל skills העיצוב במערך אחד. |
| `/devtools` | Development utilities & scripts - Bash commands, Git shortcuts, Docker helpers, debugging… |
| `/doc-coauthoring` | Structured 3-stage workflow for co-authoring documentation, proposals, technical specs,… |
| `/docker-dev` | Docker optimization and security — Dockerfile optimization for size/speed/layers,… |
| `/end` | End of Day - summarize work, update docs, commit, plan next session |
| `/engineering-pro` | 'Engineering Pro — Master skill that loads all 7 engineering excellence skills: skill… |
| `/excalidraw` | Generate publication-ready architecture diagrams from natural language descriptions using… |
| `/features` | Ready-made feature patterns and components - Icons, Authentication, Dashboard, CRUD,… |
| `/figma` | Figma MCP integration - Extract designs, tokens, components, screenshots. |
| `/frontend-design` | Create distinctive, production-grade frontend interfaces with high design quality. |
| `/fullstack-il` | Israeli Fullstack Guidelines - Next.js 15, Tailwind v4, RTL, Hebrew. |
| `/gsd` | Get Shit Done - Meta-prompting system for structured, spec-driven development with Claude Code. |
| `/gws` | Google Workspace orchestration via MCP tools — Gmail, Google Calendar, Drive, Docs, Sheets. |
| `/hermes` | Deploy and manage a self-hosted Hermes Agent (Nous Research) Docker container —… |
| `/hermes-dashboard` | Deploy & operate Hermes Dashboard Hub (chrisryugj/hermes-dashboard) — a lightweight… |
| `/hermes-workspace` | Deploy & run Hermes Workspace (outsourc-e) — a web + Electron control plane that sits ON… |
| `/incident-commander` | Incident response framework for production outages — severity classification, timeline… |
| `/init` | Initialize or update project documentation (CLAUDE.md, PROJECT.md) based on codebase analysis |
| `/kanban` | Kanban dispatch board patterns — multi-container drag-and-drop עם @dnd-kit, שיבוץ בגרירה,… |
| `/keyboard-shortcuts` | Complete keyboard shortcuts & tooltips system for Next.js/React apps — ShortcutDef types,… |
| `/manychat` | ManyChat Infrastructure Template - Server-side orchestration, WhatsApp/IG chatbot, state… |
| `/mcp-builder` | Guide for building MCP (Model Context Protocol) servers — integrates external APIs/services… |
| `/migrations` | Supabase Database Migrations - CLI workflow, safe schema changes, rolling migrations,… |
| `/mission-control` | Deploy & operate Mission Control (builderz-labs) — a self-hosted Next.js dashboard for… |
| `/mobile` | Responsive Adaptation - Makes pages/components fully responsive across 9 screen sizes from… |
| `/monitoring` | Error Monitoring & Alerting - Sentry + Next.js 15, Better Stack, Error Boundaries,… |
| `/nano-banana` | Generate images with the Gemini API and turn them into TRANSPARENT PNGs for websites and… |
| `/native` | React Native & Expo development - Monorepo architecture, code sharing between web and… |
| `/no-mistakes` | Pre-push AI quality gate (kunchenguid/no-mistakes, MIT) — a local git proxy. |
| `/observability` | Production observability design — SLI/SLO/SLA frameworks, error budgets, multi-window burn… |
| `/openwa` | Deploy & operate OpenWA (rmyndharis/OpenWA) — a self-hosted WhatsApp API gateway (NestJS +… |
| `/optimization` | Performance optimization - Caching strategies, Core Web Vitals, bundle optimization for… |
| `/parallel-strategy` | Parallel Agents Strategy - מדריך מקיף לעבודה עם סוכנים מקבילים ב-Claude Code, מתי לחלק ומתי לא. |
| `/patterstage` | Deploy & operate PatterStage "Control Hub" (Daniel-Parke/PatterStage) — a Next.js web… |
| `/pentest` | Authorized AI penetration testing framework — systematic vulnerability testing across OWASP… |
| `/pexels` | Pexels — free royalty-free 4K stock video (B-roll) and photos for the agent to pull… |
| `/ponytail` | Ponytail — "lazy senior dev" generation-time minimalism (DietrichGebert/ponytail, vendored… |
| `/ponytail-audit` | Ponytail Audit — scan the WHOLE repository (not just a diff) for over-engineering, ranked… |
| `/ponytail-review` | Ponytail Review — scan the CURRENT diff for over-engineering only (not correctness) and… |
| `/prd` | Product Requirements Document generator - Creates structured PRDs with user stories,… |
| `/qa` | QA Testing methodology with Playwright MCP. |
| `/ralph` | Autonomous AI agent loop that runs Claude Code repeatedly until all PRD items are complete. |
| `/remotion` | Remotion - Video creation in React. |
| `/review-all` | Complete project review orchestrator - runs Code Review + UI/UX Review + QA Testing in… |
| `/ruflo` | Ruflo / claude-flow v3 — Dual-Mode AI Orchestration (Claude Code + Codex). |
| `/scale` | The kit's three-tier model-routing policy ("the perfect scale") — 🔵 Fable 5… |
| `/security` | Security guidelines - Authentication, RLS policies, input validation, OWASP best practices… |
| `/self-improving` | Memory lifecycle management — promote proven patterns from MEMORY.md to CLAUDE.md rules,… |
| `/side-panel` | Side Panel Pattern — מחליף את כל הפופאפים/מודאלים בפאנל צדדי RTL שנפתח מצד שמאל ותופס 55%… |
| `/simplex` | Deploy a private, metadata-free ops-alert bot on SimpleX Chat (simplex-chat/simplex-chat,… |
| `/site-health` | End-to-end site monitoring + self-heal for every app on a server — probes each site through… |
| `/skill-creator` | Meta-skill for creating, evaluating, and improving Claude Code skills. |
| `/skill-security-auditor` | Security audit for AI skills before installation — scans for command injection, prompt… |
| `/spec-driven` | Spec-first development workflow — no code without approved spec. |
| `/supabase-cli` | Operate the official Supabase CLI (supabase/cli) — link projects, run DB migrations… |
| `/supabase-mcp` | Register & operate the official Supabase MCP server (@supabase/mcp-server-supabase) so… |
| `/supabase-oauth-nextjs` | Next.js 15 + Supabase OAuth Integration - PKCE flow, cookies, and auth state management. |
| `/superpowers` | Guide for using obra/superpowers skills framework - systematic debugging, TDD,… |
| `/ui-details` | Small UI details that make interfaces feel polished and professional. |
| `/ui-ux-pro-max` | Advanced UI/UX design intelligence for complex interfaces. |
| `/uiux-review` | Visual UI/UX review - RTL, spacing, typography, colors, consistency, responsive, accessibility. |
| `/utilities` | CRM utilities - Push notifications, context menus, email notifications, followups, activity… |
| `/vercel-composition-patterns` |  |
| `/vercel-react-best-practices` | React and Next.js performance optimization guidelines from Vercel Engineering. |
| `/vercel-react-native-skills` |  |
| `/web-artifacts-builder` | Build elaborate multi-component HTML artifacts using React 18 + TypeScript + Vite +… |
| `/webapp-testing` | Playwright-based toolkit for testing and interacting with local web applications — server… |
| `/workflows` | n8n automation - Webhooks, integrations, workflow patterns and automation best practices. |

## 🤖 סוכנים זמינים

| סוכן | קובץ | תפקיד |
|------|------|------|
| API Agent | `@.claude/agents/api.md` | Backend & Data Expert - Next.js, Supabase |
| Agent Browser | `@.claude/agents/agent-browser.md` | CLI Browser Automation Expert (vercel-labs/agent-browser) - headless Chrome from the shell… |
| Agent Skills 2026 | `@.claude/agents/agent-skills-2026.md` | Agent Skills 2026 — handles code quality review, Excalidraw architecture diagrams, Google… |
| Agent Zero | `@.claude/agents/agent-zero.md` | Deploy & manage Agent Zero (agent0ai) — autonomous multi-agent Docker platform with code… |
| AgentMemory | `@.claude/agents/agentmemory.md` | Deploy & operate AgentMemory (rohitg00) — a rich LOCAL agent-memory service (npm/CLI). |
| Animation Agent | `@.claude/agents/animations.md` | Motion & Animation Expert - GSAP Full Club, Framer Motion, ScrollTrigger |
| Anthropic Skills | `@.claude/agents/anthropic-skills.md` | Anthropic Official Skills Agent — handles MCP server development, skill… |
| Babysitter | `@.claude/agents/babysitter.md` | Deterministic-orchestration specialist for babysitter (a5c-ai/babysitter) — designs… |
| CLI-Anything Agent | `@.claude/agents/cli-anything.md` | Software → Agent-Native CLI Generator - הופך כל תוכנה בעלת source code ל-CLI מובנה עבור AI… |
| Calendar Agent | `@.claude/agents/calendar.md` | Scheduling & Calendar Expert - React Big Calendar, ניהול אירועים, RTL, drag-and-drop,… |
| Clone Website Agent | `@.claude/agents/clone-website.md` | AI Website Cloner — Reverse-engineers any website into a pixel-perfect Next.js clone using… |
| Codex | `@.claude/agents/codex.md` | OpenAI Codex CLI (@openai/codex) under the oh-my-codex (omx) runtime — the 🟢 implementation… |
| Content Agent | `@.claude/agents/content.md` | Hebrew Content Expert - Copy, Landing Pages |
| Creative Stack | `@.claude/agents/creative-stack.md` | Design & media sourcing specialist — wires the external content sources a coding agent… |
| Design Agent | `@.claude/agents/design.md` | UI/UX Build Expert - Creates components, pages, and layouts with Tailwind, RTL, and… |
| Engineering Pro | `@.claude/agents/engineering-pro.md` | Engineering Excellence Agent — handles security audits, incident response, observability… |
| Figma Agent | `@.claude/agents/figma.md` | Figma-to-Code Expert - Extracts designs, tokens, and components from Figma via MCP and… |
| Fullstack Agent | `@.claude/agents/fullstack.md` | Complete Project Expert - All Skills |
| Hermes | `@.claude/agents/hermes.md` | Deploy & manage self-hosted Hermes Agent (Nous Research) Docker containers — gateway API,… |
| Hermes Dashboard | `@.claude/agents/hermes-dashboard.md` | Deploy & operate Hermes Dashboard Hub (chrisryugj/hermes-dashboard) — a lightweight… |
| Hermes Workspace | `@.claude/agents/hermes-workspace.md` | Deploy & run Hermes Workspace (outsourc-e) — web + Electron control plane over the Nous… |
| Kanban Agent | `@.claude/agents/kanban.md` | Kanban Dispatch Board Expert - לוחות שיבוץ עם גרירה (dnd-kit multi-container), order_index… |
| ManyChat Agent | `@.claude/agents/manychat.md` | ManyChat Infrastructure Expert - Server-side chatbot orchestration, WhatsApp/IG flows,… |
| Mission Control | `@.claude/agents/mission-control.md` | Deploy & operate Mission Control (builderz-labs) — self-hosted Next.js dashboard for… |
| Mobile Agent | `@.claude/agents/mobile.md` | Responsive Adaptation Expert - Makes every page/component fully responsive across 9 screen… |
| Native Agent | `@.claude/agents/native.md` | React Native & Expo Expert - Native mobile app development with Monorepo architecture |
| OpenWA | `@.claude/agents/openwa.md` | Deploy & operate OpenWA (rmyndharis/OpenWA) — a self-hosted WhatsApp API gateway (NestJS +… |
| Patterstage | `@.claude/agents/patterstage.md` | Deploy & operate PatterStage "Control Hub" (Daniel-Parke) — a Next.js web command-center… |
| Performance Agent | `@.claude/agents/performance.md` | Optimization Expert - Web Vitals, Caching |
| Ponytail | `@.claude/agents/ponytail.md` | Ponytail — the "lazy senior dev" minimalism reviewer (DietrichGebert/ponytail, vendored &… |
| QA Agent | `@.claude/agents/qa.md` | Automated Testing Expert - Browser automation, E2E testing, QA reports |
| Remotion Agent | `@.claude/agents/remotion.md` | Video creation expert with React + Remotion. |
| Ruflo Orchestrator Agent | `@.claude/agents/ruflo.md` | Dual-Mode AI Orchestrator — coordinates Claude Code (🔵) + Codex (🟢) via Ruflo/claude-flow v3. |
| Scale | `@.claude/agents/scale.md` | Three-tier model-routing specialist ("the perfect scale", iron-rule #14) — classifies every… |
| Security Agent | `@.claude/agents/security.md` | Application Security Expert - Auth, RLS |
| Site Health | `@.claude/agents/site-health.md` | Uptime & self-heal expert — deploys and operates the site-health mechanism (DB-touching… |
| Supabase CLI | `@.claude/agents/supabase-cli.md` | Operate the Supabase CLI (supabase/cli) fleet-wide — link projects, run DB migrations… |
| Supabase MCP | `@.claude/agents/supabase-mcp.md` | Register & operate the official Supabase MCP server (@supabase/mcp-server-supabase) for… |
| UI/UX Review Agent | `@.claude/agents/uiux-review.md` | Visual Quality Expert - Reviews existing UI for design consistency, RTL, spacing,… |
| agent-reach | `@.claude/agents/agent-reach.md` | Deploy & operate Agent-Reach (Panniantong/Agent-Reach, MIT) — a one-CLI capability layer… |
| codebase-memory | `@.claude/agents/codebase-memory.md` | Operate codebase-memory-mcp (DeusData/codebase-memory-mcp, MIT) — the code-structure memory… |
| fs-dev | `@.claude/agents/hebrew-fullstack-dev.md` | Use this agent when working on Next.js/React projects that require Hebrew communication,… |
| n8n Agent | `@.claude/agents/n8n.md` | Automation & Workflows Expert |
| no-mistakes | `@.claude/agents/no-mistakes.md` | Operate no-mistakes (kunchenguid/no-mistakes, MIT) — the pre-push AI quality gate. |
| simplex | `@.claude/agents/simplex.md` | Deploy & operate a private, metadata-free SimpleX ops-alert bot (simplex-chat/simplex-chat,… |
