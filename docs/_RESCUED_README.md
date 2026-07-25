# תוצרים שחולצו מ-worktrees זמניים — 2026-07-25

הקבצים כאן הועתקו **בייט-בייט** מ-worktrees זמניים שבהם הם היו untracked ולכן
היו נמחקים עם `git worktree remove`. המקורות **לא נערכו ולא נמחקו** — הם עבודה
זרה של פאזות מקבילות (2/5/6).

| קובץ | מקור | md5 |
|---|---|---|
| `DIAG_MOTI_CANCELLATION.md` | `/var/www/wt-stab` (untracked, mtime 11:02) | `a047026a5e8890591322300ed7fbf638` |
| `STABILIZATION_REPORT.md` | `/var/www/wt-stab` (untracked, mtime 14:25) | `341af4990c60df248cad3299e5e8a220` |
| `_rescued-sim3-110-resolution.patch` | `/var/www/wt-triage-sim3` (uncommitted merge-simulation של #110) | — |

`DIAG_MOTI_CANCELLATION.md` נסגר ע"י `docs/DIAG_MOTI_CANCELLATION_CLOSURE.md`
שעל הענף `fix/room-1318-beds24-mapping`. איחוד שני המסמכים באחריות רונן.

מסמכים שכבר בטוחים על ענפים ולכן **לא** חולצו: `PR_TRIAGE.md` (`stab/pr-triage`),
`GUARD_INTEGRITY.md` (`stab/guard-integrity-sweep`), `STAB_ADVERSARIAL.md`
(`stab/adversarial`) — שלושתם tracked ודחופים ל-origin.
