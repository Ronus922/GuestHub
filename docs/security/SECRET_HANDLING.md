# GuestHub — Secret Handling

- **Status:** Skeleton — Stage 1; current-state from the threat model, completed in **Stage 6**
- **Date:** 2026-07-18
- **Branch:** `feat/pms-hardening-channex-certification`
- **Sources:** `docs/security/THREAT_MODEL.md` (§1 secrets, Asset B/C, F4/F6/F7), `docs/audit/ARCHITECTURE_INVENTORY.md` (§9), `docs/audit/PAYMENTS_AUDIT.md` (§2)

Where every secret lives, how it is encrypted, its blast radius, and rotation. This is a PUBLIC repo — this document names no secret values.

## Current state

Secrets at rest use AES-256-GCM vaults keyed from env, never from the DB, across **three separate blast radii**: card PAN (`src/lib/card-vault.ts`, `CARD_VAULT_KEY`), messaging provider secrets (`src/lib/messaging/secrets.ts`, `MESSAGING_SECRETS_ENCRYPTION_KEY`), and channel/Channex secrets (`src/lib/channel/crypto.ts`, `CHANNEL_SECRETS_KEY`) (`THREAT_MODEL.md` §1; `ARCHITECTURE_INVENTORY.md` §9). The card vault is exemplary: `server-only`, fresh 96-bit IV, key = SHA-256(env), **fail-closed** (missing key throws, no plaintext fallback), versioned ciphertext for rotation, and **CVV never stored** (`THREAT_MODEL.md` Asset B; `PAYMENTS_AUDIT.md` §2, H-11). GoTrue uses an anon key (session) plus a service-role key for admin user ops, well-contained to staff actions (`THREAT_MODEL.md` Asset C, F7). Webhook auth: Channex stores only a `webhook_token_hash` (SHA-256), Twilio adds HMAC-SHA1.

Weaknesses seeded for Stage 6: the **GREEN-API webhook token is stored plaintext** in `config->>'webhookToken'` and is the sole authenticator — inconsistent with the Channex hashed-token model (F4); the provider **base host is operator-controlled** with the apiToken placed directly in the URL path (SSRF/exfil, F6); the service-role key is full GoTrue admin (total blast radius if leaked, F7). No key-rotation tooling exists for `CARD_VAULT_KEY` despite `key_version` support (`PAYMENTS_AUDIT.md` H-2). Backup exposure: nightly plaintext SQL dumps sit same-host alongside the `.env.local` that holds the decryption keys — a single host compromise takes data, backups, and keys together (`ARCHITECTURE_INVENTORY.md` Finding #5). `.env.local` contents were not read in Stage 1 (confirmed git-ignored/untracked, `THREAT_MODEL.md` §6).

## Target state (per TARGET_ARCHITECTURE.md, ADR-0002)

- No secrets in code/history/logs — enforced by `check:no-secrets` (`TARGET_ARCHITECTURE.md` §5).
- Backups encrypted, off-host, key custody separated from data (Stage 2 runbook, ADR-0002; the exact off-host destination + key custody are a Stage-2 open decision).
- GREEN-API token hashed like Channex (F4); service-role blast radius reviewed (F7).
- Key-rotation procedure for the three vaults (Stage 6).

## To be completed in Stage 6

- [ ] Secret inventory table (name → purpose → store → vault/key → blast radius → rotation).
- [ ] Encryption-at-rest standard across the three vaults.
- [ ] GREEN-API token hashing fix (F4) and operator-host SSRF mitigation (F6).
- [ ] Key-rotation procedure per vault (incl. `CARD_VAULT_KEY` `key_version`).
- [ ] Backup encryption + off-host + key-custody decision (from Stage 2).
- [ ] `check:no-secrets` coverage statement.
