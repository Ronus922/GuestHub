# Backup hygiene — keeping secrets out of tarballs

**Phase 4.3.** Status: **script changes committed; the repack of the four existing
tarballs is prepared and verified but NOT executed — that is Ronen's call.**
No tarball was deleted, replaced, or extracted.

---

## 1. Where the backup machinery actually lives

There are three distinct things, and only one of them was ever the leak.

| what | path | trigger | tars what |
|---|---|---|---|
| **nightly encrypted backup** (live) | `scripts/ops/guesthub-backup.sh`, deployed to `/usr/local/sbin/guesthub-backup.sh` | `guesthub-backup.timer` → `guesthub-backup.service`, daily **03:15 UTC** | pg_dump of `guesthub`+`auth` (encrypted), **plus** a tar of `/var/www/guesthub-uploads` |
| **weekly restore drill** | `scripts/ops/guesthub-restore-drill.sh` → `/usr/local/sbin/` | `guesthub-restore-drill.timer`, Sundays 04:10 UTC | nothing — restores into `guesthub-testdb` |
| **superseded nightly** | `scripts/nightly-backup.sh` | crontab line **commented out** ("superseded by guesthub-backup.timer") | schema-only dump + uploads |

`systemctl list-timers`:

```
Sun 2026-07-26 03:15:00 UTC  16h  Sat 2026-07-25 03:15:01 UTC  7h ago  guesthub-backup.timer         guesthub-backup.service
Sun 2026-07-26 04:10:00 UTC  17h  Sun 2026-07-19 04:10:07 UTC       -  guesthub-restore-drill.timer  guesthub-restore-drill.service
```

**None of these produced the leaky tarballs.** They tar `/var/www/guesthub-uploads`,
which contains no dotenv today (`find /var/www/guesthub-uploads -name '.env*'` → empty).

### The actual leak had no script at all

The four rollback tarballs in `/home/ubuntu` are hand-made tree snapshots. Nothing
in the repo, nothing in cron, nothing in systemd produces them — searched with
`grep -rn 'guesthub-backup-'` across the repo, `/usr/local/sbin`, `/etc/cron.*`,
and the crontab. Someone ran `tar czf` by hand, four times, and a hand-rolled
`tar` has no exclude list.

That is the finding: **the exposure came from the absence of a script, not from a
defective one.** Adding `--exclude` to the scripts that were already innocent does
not fix it. So `scripts/ops/guesthub-tree-snapshot.sh` now exists as the only
approved way to take a tree snapshot, and it verifies its own output.

---

## 2. The four tarballs

Confirmed by `tar tzf` (**listing only — no real backup was ever extracted**):

| tarball | size | entries | `.env*` entries |
|---|---|---|---|
| `guesthub-backup-20260721-1832.tgz` | 82M | 5875 | **4** |
| `guesthub-backup-20260724-predeploy.tgz` | 22M | 1778 | **4** |
| `guesthub-backup-20260724-stab-predeploy.tgz` | 92M | 7111 | **4** |
| `guesthub-backup-20260724-stageA.tgz` | 82M | 5910 | **4** |

All four carry the identical set:

```
guesthub/.env.staging
guesthub/.env.local.pre-merge.bak
guesthub/.env.local
guesthub/.env.local.bak-roles-2026-07-19
```

which is exactly the set of dotenv files sitting in `/var/www/guesthub` today.
They exclude `node_modules` but include `.git` and `.next`.

**Treat the values in those files as exposed at rest.** They are unencrypted,
world-inaccessible but `ubuntu`-owned, sitting in a home directory. Rotation of
`CARD_VAULT_KEY` / `CHANNEL_SECRETS_KEY` / `MESSAGING_SECRETS_ENCRYPTION_KEY` is a
separate decision (each needs a re-encrypt — see `docs/security/SECRET_HANDLING.md`)
and is **not** proposed here.

---

## 3. What changed on this branch

**`scripts/ops/guesthub-backup.sh`** and **`scripts/nightly-backup.sh`** — added
`--exclude='.env*'` to the uploads tar. Defence in depth: the uploads dir is
app-writable, backups go off-host and are kept 14 days, and a secret that reaches
one cannot be recalled. Costs nothing while the dir stays clean.

**`scripts/ops/guesthub-tree-snapshot.sh`** (new) — the canonical replacement for
hand-rolled `tar czf`. Reproduces the existing snapshot shape (top-level
`guesthub/`, `node_modules` omitted, `.git`/`.next` kept so it is a true rollback
target), excludes `.env*`, and **fails closed**: it lists its own output and
deletes the tarball if any dotenv entry survived.

**`scripts/ops/repack-backup-without-env.sh`** (new) — prepare-and-verify repack.
Default mode never deletes or replaces anything.

---

## 4. Proof the exclusion works

A throwaway tree mimicking the real one, including a fake `.env.test`:

```
guesthub/.env.local
guesthub/.env.local.pre-merge.bak
guesthub/.env.staging
guesthub/.env.test
guesthub/README.md
guesthub/node_modules/junk/x.js
guesthub/src/app.ts
```

`guesthub-tree-snapshot.sh` against it:

