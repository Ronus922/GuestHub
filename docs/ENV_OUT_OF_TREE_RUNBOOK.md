# Moving GuestHub secrets out of the deploy tree

**Phase 4.2.** Status: **prepared and proven on staging — NOT cut over.**
Production was not modified. Every step in §5/§6 is for Ronen to run deliberately.

---

## 1. The problem

Both production processes read their secrets from a file **inside the deploy tree**:

| process | how it gets env | evidence |
|---|---|---|
| `guesthub` (web) | `npm start` with `cwd=/var/www/guesthub`; Next.js auto-loads `.env.local` from cwd | `pm2 jlist` → `pm_cwd=/var/www/guesthub` |
| `guesthub-channel-worker` | `--env-file-if-exists=.env.local` | `ecosystem.config.cjs:20` |

Four secret files currently live in the tree (names only; mode `660`, group `devops-www`):

```
/var/www/guesthub/.env.local                      mode=660 ubuntu:devops-www
/var/www/guesthub/.env.local.bak-roles-2026-07-19 mode=660 ubuntu:devops-www
/var/www/guesthub/.env.local.pre-merge.bak        mode=660 ubuntu:devops-www
/var/www/guesthub/.env.staging                    mode=660 ubuntu:devops-www
```

Secrets in the deploy tree are why an ordinary `tar` of the tree swallows them —
all four rollback tarballs in `/home/ubuntu` contain all four files. See
[BACKUP_HYGIENE.md](./BACKUP_HYGIENE.md). Excluding them from backups treats the
symptom; moving them out of the tree removes the class of accident.

The 12 variable **names** defined in production `.env.local` (values never read):

```
APP_PORT                              NEXT_PUBLIC_APP_URL
CARD_VAULT_KEY                        NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY
CHANNEL_SECRETS_KEY                   NEXT_PUBLIC_SUPABASE_ANON_KEY
DATABASE_URL                          NEXT_PUBLIC_SUPABASE_URL
MESSAGING_SECRETS_ENCRYPTION_KEY      PUBLIC_BOOKING_API_SECRET
SUPABASE_ADMIN_URL                    SUPABASE_SERVICE_ROLE_KEY
```

`HYDRATION_*`, `CHECK_*`, `STAGING_*`, `TEST_*` are check-script/staging-only and
are **not** in production `.env.local`. They do not move.

---

## 2. The pattern we are copying

The `billing` project on this host already does this properly:

```
/etc/billing/billing.env            mode=600 root:root
```

wired into `billing.service`:

```ini
[Service]
User=ubuntu
Group=devops-www
EnvironmentFile=/etc/billing/billing.env
```

The comment in `billing-reminders.service` states the mechanism exactly:

> systemd reads this as root and injects BILLING_CRON_SECRET into the env —
> the script never reads the file.

**That is the whole trick.** The privileged reader (pid 1) is not the
unprivileged consumer. This has been prepared identically:

```
/etc/guesthub                       mode=755 root:root
/etc/guesthub/guesthub.env.template mode=600 root:root   # NAMES ONLY, all values blank
```

The template is deliberately **not** named `guesthub.env`, so no loader can pick
up a half-filled file.

---

## 3. Why PM2 cannot reproduce it — measured, not assumed

| claim | command | result |
|---|---|---|
| PM2 has no `env_file` option | `grep -rn env_file /usr/lib/node_modules/pm2/` | no matches (pm2 6.0.14); schema exposes only `env`, `filter_env`, `^env_\S*$`, `append_env_to_name` |
| Node's `--env-file` cannot be injected via environment | `NODE_OPTIONS="--env-file=…" node -e …` | `node: --env-file= is not allowed in NODE_OPTIONS` |
| `--env-file` works only as a direct argv flag | `node --env-file=… -e …` | prints the value — works |
| the PM2 uid cannot read a `root:root 0600` file | `cat /etc/guesthub/probe.env` as `ubuntu` | `NOT READABLE (permission denied)` |
| systemd *can* inject that same file into a `User=ubuntu` unit | `systemd-run --property=User=ubuntu --property=EnvironmentFile=… ` | `ran as uid=ubuntu; GH_SENTINEL=ok-not-a-secret` **and** the process's own `cat` → `Permission denied` |

