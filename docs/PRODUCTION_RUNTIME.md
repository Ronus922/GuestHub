# GuestHub — Production Runtime Isolation

Permanent separation of the production runtime from feature work.

## Directories

| Path | Role | Branch |
|------|------|--------|
| `/var/www/guesthub-production` | **Production runtime** — the only cwd PM2 `guesthub` runs from. Owns the live `.next`. | `main` only, tracks `origin/main` |
| `/var/www/guesthub` | Development hub repo (hosts worktrees). Not a runtime. | `main` |
| `/var/www/guesthub-worktrees/<name>` | Feature worktrees. Build here freely. | feature branches |

Production and feature checkouts never share `.next`, cwd, PM2 process, port, or build output.

## PM2

`guesthub` runs `npm start` (Next.js) with `PORT=3007`, `cwd=/var/www/guesthub-production`.
Nginx `guesthub.bios.co.il` → `localhost:3007`. Do not touch the unrelated `pms` / `sys-app` PM2 apps.

Pin/repoint (only if the process is lost):
```bash
pm2 delete guesthub
cd /var/www/guesthub-production && PORT=3007 pm2 start npm --name guesthub -- start
pm2 save
```

## Fail-closed build & deploy

- `/var/www/guesthub-production/.production-runtime` marks the prod checkout (gitignored; created once, never committed).
- `npm run build` there is **refused** by `scripts/prebuild-guard.mjs` unless `PROD_DEPLOY_OK=1` — a stray build cannot corrupt the live `.next`. Feature worktrees have no marker, so their builds are always allowed.
- The **only** approved deploy:
  ```bash
  PROD_DEPLOY_OK=1 npm run deploy:prod    # scripts/deploy-production.sh
  ```
  It: fetches origin → asserts `main`, clean tree, HEAD reachable from & equal to `origin/main`, no unapproved migrations (`scripts/production-deploy-guard.mjs`) → fast-forwards `main` only → builds → restarts **only** `guesthub` → verifies port 3007, PM2 cwd, deployed commit/build id, and critical routes. Any failure aborts before restart.

It never deploys a feature branch, a dirty tree, or a commit not reachable from `origin/main`.

## Migrations

Apply `db/migrations/*.sql` to the production Postgres via the project procedure (`supabase-db` container). Never run `db:seed` against production (seed is fail-closed via `scripts/seed.mjs`).
