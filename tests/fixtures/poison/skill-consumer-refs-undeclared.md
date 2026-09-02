---
name: explain
description: |
  Poison-pill fixture for scripts/check-skill-consumer-refs.mjs. Structurally an
  ordinary SKILL.md; the only thing wrong with it is one pointer.
  Triggers on: "poison pill fixture".
---

# Poison fixture — an undeclared consumer-unreachable pointer

Everything here reads as normal skill prose. The defect is that the command
below names an npm alias, and the sync never merges npm scripts into a
consumer's `package.json` — so in the repo where this skill is actually read,
the command does not exist:

```bash
npm run explain:history:report
```

That is the whole shape of the defect class: individually plausible, wrong only
in the repo the reader is standing in.