The last row is the decisive one: under systemd the app gets the variables while
still being **unable to read the file**. Under PM2 something running as `ubuntu`
must read the file itself, so the file must be `ubuntu`-readable.

`pm2-ubuntu.service` exists, but adding `EnvironmentFile=` there is **not** an
option: it runs `pm2 resurrect` for *every* app on this host (`pms`,
`mail-system`, `sys-app`), so GuestHub secrets would be injected into unrelated
projects.

---

## 4. The trade-off — this is a decision, not a default

`scripts/ops/with-guesthub-env.sh` implements the PM2 route (sources the file,
`exec`s the real command, refuses anything looser than `0600`, fail-closed on a
missing file). It is proven working (§7). Both options are viable; they differ in
what they actually buy.

| | **Option A — stay on PM2 + wrapper** | **Option B — move to systemd (billing parity)** |
|---|---|---|
| file location | `/etc/guesthub/guesthub.env` (out of tree ✅) | `/etc/guesthub/guesthub.env` (out of tree ✅) |
| file ownership | **must be `ubuntu:ubuntu 0600`** — the wrapper runs as `ubuntu` and must read it | **`root:root 0600`** — matches `/etc/billing` exactly |
| can the app process read the raw file? | **yes** — so a code-exec bug in the app can exfiltrate the whole file | **no** — proven above |
| solves the backup-swallowing problem? | yes | yes |
| blast radius of the change | small: edit `ecosystem.config.cjs`, re-register the web app, wrap the build | larger: new unit files, `pm2 delete` both apps, `pm2 save`, disable pm2 resurrection for them |
| rollback | trivial (`.env.local` still in tree until you delete it) | moderate (re-register under PM2) |
| operational consistency | GuestHub stays the odd one out | same shape as `billing`, one mental model |
| restart/health semantics | PM2 `max_memory_restart`, `min_uptime`, log rotation already tuned in `ecosystem.config.cjs` | must be re-expressed as `Restart=`, `MemoryMax=`, journald |

## ✅ DECIDED (Ronen, 2026-07-25): **Option A. Option B is NOT scheduled.**

**Option A (PM2 + wrapper) is the chosen path. Option B (systemd) is recorded as a
TARGET STATE, not as a planned second step** — §6 stays in this document as the
description of where we would go if the threat model changes, and must not be read
as "phase two of the cutover". Nothing in §6 is scheduled.

What that decision accepts, stated plainly so it is not rediscovered as a surprise:
Option A gets the secrets **out of the deploy tree**, which is the stated goal and
which closes the tarball exposure. It does **not** buy the confidentiality property.
`/etc/guesthub/guesthub.env` must be `ubuntu:ubuntu 0600` for PM2 to read it, and
that file is therefore readable by every process running as `ubuntu` — i.e. by every
other PM2 app on this box (`sys-app`, `pms`, `mail-system`). Only Option B closes
that, by injecting the values into a process that cannot read the file (measured in
§4: `cat: /etc/guesthub/probe.env: Permission denied`). We are knowingly not closing
it now.

**This run performs NO production cutover.** Scope here is the staging proof plus
this runbook. §5 is written out and verified end-to-end on staging; executing it
against production is a separate, explicitly authorised action.

---

## 5. Cutover — Option A (PM2 + wrapper). NOT YET RUN.

> Prerequisite: a maintenance window. Step 5.4 restarts production.

**5.1 — create the real env file from the template**

```bash
sudo cp /etc/guesthub/guesthub.env.template /etc/guesthub/guesthub.env
sudo chown ubuntu:ubuntu /etc/guesthub/guesthub.env    # Option A requires ubuntu-readable
sudo chmod 600 /etc/guesthub/guesthub.env
sudoedit /etc/guesthub/guesthub.env                    # paste the 12 values from the vault
```

Fill it from the vault, **not** by copying `/var/www/guesthub/.env.local` blindly —
that file also carries stale entries you do not want to carry forward.

**5.2 — verify names loaded, without printing values**

```bash
GUESTHUB_ENV_VERBOSE=1 /var/www/guesthub/scripts/ops/with-guesthub-env.sh true
```

