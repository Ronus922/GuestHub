# GuestHub — Security Test Report

- **Status:** Skeleton — Stage 1; completed in **Stage 6**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/security/THREAT_MODEL.md`, `docs/audit/ARCHITECTURE_INVENTORY.md` (Findings), `docs/architecture/TARGET_ARCHITECTURE.md` (§3 Stage 6)

The results of the Stage-6 red-team review: findings, exploitation attempts, resolutions, and residual risk. This document records **test outcomes**; the design-level threat model is `THREAT_MODEL.md` (already delivered, Stage 1).

## Current state

Stage 1 produced a design-level threat model only — no exploitation, no attack traffic, no fixes (`THREAT_MODEL.md` §Scope). Its severity-ranked findings are the starting backlog for Stage 6 testing: **F1 Critical** environment crossover (dev checkout can point at the prod DB); **F2 High** no RLS / DB-level tenant backstop (isolation is 100% application-layer); **F3 Medium** no app-layer login rate-limit/lockout; **F4 Medium** GREEN-API webhook token plaintext at rest and sole authenticator; **F5 Medium** admin/super_admin bypass all granular permissions + thin auth on `*-admin.ts` helpers (confirm none unauthenticated-reachable); **F6–F9 Low** SSRF/token-exfil via operator host, service-role blast radius, error-object logging, client `dangerouslySetInnerHTML` coupling. Confirmed strengths to preserve: no string-concatenated SQL, zero `console.log`, `npm audit --omit=dev` = 0 vulnerabilities, escape-first renderer, upload magic-byte validation, fail-closed card vault, Twilio HMAC (`THREAT_MODEL.md` §4, §5). Additional architecture-layer criticals to test: C2 DB exposure past UFW (`ARCHITECTURE_INVENTORY.md` Finding #2).

Explicitly deferred from Stage 1 to the Stage-6 red team: live GoTrue auth behavior (lockout, password policy, token lifetime), runtime reachability of `*-admin.ts` helpers, multi-process webhook rate-limit behavior, and backup at-rest exposure of `config` JSON secrets (`THREAT_MODEL.md` §6).

## Target state (per TARGET_ARCHITECTURE.md §3 Stage 6)

- Full red-team resolving Critical/High findings in touched areas + supply chain.
- DB exposure hardening (C2); environment crossover resolved structurally by Stage 2 clusters (F1).
- Load tests at 13-room and 100-room fixtures incl. DST dates.
- Every finding: reproduced, resolved or accepted, with residual-risk note.

## To be completed in Stage 6

- [ ] Test methodology + scope + tooling.
- [ ] Per-finding results table (F1–F9 + C2): reproduced? resolution? residual risk?
- [ ] Deferred-item outcomes (GoTrue lockout, `*-admin.ts` reachability, multi-process rate-limit, backup secret exposure).
- [ ] Supply-chain audit results.
- [ ] Load/performance-under-attack results.
- [ ] Sign-off + accepted-risk register.
