---
name: visual-audit-vs-persona-test
description: "A styling/theme-consistency check should trigger /visual-audit (computed styles), not /persona-test (journey-level UX)."
tags: [skill-triggering, pilot, visual-audit-vs-persona-test]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the visual-audit skill, not persona-test."
---

Can you check whether our button styles and focus rings stay consistent
between light mode and dark mode?
