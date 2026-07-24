# GuestHub — Secret Handling

- **Status:** Complete — Stage 6 · **Date:** 2026-07-18 · **Branch:** `feat/pms-hardening-channex-certification`
- This is a PUBLIC repo — this document names no secret values.

Where every secret lives, how it is encrypted, its blast radius, and how it rotates.

## Secret inventory

| Secret | Purpose | Store | Vault / key | Blast radius | Rotation |
|---|---|---|---|---|---|
| `CARD_VAULT_KEY` | encrypt reservation card PANs | env (never DB) | `card-vault.ts`, AES-256-GCM, key=SHA-256(env) | stored PANs (now retention-bounded, H8) | versioned ciphertext (`key_version`); re-encrypt on rotate |
| `CHANNEL_SECRETS_KEY` | encrypt Beds24 API keys | env | `channel/crypto.ts`, AES-256-GCM | tenant channel credentials | re-encrypt tenant rows on rotate |
| `MESSAGING_SECRETS_ENCRYPTION_KEY` | encrypt messaging provider secrets | env | `messaging/secrets.ts`, AES-256-GCM | messaging provider tokens | re-encrypt on rotate |
| Supabase anon key | browser session auth | env | — (public-scope key) | session only | Supabase rotation |
| Supabase service-role key | GoTrue admin user ops | env, server-only | — | GoTrue admin (staff user ops) | Supabase rotation |
| `db.bios.co.il` / DB DSNs | DB access | `.env.local` (gitignored) / `.env.staging` | — | per-role (least-privilege app role) | rotate role passwords |
| Beds24 webhook token | inbound webhook auth | DB `webhook_token_hash` | SHA-256 (hash only) | one connection's inbound | reissue token |
| backup encryption key | encrypt nightly dumps | `/home/ubuntu/.guesthub-backup-key` (chmod 600) | AES-256 | backups | rotate + re-encrypt |

## Standards (enforced)

- **No secret in code, history, or logs** — `check:no-secrets` (tree + full git history; encryption/activation env vars never hardcoded).
- **Encryption at rest** — three separate AES-256-GCM vaults keyed from env, never the DB, each `server-only`, fail-closed (a missing key throws — no plaintext fallback), fresh 96-bit IV, versioned ciphertext.
- **CVV never stored** (migration 018 dropped the column entirely).
- **PAN retention bounded** — `purge_expired_cards` removes PAN ciphertext >90d post-stay (H8, migration 043), shrinking PCI scope.
- **API keys travel only in headers** — never a URL, query, log, or audit payload (`check:channel-security`).
- **Backups encrypted** — nightly dumps are AES-256 with the key in separate custody (Stage 2, H4); off-host destination is the one remaining Stage-2 open item (below).
- **Least-privilege DB role** — the app uses `guesthub_app` (DML-only), not a superuser or service_role, for domain work.

## Key rotation procedure (per vault)

1. Provision the new key in the environment as `<KEY>_NEXT` (deployment concern).
2. Re-encrypt: read each ciphertext with the current key, write with the new key, bump `key_version` (card vault supports this natively).
3. Promote `<KEY>_NEXT` → `<KEY>`; retire the old key from custody.
4. Verify: `check:no-secrets` + a decrypt smoke on staging.

## Residual (documented, accepted)

| Item | Severity | Plan |
|---|---|---|
| Off-host backup destination + key custody | Medium | No off-host target exists on the host; local encrypted backup + restore drill are in place; `BACKUP_OFFHOST_CMD` hook warns when unset. User provides destination at/before production cutover (Stage 2 deferral). |
| GREEN-API webhook token stored in provider config (messaging) | Medium | Messaging module; move to the hashed-token model like the Beds24 channel when the messaging surface is next touched. Not on the reservation/card critical path. |
| Operator-controlled provider base host (messaging SSRF surface) | Low | Constrain to an allowlist when the messaging surface is next touched. |
| `CARD_VAULT_KEY` automated rotation tooling | Low | `key_version` supports it; the procedure above is manual until a rotation cadence is required. |

## Verified by
`check:no-secrets`, `check:supply-chain`, `check:channel-security`, `check:retention`, `check:cards`.