Expect all 12 names listed and `mode 600`.

**5.3 — point the worker at the wrapper**

In `ecosystem.config.cjs`, replace the in-tree env load:

```js
// before
script: "scripts/channel-worker.cjs",
interpreter_args: "--env-file-if-exists=.env.local",

// after
script: "scripts/ops/with-guesthub-env.sh",
args: "node scripts/channel-worker.cjs",
// interpreter_args removed — the wrapper supplies the env
interpreter: "none",
```

**5.4 — rebuild and restart through the wrapper**

⚠ **The build must also go through the wrapper.** The four `NEXT_PUBLIC_*` values
are inlined into the client bundle at *build* time, not read at runtime. Measured
2026-07-25 on the live build:

```
NEXT_PUBLIC_SUPABASE_URL            -> referenced by name in 0 client chunk(s)
NEXT_PUBLIC_APP_URL                 -> referenced by name in 0 client chunk(s)
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY -> referenced by name in 0 client chunk(s)
CARD_VAULT_KEY                      -> referenced by name in 4 server chunk(s)
DATABASE_URL                        -> referenced by name in 8 server chunk(s)
```

Zero name references in `.next/static` means the value was substituted at build
time. If you delete `.env.local` and rebuild *without* the wrapper, the client
bundle silently gets `undefined` for Supabase and Maps — the app builds green and
fails in the browser.

So `scripts/deploy-production.sh` needs its build and start lines wrapped:

```bash
PROD_DEPLOY_OK=1 scripts/ops/with-guesthub-env.sh npm run build
pm2 restart guesthub --update-env          # web app: see 5.5
pm2 startOrRestart ecosystem.config.cjs --only guesthub-channel-worker --update-env
```

**5.5 — the web app needs re-registering (it is not in `ecosystem.config.cjs`)**

`guesthub` was registered by hand as `npm start`. To route it through the wrapper
it must be deleted and re-added once:

```bash
pm2 delete guesthub
pm2 start /var/www/guesthub/scripts/ops/with-guesthub-env.sh \
  --name guesthub --cwd /var/www/guesthub -- npm start
pm2 save --force
```

Note `scripts/deploy-production.sh` asserts `pm_cwd == /var/www/guesthub` for both
apps — `--cwd` above keeps that assertion true.

**5.6 — verify, then and only then retire the in-tree files**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3007/login    # expect <500
pm2 jlist | grep -c guesthub                                            # both online
```

Only after a full business-day soak:

```bash
mkdir -p /home/ubuntu/env-retired && chmod 700 /home/ubuntu/env-retired
mv /var/www/guesthub/.env.local.bak-roles-2026-07-19 /home/ubuntu/env-retired/
mv /var/www/guesthub/.env.local.pre-merge.bak        /home/ubuntu/env-retired/
mv /var/www/guesthub/.env.local                      /home/ubuntu/env-retired/
```

Keep `.env.staging` decision separate — check what consumes it first.
**Move, never delete.** `.env.local` is the only copy of some values.

---

## 6. Cutover — Option B (systemd). NOT YET RUN.

**6.1** Create `/etc/guesthub/guesthub.env` as `root:root 0600` (as §5.1 but
`chown root:root`).

**6.2** `/etc/systemd/system/guesthub.service` — mirrors `billing.service`:

```ini
[Unit]
Description=GuestHub PMS (Next.js)
After=network.target docker.service

[Service]
Type=simple
User=ubuntu
Group=devops-www
WorkingDirectory=/var/www/guesthub
EnvironmentFile=/etc/guesthub/guesthub.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**6.3** `/etc/systemd/system/guesthub-channel-worker.service` — must re-express the
PM2 restart policy that `ecosystem.config.cjs` currently provides
(`min_uptime: 30s`, `max_restarts: 10`, `restart_delay: 5000`, `kill_timeout: 15000`,
`max_memory_restart: 300M`):

```ini
[Unit]
Description=GuestHub channel worker (Beds24)
After=network.target guesthub.service

[Service]
Type=simple
User=ubuntu
Group=devops-www
WorkingDirectory=/var/www/guesthub
EnvironmentFile=/etc/guesthub/guesthub.env
Environment=NODE_ENV=production
Environment=CHANNEL_WORKER_INTERVAL_MS=20000
ExecStart=/usr/bin/node scripts/channel-worker.cjs
Restart=always
RestartSec=5
TimeoutStopSec=15
StartLimitIntervalSec=300
StartLimitBurst=10
MemoryMax=300M

[Install]
WantedBy=multi-user.target
```

