---
name: skills
description: |
  Poison-pill fixture for `npm run worktree:preflight:gate`.

  This is a structurally valid SKILL.md that DOES document a command into the
  synced tooling tree — the `node scripts/…` line below is what puts it in the
  gate's subject set — but carries no worktree-preflight marker block.

  That combination is the silent variant the gate exists to catch: an agent
  working in a linked git worktree follows the command, the tree is absent
  because it is gitignored, and the only feedback is a bare MODULE_NOT_FOUND
  with no remedy. Nothing else about the file is wrong, so no other check fires.

  Keeping the tooling command here is load-bearing: strip it and the skill drops
  OUT of the subject set, the gate passes, and the pill would prove nothing while
  looking like it worked.
disable-model-invocation: true
---

# Skill Quick Reference

A discoverable, always-current reference for every skill in this bundle.

## Usage

```bash
node scripts/skills-help.mjs --format table
```

Renders the compact table. Pass a skill name for the long form.
