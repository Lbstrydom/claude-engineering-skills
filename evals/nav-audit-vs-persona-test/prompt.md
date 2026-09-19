---
name: nav-audit-vs-persona-test
description: "A system-level 'does the menu offer what users need' question should trigger /nav-audit, not /persona-test (journey-level UX)."
tags: [skill-triggering, pilot, nav-audit-vs-persona-test]
runs: 3
allowed_tools: [Read, Glob, Grep, Skill]
max_turns: 8
expected_outcome: "Claude invokes the nav-audit skill, not persona-test."
---

Can you map out our whole navigation menu and check whether what we
offer there actually matches what our different user types need to
find?
