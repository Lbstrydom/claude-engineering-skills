---
name: audit
description: |
  Audit the implementation of a plan against its specification and engineering principles.
  Use when the user wants to verify that code written for a plan meets all requirements,
  follows principles, and is properly wired. Requires a plan file path as argument.
  Triggers on: "audit the plan", "check the implementation", "verify the plan",
  "review against the plan", "audit docs/plans/".
  Usage: /audit docs/plans/my-feature.md
  The plan file must exist in the repository and should have been created by /plan-backend
  or /plan-frontend (or manually in the same format).
  disable-model-invocation: true
---

# Poison pill: a known frontmatter key indented under a block scalar

The frontmatter above is byte-for-byte the head of a real consumer file
(wine-cellar-app `.claude/skills/audit/SKILL.md`, installed 2026-03-06,
measured inert 2026-09-03). Line 12 reads `  disable-model-invocation: true`
two spaces deep, inside `description: |`, so YAML parses it as the last line
of the description and the skill stays model-invocable while declaring it must
not be. The broken and fixed forms differ only by leading whitespace, which is
why this pill exists: a gate for a whitespace defect passes vacuously if the
probe is wrong, and this probe is the real defect, not a hand-written one.

Overlaid onto `skills/ship/SKILL.md` by `scripts/gate-contracts/skills-check.json`;
`check-skill-frontmatter.mjs` must exit 1 naming line 12.