**6.4** The build still needs the env (§5.4 applies identically). Under systemd
use the wrapper for the build only, or `set -a; . /etc/guesthub/guesthub.env; set +a`
in a root-run deploy step.

**6.5** Switch over, then update `scripts/deploy-production.sh` to
`sudo systemctl restart guesthub guesthub-channel-worker` and drop the PM2
assertions:

```bash
pm2 delete guesthub guesthub-channel-worker && pm2 save --force
sudo systemctl daemon-reload
sudo systemctl enable --now guesthub guesthub-channel-worker
systemctl status guesthub --no-pager
```

`sudoers` currently grants `NOPASSWD` only for `systemctl restart billing.service`.
An equivalent entry is needed for the GuestHub units or the deploy script cannot
restart them unattended.

---

## 7. What was actually proven (staging only)

Run on `guesthub-staging-db` (127.0.0.1:5434), `cwd=/var/www/wt-env` — a tree with
**no `.env*` file of any kind**:

```
=== 1. wrapper reports NAMES ONLY ===
with-guesthub-env: loaded 7 vars from …/etc-guesthub-staging/guesthub.env (mode 600)
  - CARD_VAULT_KEY
  - CHANNEL_SECRETS_KEY
  - DATABASE_URL
  - GOOGLE_MAPS
  - MESSAGING_SECRETS_ENCRYPTION_KEY
  - NEXT_PUBLIC_SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY

=== 2. end-to-end ===
cwd = /var/www/wt-env
.env.local present in cwd? false
  DATABASE_URL: PRESENT   … (all 7 PRESENT)
--- DATABASE_URL routes to host=127.0.0.1 port=5434 db=postgres user=gh_env_probe (password NOT printed) ---
--- app-layer query OK: reservations for tenant_id=00000000-0000-0000-0000-0000000000ff -> 0 ---
PROOF PASSED: out-of-tree env file drove a real tenant-scoped DB query with no in-tree .env.local
```

Fail-closed guards, all exit 1:

```
✗ env file not found: …/nope.env (fail-closed)
✗ env file …/loose.env has mode 640 — refusing (want 600 or 400)
✗ usage: with-guesthub-env.sh <command> [args...]
```

The staging DB is schema-only (0 reservation rows), so the tenant-scoped count
returns 0 — that still exercises connect + auth + schema privilege + query. The
throwaway `gh_env_probe` role was created on staging for this and can be dropped:
`DROP ROLE gh_env_probe;` (staging only — no production role was touched).

---

## 8. Left for Ronen to authorise

1. ~~Pick Option A or Option B~~ — **DECIDED: Option A** (§4). Option B is a target
   state only and is not scheduled; its `sudoers` NOPASSWD step is therefore moot.
2. Populate `/etc/guesthub/guesthub.env` from the vault — no agent may read those values.
   The template is at `/etc/guesthub/guesthub.env.template` (`600 root:root`,
   12 variables, all blank — verified value-free). Option A then requires
   `chown ubuntu:ubuntu` on the real file, per §5.
3. Run the **§5 (Option A)** cutover in a maintenance window. **Not done in this run
   — this run was staging-proof plus runbook only, by instruction.**
4. Accept the `deploy-production.sh` change (build must be wrapped, §5.4) — this
   file was **not** modified on this branch, because changing the canonical deploy
   path is not something to slip in unreviewed. This is not optional cosmetics: the
   four `NEXT_PUBLIC_*` values are inlined at BUILD time, so an unwrapped build after
   the cutover produces a green build whose browser bundle has `undefined` for
   Supabase and Maps.
5. `sudo install` the patched backup script to `/usr/local/sbin/` — the nightly job
   runs a **copy**, so merging this branch does not update it.
6. After soak, move (never delete) the three retired in-tree files.
7. Decide on secret rotation — treat the values inside the four existing tarballs as
   exposed at rest.