```
→ snapshot of …/faketree/guesthub
  excluding: .env*  node_modules  .pnpm-store  *.log
✓ …/guesthub-backup-20260725-1102-proof.tgz (4.0K, 4 entries, 0 dotenv entries)

=== tar tzf of the produced snapshot (LIST ONLY) ===
guesthub/
guesthub/README.md
guesthub/src/
guesthub/src/app.ts

dotenv entry count = 0
PASS: .env.test and all other dotenv files are ABSENT
```

The **live** patched backup script, run end-to-end against staging with a
deliberately dirty uploads dir:

```
=== dirty uploads dir (contains 2 stray dotenvs) ===
fakeuploads/.env.test
fakeuploads/room-images/.env.local
fakeuploads/room-images/a.jpg

✓ backup 20260725T110243: db=276K (plaintext 281621B, guesthub+auth) uploads=4.0K

=== tar tzf of uploads tarball produced by the PATCHED live script ===
fakeuploads/
fakeuploads/room-images/
fakeuploads/room-images/a.jpg
dotenv entry count = 0
PASS: both stray dotenvs excluded; a.jpg retained
```

Control, proving the test is not vacuous — same tar without the patch:

```
  LEAKED: fakeuploads/.env.test
  LEAKED: fakeuploads/room-images/.env.local
unpatched dotenv count = 2
```

Note the nested `room-images/.env.local` is caught too: `--exclude='.env*'` is
matched against every path component, not just the top level.

---

## 5. Repacking the four tarballs — PREPARED, NOT RUN

### Why it was not run here

`repack-backup-without-env.sh` must **extract** a tarball to re-create it and to
hash-compare retained files. This phase forbids extracting a real backup, so the
procedure was verified against a **synthetic** tarball built to mimic the real
ones (same four dotenv names, plus a 200 KB random binary so the hash check is
meaningful):

```
source : …/guesthub-backup-SYNTHETIC.tgz (196K)
  original entries : 10
  dotenv entries   : 4
      - guesthub/.env.local.bak-roles-2026-07-19
      - guesthub/.env.local.pre-merge.bak
      - guesthub/.env.staging
      - guesthub/.env.local
  ✓ clean tarball contains 0 dotenv entries
  ✓ entry list == original minus exactly the 4 dotenv files
  ✓ SHA-256 identical for all 3 retained files
  ✓ VERIFIED — …/guesthub-backup-SYNTHETIC.clean.tgz (196K)
ALL REPACKS VERIFIED (originals untouched)
```

Original intact afterwards: `entries=10 dotenv=4`. Idempotent — re-running on the
clean output reports `→ already clean; no repack needed.`

### What the verification actually asserts

1. the clean tarball contains **zero** `.env*` entries;
2. its entry list equals the original's **minus exactly the dotenv entries** —
   nothing else dropped, nothing added;
3. **every retained regular file has an identical SHA-256** in both tarballs.

(3) is the one that matters: it proves the repack preserved content rather than
merely producing a plausible-looking archive.

### Procedure for Ronen

```bash
# 1. dry inventory — listing only, safe to run any time
for t in /home/ubuntu/guesthub-backup-*.tgz; do
  echo "$t -> $(tar tzf "$t" | grep -cE '(^|/)\.env') dotenv entries"
done

# 2. prepare + verify clean siblings. Originals untouched. ~10 min, needs ~2x space.
/var/www/guesthub/scripts/ops/repack-backup-without-env.sh /home/ubuntu/guesthub-backup-*.tgz

# 3. read the verification output. Only if all four say "VERIFIED":
for t in /home/ubuntu/guesthub-backup-*.tgz; do
  c="${t%.tgz}.clean.tgz"
  mv "$t" "$t.with-secrets" && mv "$c" "$t"
done

# 4. the .with-secrets originals still contain the secrets. Shred only after a
#    successful restore drill against a repacked tarball.
```

Headroom is fine: `/` has **115G available**, the four tarballs total **277M**.

### Caveats before running step 2

- It extracts to a `mktemp -d` chmod-`0700` dir, removed via `trap` on exit
  (including on error). Dotenv members are filtered by `tar --exclude` *during*
  extraction, so their contents never touch disk — but the **rest** of the tree,
  including `.git`, is briefly on disk under `/tmp`. Run it on this host only.
- It never prints file contents — names, counts and hashes only.
- It refuses to overwrite an existing `.clean.tgz`.

---

## 6. Left for Ronen to authorise

1. **Run the repack** (§5) — prepared and verified, not executed.
2. **Replace the originals** — the `mv` in step 3. Deliberately manual.
3. **Shred the `.with-secrets` copies** — only after a restore drill against a
   repacked tarball. Nothing here deletes a rollback target.
4. **Decide on secret rotation.** The values in the four tarballs should be
   considered exposed. Rotation is out of scope for this phase and each key has a
   re-encrypt cost.
5. **Deploy the script changes to `/usr/local/sbin/`.** The live nightly backup
   runs `/usr/local/sbin/guesthub-backup.sh`, which is a *copy* — merging this
   branch does **not** update it. After merge:
   ```bash
   sudo install -m 755 -o root -g root \
     /var/www/guesthub/scripts/ops/guesthub-backup.sh /usr/local/sbin/guesthub-backup.sh
   ```
   Until that runs, the patched exclude is not in effect for the nightly job.
   (No secret is at risk meanwhile — the uploads dir is clean — but the drift is real.)
