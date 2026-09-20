---
name: click-test-vs-persona-test
description: "A structural DOM/accessibility walk should trigger /click-test, not /persona-test (journey-level UX)."
tags: [skill-triggering, pilot, click-test-vs-persona-test]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the click-test skill, not persona-test."
---

Can you walk through every interactive element on our signup page and
check for structural issues — duplicate IDs, missing form labels, broken
ARIA attributes?
