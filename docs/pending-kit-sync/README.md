# Pending kit-sync change — SIDE-PANEL skill (D85 + D86)

**Status: UNRESOLVED deployment blocker.** The canonical DevOPS-kit source is
NOT writable from this server, so the SIDE-PANEL skill update exists only in
the local copies and **will be wiped by the next `kit-update` rsync** unless
the patch below is applied on the central server first.

`SIDE-PANEL.md.patch` is cumulative (D85 + D86) and is verified to apply
cleanly to the pristine central file (`patch --dry-run`, 2026-07-11).

## What changed
**D85** — the `/side-panel` skill gained the proven Edit Booking SidePanel V2
conventions (V2 spec table values + a "קונבנציות מוכחות — פאנל עורך V2"
section: structure, unsaved-change handling, visual-refactor-without-breaking-
logic rules, HTML/PNG fidelity validation, D47 focus-effect note).

**D86** — added the "סקשן אחד לכל ישות — view model אחד" section: the rule that
one entity (credit card, address, guest) gets exactly ONE section and ONE
canonical field set fed by a pure `resolveXView()` with explicit precedence —
never a read-only summary card stacked on top of an empty-looking form. Covers
read-only-≠-different-presentation, mask/reveal in place, honest source
labelling, subordinate metadata, the distinct container class for non-entity
metadata, and the assertion that keeps it from regressing.

## Where it lives now (temporary, kit-sync will overwrite)
- Live skill: `/home/ubuntu/.claude/skills/fullstack-il/SIDE-PANEL.md`
  (symlink target of `~/.claude/skills/side-panel/SKILL.md`)
- Kit mirror: `/home/ubuntu/DevOPS/skills/SIDE-PANEL.md`

## Canonical source (apply here)
- Server: `ai2u-vs1.tail17ca66.ts.net` (central kit server; this VPS has no
  SSH key for it — `ubuntu@` and `lior@` both refuse publickey)
- Target file: `lior@ai2u-vs1:~/DevOPS/skills/SIDE-PANEL.md`
  (per `kit-update`: `CENTRAL_SERVER="lior@ai2u-vs1.tail17ca66.ts.net"`,
  `CENTRAL_PATH="~/DevOPS"`)

## How to apply (from a machine with access to ai2u-vs1)
```bash
scp docs/pending-kit-sync/SIDE-PANEL.md.patch lior@ai2u-vs1.tail17ca66.ts.net:/tmp/
ssh lior@ai2u-vs1.tail17ca66.ts.net \
  "patch ~/DevOPS/skills/SIDE-PANEL.md < /tmp/SIDE-PANEL.md.patch"
# then let the normal kit sync distribute it (or run kit-update on the fleet)
```

## Consistency check after sync
```bash
diff ~/.claude/skills/fullstack-il/SIDE-PANEL.md ~/DevOPS/skills/SIDE-PANEL.md && echo IN-SYNC
```
Once applied centrally and re-synced, delete this directory.
